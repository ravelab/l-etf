# Data Fetch Notes

This document explains what `npm run fetch-data` does in the current codebase.
If this file ever disagrees with [`scripts/fetch-data.ts`](scripts/fetch-data.ts),
the code is the source of truth.

## What `fetch-data` Updates

`fetch-data` keeps the generated CSVs in `data/` current for local use and
production builds.

It covers:

- benchmark index history
- leveraged ETF price history
- risk-off asset history and proxies
- inflation
- borrow-rate history for simulations

Main upstream sources:

- Tiingo for modern ETF prices and some proxy anchors
- Yahoo Finance for benchmark index open/close data
- Stooq API only for S&P 500 open/close rows before Yahoo `^GSPC` starts
- FRED for CPIAUCSL, SOFR, DGS2, and TB3MS
- GitHub seed CSV data for long-history rates, inflation, and returns
- Datahub monthly gold history for the GLDM proxy
- Tiingo `VOO` / `QQQ` adjusted close for modern index total-return anchors

Yahoo benchmark downloads are fetched live. Repeated Yahoo requests within one
`fetch-data` process reuse in-memory rows, but no checked-in cache directory is
required. If a live fetch or full rebuild cannot complete, the existing
`data/*.csv` file is left in place.

## How Incremental Updates Work

For existing CSVs, the script uses the file itself as the baseline:

- it reads the header and last stored row
- if the file is already current through today in `America/New_York`, it skips
- otherwise it fetches from the last stored date forward
- if the overlap row matches, it appends only newer rows
- if the overlap row does not match, it rebuilds or rebases depending on file type

Recent index rows should not be written with blank adjusted closes. If Yahoo has
a newer raw open/close than Tiingo has adjusted close, the script writes a
provisional adjusted close by scaling the prior adjusted close by the Yahoo raw
close return. A later Tiingo-backed run replaces that provisional row.

Incremental index refreshes join Tiingo adjusted closes to Yahoo raw bars by
date. A missing Yahoo date inside the overlap window does not abort the refresh:
the Tiingo adjusted close is retained, any raw open/close already stored for
that date is preserved, and later matched dates can still be appended.

A *new* date is never appended without a close. The close drives the SMA signals
and the fill prices, and the engine throws on any date whose close is not finite
("Missing close price for sp500 on <date>"), which white-screens every tool page
until the next build. Tiingo publishes the adjusted close hours before Yahoo has
the raw bar, so a build landing in that window would otherwise write a close-less
trailing row — that took production down on 2026-08-29. Waiting costs nothing:
the date arrives whole on the next run. Already-stored dates are unaffected, so
Tiingo's later adjusted-close revisions still land on them.

## CSV Families

### Index files

- `index-sp.csv`
- `index-nq.csv`

These are the most layered outputs.

`index-ffhi30.csv` also lives in `data/` but is **not** produced by
`fetch-data`; see "Out-of-band index files" below. It *is* an input to
`index-sp.csv`, so regenerate it before a full S&P rebuild.

#### `index-sp.csv`

Builds the S&P 500 benchmark series, in three eras.

Sources:

- Yahoo `^GSPC` daily open/close from Yahoo’s first available date onward
- Stooq `^spx` API open/close before Yahoo `^GSPC` starts
- GitHub total-return seed data
- Tiingo `VOO`
- `data/index-ffhi30.csv` for the 1926-07-01..1988-04-05 segment
- existing `data/index-sp.csv` fallback if a live rebuild cannot complete

Eras:

| Range | Series |
| --- | --- |
| `1885-03-20`..`1926-06-30` | Cowles-era S&P Composite reconstruction, rescaled onto the Fama-French level |
| `1926-07-01`..`1988-04-05` | Fama-French value-weighted large-cap (`Hi 30`) total return |
| `1988-04-06`..present | actual S&P 500 / `VOO` |

