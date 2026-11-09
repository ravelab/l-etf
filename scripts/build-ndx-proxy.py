#!/usr/bin/env python3
"""Build the NDX proxy: Ken French's Business Equipment industry, 1926 -> 1985.

Source: Ken French's Data Library, "12 Industry Portfolios" (daily), value-weighted
`BusEq` column - computers, software, semiconductors and electronic equipment
(SIC 3570-3579, 3660-3692, 3694-3699, 3810-3829, 7370-7379), total return.

Why this and not the Nasdaq Composite the 1971-1985 history used to splice in:
measured against real NDX it has NDX's volatility (19.0% vs 19.7% in 1985-94,
26.4% vs 27.3% since 1995) and trend (20/60-day variance ratios 1.24/1.23 vs
1.28/1.37), and a beta of 0.86-0.94 against the Composite's 0.66-0.87. The
1970s Composite is smoothed by stale OTC quotes (lag-1 autocorrelation 0.31,
variance ratio 2.4-3.0, 12.3% vol), which flatters both 3x decay and trend
rules. It also reaches back to 1926, where the Composite starts in 1971.

    python3 scripts/build-ndx-proxy.py              # -> data/index-ffbuseq.csv

`close` is a price index: BusEq's own dividends come from the library's monthly
files, as (1 + total) / (1 + ex-dividend) - 1 per month, spread evenly over that
month's sessions. Both terms come from the MONTHLY files because the daily file,
compounded, does not reproduce them exactly (they are built separately), and
mixing the two put the ex-dividend return above the total in some months.

Levels are anchored to index-nq.csv at ANCHOR, the first real-NDX session, which
the splice in fetch-data never rewrites, so rebuilding reproduces identical
values. Requires pandas + numpy.

This file is NOT produced by `npm run fetch-data`. fetch-data splices it into
index-nq.csv for 1926-07-01..1985-01-30 (src/lib/data/ndx-proxy-splice.ts).
"""
from __future__ import annotations

import io
import urllib.request
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd

FF_BASE = "https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp/"
DAILY_URL = FF_BASE + "12_Industry_Portfolios_daily_CSV.zip"
TOTAL_MONTHLY_URL = FF_BASE + "12_Industry_Portfolios_CSV.zip"
EX_DIV_MONTHLY_URL = FF_BASE + "12_Industry_Portfolios_Wout_Div_CSV.zip"
COLUMN = "BusEq"
REPO = Path(__file__).resolve().parent.parent
NQ_CSV = REPO / "data" / "index-nq.csv"
OUT_CSV = REPO / "data" / "index-ffbuseq.csv"
ANCHOR = pd.Timestamp("1985-01-31")
NAME = "FF-BUSEQ-TR"
SOURCE = "famafrench-vw-buseq(adj_close)+famafrench-exdiv(close)"
MISSING_CODES = [-99.99, -999]


def read_block(url: str, title: str) -> pd.Series:
    """One column of the first "<title>" block of a Ken French CSV, as decimals."""
    with urllib.request.urlopen(url) as resp:
        payload = resp.read()
    with zipfile.ZipFile(io.BytesIO(payload)) as zf:
        name = next(n for n in zf.namelist() if n.lower().endswith(".csv"))
        text = zf.read(name).decode("latin-1")

    lines = text.splitlines()
    start = next(i for i, line in enumerate(lines) if line.strip() == title)
    header = start + 1
    end = header + 1
    while end < len(lines) and lines[end].strip():
        end += 1

    columns = [c.strip() for c in lines[header].split(",")]
    columns[0] = "date"
    frame = pd.DataFrame([l.split(",") for l in lines[header + 1 : end]], columns=columns)
    frame["date"] = frame["date"].str.strip()
    values = pd.to_numeric(frame.set_index("date")[COLUMN].str.strip()) / 100
    values = values.replace([c / 100 for c in MISSING_CODES], np.nan)
    if values.isna().any():
        raise ValueError(f"missing {COLUMN} values in '{title}' at {list(values[values.isna()].index)[:5]}")
    return values


