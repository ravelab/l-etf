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
that date is preserved, and later matched dates can still be appended. A row
without stored or current Yahoo data is allowed only in the recent trailing
partial-data window and is backfilled on a later run.

## CSV Families

### Index files

- `index-sp.csv`
- `index-nq.csv`

These are the most layered outputs.

#### `index-sp.csv`

Builds the S&P 500 benchmark series.

Sources:

- Yahoo `^GSPC` daily open/close from Yahoo’s first available date onward
- Stooq `^spx` API open/close before Yahoo `^GSPC` starts
- GitHub total-return seed data
- Tiingo `VOO`
- existing `data/index-sp.csv` fallback if a live rebuild cannot complete

What it contains:

- `close`: actual SPX index level used for SMA signals
- `open`: actual SPX index open used for open-execution logic
- `adj_close`: stitched total-return series used for simulation

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
- `etf-*.csv` files are direct Tiingo price histories.
- `risk-*.csv` files mix real ETF rows with synthetic proxies for pre-inception dates.
- `inflation.csv` and `rate-borrow.csv` are value series, not price series.
- Benchmark index raw open/close data uses live Yahoo Finance, with in-process
  reuse for repeated requests during the same run.
