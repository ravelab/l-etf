#!/usr/bin/env python3
"""Build a rules-based large-cap S&P 500 analogue from Ken French's data.

Source: Ken French's Data Library, "Portfolios Formed on ME" (daily), the
value-weighted large-cap columns. Every CRSP firm above an NYSE market-equity
percentile breakpoint, cap-weighted, total return (dividends included). Free,
purely rules-based, and available from 1926-07-01 - so it carries none of the
S&P 500's pre-1988 committee/industry-quota composition quirks.

    python3 scripts/build-ff-index.py                 # Hi 30 -> data/index-ffhi30.csv
    python3 scripts/build-ff-index.py --cut "Hi 20"   # -> data/index-ffhi20.csv

`Hi 30` is the default because it is the closest structural match to the
S&P 500: ~403 firms holding 80.7% of US market cap over 1957-88 (and ~533 /
84.0% since 1989), against the S&P's 500 names and ~80% of cap. `Hi 20` is
materially narrower (~263 firms, 72.5% of cap) - a top-250 index in character.

Requires pandas + numpy. Ken French republishes roughly monthly, so the series
ends a few weeks behind today.

This file is NOT produced by `npm run fetch-data`. It is, however, the input
that `fetch-data` splices into index-sp.csv for 1926-07-01..1988-04-05 (see
src/lib/data/ff-large-cap-splice.ts), so regenerate it before a full rebuild.
"""
from __future__ import annotations

import argparse
import io
import urllib.request
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd

FF_URL = (
    "https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp/"
    "Portfolios_Formed_on_ME_daily_CSV.zip"
)
REPO = Path(__file__).resolve().parent.parent
SP_CSV = REPO / "data" / "index-sp.csv"

# First S&P row kept as-is by the splice: 1988-04-06 is the date S&P dropped its
# fixed industry-sector quotas. Anchoring the level here (rather than one
# session earlier) keeps this file independent of the splice it feeds, so
# rebuilding after a splice reproduces identical values.
ANCHOR = pd.Timestamp("1988-04-06")

CUTS = {"Hi 30": "ffhi30", "Hi 20": "ffhi20", "Hi 10": "ffhi10"}
MISSING_CODES = [-99.99, -999]


def fetch_cut(cut: str) -> pd.Series:
    """Daily value-weighted total returns for one large-cap size portfolio."""
    with urllib.request.urlopen(FF_URL) as resp:
        payload = resp.read()
    with zipfile.ZipFile(io.BytesIO(payload)) as zf:
        name = next(n for n in zf.namelist() if n.lower().endswith(".csv"))
        text = zf.read(name).decode("latin-1")

    lines = text.splitlines()
    # The file holds two blocks; the first is "Average Value Weighted Returns".
    header = next(i for i, line in enumerate(lines) if line.startswith(",<= 0,Lo 30"))
    end = header + 1
    while end < len(lines) and lines[end].strip():
        end += 1

    columns = [c.strip() for c in lines[header].split(",")]
    columns[0] = "date"
    frame = pd.DataFrame([l.split(",") for l in lines[header + 1 : end]], columns=columns)
    frame["date"] = pd.to_datetime(frame["date"].str.strip(), format="%Y%m%d")

    returns = pd.to_numeric(frame.set_index("date")[cut].str.strip()) / 100
    returns = returns.replace([c / 100 for c in MISSING_CODES], np.nan)
    if returns.isna().any():
        raise ValueError(f"missing {cut} returns on {list(returns[returns.isna()].index)[:5]}")
    if not (returns.index.is_monotonic_increasing and returns.index.is_unique):
        raise ValueError("Fama-French dates are not unique/sorted")
    return returns


def fold_saturdays(returns: pd.Series) -> tuple[pd.Series, int]:
    """Compound pre-1952 Saturday sessions into the next trading day.

    The NYSE traded Saturdays until 1952-05-31. Every CSV in data/ is Mon-Fri,
    so folding Saturday into the following session keeps the cumulative return
    exact while making the calendar line up with index-sp.csv date for date.
    """
    folded: dict[pd.Timestamp, float] = {}
    carry = 1.0
    for date, growth in (1 + returns).items():
        if date.dayofweek == 5:
            carry *= growth
            continue
        folded[date] = carry * growth
        carry = 1.0
    if carry != 1.0:
        raise ValueError("series ends on a Saturday with no following session")

    out = pd.Series(folded).sort_index()
    np.testing.assert_allclose((1 + returns).prod(), out.prod(), rtol=1e-12)
    return out, int((returns.index.dayofweek == 5).sum())


def format_price(value: float) -> str:
    return f"{float(f'{value:.6g}'):.10f}".rstrip("0").rstrip(".")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cut", default="Hi 30", choices=sorted(CUTS),
                        help="Fama-French size cut to build (default: Hi 30)")
    args = parser.parse_args()
    cut = args.cut
    out_csv = REPO / "data" / f"index-{CUTS[cut]}.csv"
    name = f"FF-{cut.replace(' ', '').upper()}-TR"
    source = "famafrench-vw(adj_close)+sp500-divyield(close)"

    returns, saturdays = fold_saturdays(fetch_cut(cut))

    sp = pd.read_csv(SP_CSV, parse_dates=["date"]).set_index("date")
    sp_adj = pd.to_numeric(sp["adj_close"])
    sp_close = pd.to_numeric(sp["close"])

    unmatched = returns.index.difference(sp.index)
    if len(unmatched):
        raise ValueError(f"dates absent from index-sp.csv: {[str(d.date()) for d in unmatched[:5]]}")

    # Total return, rebased so the level equals index-sp.csv's adj_close at ANCHOR.
    cumulative = returns.cumprod()
    adj_close = cumulative * (sp_adj.loc[ANCHOR] / cumulative.loc[ANCHOR])

    # Price-only column: strip the S&P's own cumulative dividend contribution, so
    # SMA signals run on a price index rather than a total-return one. The splice
    # preserves this close/adj_close ratio, so this stays stable across rebuilds.
    close = adj_close * (sp_close.reindex(adj_close.index) / sp_adj.reindex(adj_close.index))
    if not np.isfinite(close).all() or (close <= 0).any():
        raise ValueError("derived close column has non-finite/non-positive values")

    rows = ["date,adj_close,open,close,name,source"]
    rows.extend(
        f"{date.date()},{format_price(adj_close[date])},,{format_price(close[date])},{name},{source}"
        for date in adj_close.index
    )
    out_csv.write_text("\n".join(rows) + "\n")

    span = (adj_close.index[-1] - adj_close.index[0]).days / 365.25
    cagr = (adj_close.iloc[-1] / adj_close.iloc[0]) ** (1 / span) - 1
    print(f"wrote {out_csv.relative_to(REPO)}: {len(adj_close)} rows, "
          f"{adj_close.index[0].date()} -> {adj_close.index[-1].date()} [{cut}]")
    print(f"folded {saturdays} Saturday sessions; anchored to index-sp.csv at {ANCHOR.date()}")
    print(f"total return {cagr:.2%}/yr over {span:.1f} years")


if __name__ == "__main__":
    main()