def fold_saturdays(returns: pd.Series) -> tuple[pd.Series, int]:
    """Compound pre-1952 Saturday sessions into the next trading day (as build-ff-index.py)."""
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
    daily = read_block(DAILY_URL, "Average Value Weighted Returns -- Daily")
    daily.index = pd.to_datetime(daily.index, format="%Y%m%d")
    if not (daily.index.is_monotonic_increasing and daily.index.is_unique):
        raise ValueError("Fama-French daily dates are not unique/sorted")
    growth, saturdays = fold_saturdays(daily[daily.index <= ANCHOR])
    if growth.index[-1] != ANCHOR:
        raise ValueError(f"Fama-French daily data has no {ANCHOR.date()} session")

    title = "Average Value Weighted Returns -- Monthly"
    total_m = read_block(TOTAL_MONTHLY_URL, title)
    ex_div_m = read_block(EX_DIV_MONTHLY_URL, title)
    total_m.index = pd.PeriodIndex(total_m.index, freq="M")
    ex_div_m.index = pd.PeriodIndex(ex_div_m.index, freq="M")

    # Spread each month's dividend return evenly over its sessions.
    months = growth.index.to_period("M")
    session_months = pd.Index(months.unique())
    missing = session_months.difference(total_m.index.intersection(ex_div_m.index))
    if len(missing):
        raise ValueError(f"no monthly total/ex-dividend return for {[str(m) for m in missing[:5]]}")
    dividend_factor = (1 + total_m.reindex(session_months)) / (1 + ex_div_m.reindex(session_months))
    if (dividend_factor < 1 - 1e-9).any():
        bad = dividend_factor[dividend_factor < 1 - 1e-9]
        raise ValueError(f"ex-dividend return exceeds total return in {[str(m) for m in bad.index[:5]]}")
    sessions = growth.groupby(months).size()
    per_day = (dividend_factor ** (1 / sessions)).reindex(months).to_numpy()
    price_growth = growth / per_day

    nq = pd.read_csv(NQ_CSV, parse_dates=["date"]).set_index("date")
    anchor_adj = float(nq.loc[ANCHOR, "adj_close"])
    anchor_close = float(nq.loc[ANCHOR, "close"])

    adj_close = growth.cumprod()
    adj_close *= anchor_adj / adj_close.loc[ANCHOR]
    close = price_growth.cumprod()
    close *= anchor_close / close.loc[ANCHOR]
    if not (np.isfinite(adj_close).all() and np.isfinite(close).all() and (close > 0).all()):
        raise ValueError("derived levels have non-finite/non-positive values")

    rows = ["date,adj_close,open,close,name,source"]
    rows.extend(
        f"{date.date()},{format_price(adj_close[date])},,{format_price(close[date])},{NAME},{SOURCE}"
        for date in adj_close.index
    )
    OUT_CSV.write_text("\n".join(rows) + "\n")

    span = (adj_close.index[-1] - adj_close.index[0]).days / 365.25
    total_cagr = (adj_close.iloc[-1] / adj_close.iloc[0]) ** (1 / span) - 1
    price_cagr = (close.iloc[-1] / close.iloc[0]) ** (1 / span) - 1
    print(f"wrote {OUT_CSV.relative_to(REPO)}: {len(adj_close)} rows, "
          f"{adj_close.index[0].date()} -> {adj_close.index[-1].date()}")
    print(f"folded {saturdays} Saturday sessions; anchored to index-nq.csv at {ANCHOR.date()}")
    print(f"total return {total_cagr:.2%}/yr, price {price_cagr:.2%}/yr over {span:.1f} years "
          f"(dividends {float(dividend_factor.prod()) ** (1 / span) - 1:.2%}/yr)")


if __name__ == "__main__":
    main()