**Why the middle era is not the S&P.** Before `1988-04-06` the S&P 500 was
assembled under fixed industry-sector quotas (425 industrials / 25 rails /
25 utilities / 50 financials), and before `1957-03` it was not a 500-stock index
at all — it is backfilled from the 90-stock Composite, which compounds ~0.65%/yr
*faster than the entire CRSP universe* over 1926-57, a data-quality signal rather
than a real return. The Fama-French `Hi 30` cut is a purely rules-based
cap-weighted alternative and a close structural match to the S&P 500: ~403 firms
holding 80.7% of US market cap over 1957-88, against the S&P's 500 names and
~80% of cap. Over 1957-88 its volatility matches the S&P's to within 0.13pp.

What it contains:

- `close`: SPX index level used for SMA signals. In the Fama-French era this is
  the spliced total return with the S&P's own cumulative dividend contribution
  stripped back out, so signals still run on a price index. Before `1926-07-01`
  it is the Cowles-era level rescaled by one constant.
- `open`: SPX index open used for open-execution logic. In the spliced eras each
  row's open is scaled by the same factor as its `close`, preserving the day's
  open-to-close gap.
- `adj_close`: stitched total-return series used for simulation

Splice mechanics live in `src/lib/data/ff-large-cap-splice.ts` (pure, unit-tested
in `unit-tests/ff-large-cap-splice.test.ts`). Only Fama-French *returns* are
used; levels are re-anchored to the untouched `1988-04-06` S&P row, so the modern
series stays the source of truth and both seams are exactly continuous. The
splice holds `close / adj_close` invariant, which makes it idempotent — running
it twice is a no-op, and `index-ffhi30.csv` can be regenerated afterward without
drift.

#### `index-nq.csv`

Builds the Nasdaq 100 benchmark series.

Sources:

- Yahoo `^IXIC` daily open/close for the Nasdaq Composite era
- Yahoo `^NDX` daily open/close for the Nasdaq 100 era
- Nasdaq Composite and Nasdaq 100 dividend-yield tables in `scripts/fetch-data.ts`
- Tiingo `QQQ`
- existing `data/index-nq.csv` fallback if a live rebuild cannot complete

What it contains:

- `close`: Nasdaq benchmark close used for SMA signals. Before the NDX boundary,
  this is Yahoo `^IXIC` scaled onto the NDX price level.
- `open`: Nasdaq benchmark open used for open-execution logic. Before the NDX
  boundary, this is Yahoo `^IXIC` scaled onto the NDX price level.
- `adj_close`: stitched total-return series used for simulation

Boundaries:

- `1971-02-05` through `1985-09-30`: raw open/close comes from Yahoo `^IXIC`,
  scaled onto the NDX raw-price level at the `1985-10-01` boundary so raw/adjusted
  scale continuity is preserved.
- `1985-10-01` through QQQ inception: raw open/close comes from Yahoo `^NDX`;
  `adj_close` is synthetic NDX total return using the dividend table and QQQ
  expense-ratio drag.
- QQQ inception onward: raw open/close comes from Yahoo `^NDX`; `adj_close`
  comes from Tiingo `QQQ`.

### Out-of-band index files

#### `index-ndx-1985.csv`

Real Nasdaq-100 daily closes for `1985-01-31`..`1985-12-31` — the index's launch
through year end. It exists to cover the 168 sessions between the launch and
`1985-10-01`, the first date Yahoo's `^NDX` carries; without it those sessions
are backfilled from the Nasdaq *Composite*, a different basket that diverges from
the real index by 0.28%/day at the median and 12.96% over the window.

This file is **not** touched by `npm run fetch-data`. Regenerate it with:

```bash
npx tsx scripts/build-ndx-1985.ts
```

Source: the index owner's own Global Index Watch history endpoint — the one
`indexes.nasdaqomx.com/Index/History/NDX` drives. Unauthenticated and free. The
series starts exactly at the `1985-01-31` launch on its base of 125, and
`unit-tests/ndx-1985-history.test.ts` asserts that plus session coverage and
agreement with Yahoo `^NDX` over the overlap.

Closes only: the endpoint's start-of-day series is just the prior close, so no
genuine opening print exists for this era. That matches Yahoo's own early `^NDX`
rows, whose opens are overwhelmingly the previous close.

