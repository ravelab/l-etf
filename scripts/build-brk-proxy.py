#!/usr/bin/env python3
"""Build the equity leg of the BRK.B proxy: Fama-French large value, 1926 -> 1980.

Source: Ken French's Data Library, "6 Portfolios Formed on Size and
Book-to-Market (2 x 3)" (daily), value-weighted `BIG HiBM` column - big firms in
the top 30% of book-to-market, total return.

risk-brka.csv holds real BRK-A from 1980-03-17. Before that, fetch-data builds a
daily-rebalanced 70% equity / 30% VGSH blend (src/lib/data/brk-proxy.ts); this
file is its equity leg from 1926-07-01, and the S&P series stands in before.
Against real BRK-A over 1980-2026 the 70/30 large-value blend matches Berkshire's
market beta (0.70 vs 0.71) and worst drawdown (-51.3% vs -51.5%), and trends like
it (20/60-day variance ratios 0.86/0.83 vs 0.90/0.89), where the old 50% S&P /
50% VGSH blend had beta 0.49, 8.8% volatility against BRK's 22.4%, and variance
ratios of 0.79/0.73. No portfolio reproduces a single stock's own volatility, so
the blend's 14.4% stays below BRK's 22.4%; that gap is company-specific noise.

    python3 scripts/build-brk-proxy.py          # -> data/index-fflargevalue.csv
    npm run fetch-data -- --brk-proxy           # re-applies it to risk-brka.csv

Only returns are used downstream, so the level simply starts at 1. Requires
pandas + numpy.
"""
from __future__ import annotations

import io
import urllib.request
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd

FF_URL = "https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp/6_Portfolios_2x3_daily_CSV.zip"
COLUMN = "BIG HiBM"
TITLE = "Average Value Weighted Returns -- Daily"
REPO = Path(__file__).resolve().parent.parent
OUT_CSV = REPO / "data" / "index-fflargevalue.csv"
END = pd.Timestamp("1980-03-17")  # first real BRK-A session in risk-brka.csv
NAME = "FF-LARGE-VALUE-TR"
SOURCE = "famafrench-vw-big-hibm(adj_close)"
MISSING_CODES = [-99.99, -999]


def fetch_returns() -> pd.Series:
    with urllib.request.urlopen(FF_URL) as resp:
        payload = resp.read()
    with zipfile.ZipFile(io.BytesIO(payload)) as zf:
        name = next(n for n in zf.namelist() if n.lower().endswith(".csv"))
        text = zf.read(name).decode("latin-1")
    lines = text.splitlines()
    start = next(i for i, line in enumerate(lines) if line.strip() == TITLE)
    header = start + 1
    end = header + 1
    while end < len(lines) and lines[end].strip():
        end += 1
    columns = [c.strip() for c in lines[header].split(",")]
    columns[0] = "date"
    frame = pd.DataFrame([l.split(",") for l in lines[header + 1 : end]], columns=columns)
    frame["date"] = pd.to_datetime(frame["date"].str.strip(), format="%Y%m%d")
    returns = pd.to_numeric(frame.set_index("date")[COLUMN].str.strip()) / 100
    returns = returns.replace([c / 100 for c in MISSING_CODES], np.nan)
    if returns.isna().any():
        raise ValueError(f"missing {COLUMN} returns on {list(returns[returns.isna()].index)[:5]}")
    if not (returns.index.is_monotonic_increasing and returns.index.is_unique):
        raise ValueError("Fama-French dates are not unique/sorted")
    return returns


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
    growth, saturdays = fold_saturdays(fetch_returns())
    growth = growth[growth.index <= END]
    if growth.index[-1] != END:
        raise ValueError(f"Fama-French data has no {END.date()} session")
    # The first session's own return is not part of the level path.
    levels = growth.cumprod() / growth.iloc[0]

    rows = ["date,adj_close,name,source"]
    rows.extend(f"{date.date()},{format_price(levels[date])},{NAME},{SOURCE}" for date in levels.index)
    OUT_CSV.write_text("\n".join(rows) + "\n")

    span = (levels.index[-1] - levels.index[0]).days / 365.25
    cagr = levels.iloc[-1] ** (1 / span) - 1
    print(f"wrote {OUT_CSV.relative_to(REPO)}: {len(levels)} rows, {levels.index[0].date()} -> {levels.index[-1].date()}")
    print(f"folded {saturdays} Saturday sessions; total return {cagr:.2%}/yr over {span:.1f} years")


if __name__ == "__main__":
    main()