Treat third-party "NDX" history for this era with suspicion. Stooq's `^ndx`
export appears to reach back to 1938 — decades before the Nasdaq Composite
itself existed — and over 1985-01..09 it reproduces the Composite proxy to
0.0045% across all 188 sessions. It is back-propagation, not archive. Any
candidate source should have to match real `^NDX` returns over the Oct-Dec 1985
overlap *and* differ materially from the Composite before it.

#### `index-ffhi30.csv`

A rules-based large-cap S&P 500 analogue back to `1926-07-01`. This is the
series `index-sp.csv` uses for `1926-07-01`..`1988-04-05` (see above), and it is
also readable on its own for comparing the proxy against the real S&P 500.

This file is **not** touched by `npm run fetch-data`, but `fetch-data` *reads*
it when rebuilding `index-sp.csv`. Regenerate it with:

```bash
python3 scripts/build-ff-index.py                 # Hi 30 (default)
python3 scripts/build-ff-index.py --cut "Hi 20"   # -> data/index-ffhi20.csv
```

(needs pandas + numpy)

Source: Ken French's Data Library, "Portfolios Formed on ME" (daily), the
value-weighted `Hi 30` column — every CRSP firm above the NYSE 70th-percentile
market-equity breakpoint, cap-weighted, dividends included. Free and purely
rules-based. Ken French republishes roughly monthly, so the series ends a few
weeks behind today.

`Hi 30` is used rather than `Hi 20` because it is the closer structural match to
a 500-stock index. Measured against the S&P's 500 names and ~80% of US market
cap:

| Cut | 1957-88 | 1989-2026 | CAGR vs S&P, pre-1988 |
| --- | --- | --- | --- |
| `Hi 30` | 403 firms, 80.7% of cap | 533 firms, 84.0% | −0.30%/yr |
| `Hi 20` | 263 firms, 72.5% of cap | 344 firms, 76.9% | −0.45%/yr |

They are statistically tied on daily tracking (correlation 0.9893 vs 0.9891,
tracking error 2.97% vs 2.98%), so `Hi 30` wins on structure and level at no
cost to path fidelity.

What it contains:

- `adj_close`: the `Hi 30` total-return series, rebased so its level equals
  `index-sp.csv`'s `adj_close` on `1988-04-06` — the first row the splice leaves
  untouched, which keeps this file independent of the splice it feeds.
- `close`: price-only column, derived by stripping the S&P 500's own cumulative
  dividend contribution (`adj_close * sp_close / sp_adj_close`) so SMA signals
  run on a price index rather than a total-return one. Derived, not upstream.
- `open`: intentionally blank — Ken French publishes daily returns only, no
  opens. `src/lib/data/storage/local.ts` reads a blank `open` as "open == close".

Sharp edges:

- The NYSE traded Saturdays until `1952-05-31`. The builder compounds those
  1,158 Saturday sessions into the following trading day, which preserves
  cumulative return exactly and makes the calendar match `index-sp.csv` date for
  date over the full span (0 mismatches either way). Do not "fix" this by
  dropping Saturdays — that would silently discard about 4.4x of cumulative
  growth over 1926-1952.
- Fama-French daily returns are rounded to 1bp, so month-level compounding
  differs from the monthly FF file by ~1.4bp on average. Cumulative growth still
  round-trips exactly.
- The series ends at Ken French's last published date, currently `2026-06-30`.
  That is fine for `index-sp.csv`, which only consumes rows through
  `1988-04-05`, but means this file alone is not current for modern comparisons.
- The `Hi 30`/`Hi 20`/`Hi 10` cuts cannot be extended before `1926-07-01`: CRSP
  itself starts end-1925, and no free stock-level database with market caps
  exists earlier. `index-sp.csv`'s `1885`-`1926` rows remain Cowles-era data.

### Leveraged ETFs

- `etf-upro.csv`
- `etf-tqqq.csv`
- `etf-sso.csv`
- `etf-qld.csv`

These are the simplest outputs:

- Tiingo only
- adjusted close/open history
- no synthetic pre-inception proxy

### Risk-off assets

- `risk-sgov.csv`
- `risk-vgsh.csv`
- `risk-gldm.csv`
- `risk-brka.csv`

These combine real ETF history with synthetic pre-inception proxies.

#### `risk-sgov.csv`

- Modern SGOV rows from Tiingo
- Pre-inception proxy from GitHub short-rate history and FRED `TB3MS`
- Carry-style monthly return model plus expense-ratio drag
- Daily gap fill up to SGOV inception

#### `risk-vgsh.csv`

- Modern VGSH rows from Tiingo
- Pre-inception proxy from GitHub rate history and FRED `DGS2`
- Duration-style monthly return model plus expense-ratio drag
- Daily gap fill up to VGSH inception

#### `risk-gldm.csv`

- Modern GLDM rows from Tiingo
- Pre-inception proxy from Datahub monthly gold history
- Scaled to GLDM’s first price and adjusted for fee drag

#### `risk-brka.csv`

- Modern BRK-A rows from Tiingo
- Pre-inception proxy made from 50% S&P 500 total return and 50% VGSH

### Rates and inflation

- `inflation.csv`
- `rate-borrow.csv`

#### `inflation.csv`

- Monthly CPI history
- Older rows from the GitHub seed CSV
- Newer rows from FRED `CPIAUCSL`
- On rebuild, FRED is only asked for rows newer than the existing tail when possible

#### `rate-borrow.csv`

- Borrow-rate history for leveraged ETF simulations
- Older rows from the GitHub swap-rate seed CSV
- Newer rows from FRED `SOFR`
- On rebuild, FRED is only asked for rows newer than the existing tail when possible

## Rebuild Rules

When overlap does not match, the script handles files differently:

- ETF price files rebase older rows by the overlap ratio, then append newer rows
- `risk-brka.csv` and `risk-gldm.csv` rebase older rows by the overlap ratio, then append newer rows
- `risk-sgov.csv` and `risk-vgsh.csv` rebuild from their full source logic
- `index-sp.csv` and `index-nq.csv` rebuild from their full source logic
- `inflation.csv` and `rate-borrow.csv` rebuild from their source logic, but only ask FRED for the tail when possible

## File Formats

### Price CSVs

Index files (`index-sp.csv`, `index-nq.csv`):

```csv
date,adj_close,open,close,name,source
```

ETF files (`etf-upro.csv`, `etf-tqqq.csv`, `etf-sso.csv`, `etf-qld.csv`):

```csv
date,adj_close,name,source
```

Risk-off files (`risk-sgov.csv`, `risk-vgsh.csv`, `risk-gldm.csv`, `risk-brka.csv`):

```csv
date,adj_open,adj_close,name,source
```

Field meaning:

- `adj_close`: stitched adjusted-close series used by the app
- `adj_open`: adjusted open (risk-off files only; blank when the source
  provides only a close)
- `open` / `close`: raw index open and close (benchmark index files only)
- `name`: upstream instrument or proxy label (e.g. `VOO`, `QQQ`, `UPRO`,
  `SGOV`)
- `source`: upstream source tag. Common values:
  - `tiingo`
  - `yahoo(open+close)`
  - `stooq(open+close)` and `stooq-carry(open+close)`
  - `github-csv`, `github+er(adj_close)`
  - `datahub-io`
  - `synthetic`
  - Composite forms for index rows that blend sources, e.g.
    `yahoo(open+close)+tiingo(adj_close)` or
    `yahoo(open+close)+provisional(adj_close)` for the placeholder
    explained in "How Incremental Updates Work".

### Value CSVs

Inflation and borrow-rate files:

```csv
date,value,name,source
```

## Practical Summary

- `index-sp.csv` and `index-nq.csv` are benchmark files with real closes plus stitched total-return history.
- `index-ffhi30.csv` is a Fama-French large-cap S&P 500 analogue built out of band by `scripts/build-ff-index.py`, not by `fetch-data` — but `fetch-data` reads it to build `index-sp.csv`'s 1926-1988 era, so regenerate it before a full S&P rebuild.
- `etf-*.csv` files are direct Tiingo price histories.
- `risk-*.csv` files mix real ETF rows with synthetic proxies for pre-inception dates.
- `inflation.csv` and `rate-borrow.csv` are value series, not price series.
- Benchmark index raw open/close data uses live Yahoo Finance, with in-process
  reuse for repeated requests during the same run.
