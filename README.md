# Leveraged ETF Backtesting Lab

A Next.js app for researching leveraged ETF strategies across long market history with rolling-window analysis, SMA timing rules, risk-off switching, and trade-level backtests.

> **Disclaimer.** This project is for educational and research use only. It is **not investment advice**. Leveraged ETFs are high-risk instruments and historical backtests do not guarantee future performance. Past performance does not predict future returns. Consult a licensed financial advisor before making any investment decisions.

## Features

- Compare simulated leveraged ETF strategies (`UPRO`, `TQQQ`, `SSO`, `QLD`) over long history.
- Compare simulated series against the real ETFs (`UPRO-real`, `TQQQ-real`, `SSO-real`, `QLD-real`) where applicable.
- Sweep SMA periods, SMA buffers, and risk-off assets across rolling windows.
- Inspect full return distributions, percentile stats, rank frequencies, and drawdowns.
- Run single-period backtests with trade logs, value charts, and spread-cost assumptions.
- View current SMA signals on the `/signals` page.

## Prerequisites

- **Node.js 22 LTS** (see [`.nvmrc`](./.nvmrc)). `nvm use` if you have nvm installed.
- **npm 10+** (ships with Node 22).

## Installation

```bash
git clone <your-fork-url>
cd l-etf
nvm use                    # optional
npm install
npm run dev
```

Then open <http://localhost:3000>.

The repo ships with bundled CSV data in `./data/`, so the app runs out of the box — backtests, charts, and SMA analysis all work without any API keys.

For a production build:

```bash
npm run build
npm start
```

## Getting the latest market data (optional)

The bundled CSVs cover history up to whenever the repo was last published. To pull fresh data:

- **Quick path** — one-shot manual refresh:
  ```bash
  cp .env.example .env.local
  # fill in TIINGO_API_KEY and FRED_API_KEY (both free, see below)
  npm run fetch-data
  ```

- **Automatic path** — set the same two keys in `.env.local` and the running app refreshes itself. After 7pm New York time (market close + 3 hours), the first incoming request triggers a background fetch; at most once per NY date, silent on failure. Set `AUTO_REFRESH_DATA=false` to disable.

Without those keys the app simply uses the bundled CSVs — everything works, you just won't see new market days.

## Optional features

All of these are off by default and the app runs fine without them. See [`.env.example`](./.env.example) for the full annotated template.

| Feature | Variables | Where to get / what it enables |
|---|---|---|
| **Latest market data** | `TIINGO_API_KEY`, `FRED_API_KEY` | [tiingo.com](https://www.tiingo.com/) (free) and [fred.stlouisfed.org/docs/api/api_key.html](https://fred.stlouisfed.org/docs/api/api_key.html) (free). Enables the auto-refresh described above and the manual `npm run fetch-data` script. |
| **Disable auto-refresh** | `AUTO_REFRESH_DATA=false` | Set this if you have the two keys above but prefer to run `fetch-data` from your own cron. |
| **Push notifications** for SMA signal flips | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Generate VAPID with `npx web-push generate-vapid-keys`; Upstash Redis free tier at [upstash.com](https://upstash.com/). Subscriptions are stored in Redis, alerts go via Web Push. |
| **Vercel-cron data refresh** | `CRON_SECRET`, `VERCEL_DEPLOYMENT_HOOK_URL` | Only meaningful on Vercel deployments. `vercel.json` cron hits `/api/cron/refresh-data`, which triggers a redeploy via the deploy hook when a fresh index close is available. |
| **Weekly artifact auto-commit** | `GITHUB_TOKEN` | Lets `scripts/commit-data.mjs` push refreshed CSVs back to your fork (used by the Vercel build pipeline). |
| **Box Trades page** | `NEXT_PUBLIC_DISPLAY_BOX_TRADES=true` | Exposes `/box-trades` (SPX box-spread implied APY). Hidden by default; the page returns 404 when the flag is off. |
| **Sitemap origin** | `NEXT_PUBLIC_SITE_URL` | Public URL used by `app/sitemap.ts`. Defaults to `http://localhost:3000`. |

## AI agents (MCP server)

The app exposes its analysis engine to AI agents through a [Model Context
Protocol](https://modelcontextprotocol.io) server, served over Streamable HTTP
at **`/mcp`** (e.g. `http://localhost:3000/mcp` in dev). Any MCP client — Claude
Desktop/Code, Cursor, or the [MCP Inspector](https://github.com/modelcontextprotocol/inspector)
(`npx @modelcontextprotocol/inspector`) — can add it and run backtests
conversationally. Results are computed by the real simulation engine, not
guessed by the model.

Tools:

| Tool | What it does |
|---|---|
| `list_presets` | Available ETF presets, risk-off assets, and default SMA settings. |
| `get_market_data` | Raw index prices, borrowing rates, or CPI over a date range. |
| `get_sma_signals` | Current SMA buy/sell/hold signal for the S&P 500 and Nasdaq-100. |
| `get_sma_calibration` | Precomputed best SMA period/buffer per index (cached snapshot). |
| `run_backtest` | Single-strategy backtest → CAGR, max drawdown, Sharpe, trade log, 1x benchmark. |
| `compare_backtests` | Backtest several presets (simulated and/or real ETFs, either index) over one shared range. |
| `run_rolling_window_analysis` | One strategy across every historical rolling window → outcome distribution. |
| `run_holding_period_analysis` | How a strategy's outcome distribution changes across several holding-period lengths. |
| `compare_strategies` | Rank variants (SMA on/off, risk-off assets, SMA periods, SMA buffers) over rolling windows. |
| `compare_letfs` | Compare LETF presets across rolling windows with p10/p50/p90 percentile distributions. |
| `run_futures_backtest` | Index-futures (ES/NQ) SMA strategy at a target leverage with margin, rolls, and fees. |
| `get_box_spread_apy` | Live SPX box-spread implied financing APYs (a low-risk borrowing benchmark). |

It also serves a `letf://methodology` resource, a `letf://data-coverage`
resource (current data freshness), and an `analyze_strategy` prompt. Every tool
carries the not-investment-advice disclaimer.

The endpoint is unauthenticated compute, so it is rate-limited per client IP
(a global budget plus a stricter one for the sweep tools). Limits are enforced
via Upstash Redis when `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`
are set (shared across instances); without them a per-instance in-memory
fallback applies. For a public deployment, also consider Vercel Firewall.

## Hosting

### Local / self-host (no Vercel needed)

```bash
npm run build
npm start
```

If `TIINGO_API_KEY` and `FRED_API_KEY` are set, the running app refreshes its own CSVs once per NY weekday after 7pm — no external scheduler needed. This auto-refresh guards against concurrent runs with in-process state, so it assumes a single long-lived server process per `data/` directory; running multiple processes against a shared `data/` directory can race. You can also run `npm run fetch-data` manually any time, or wire it into your own cron / systemd timer if you prefer:

```cron
0 17 * * 1-5 cd /path/to/l-etf && npm run fetch-data >> /var/log/l-etf-fetch.log 2>&1
```

Push notifications additionally require `VAPID_*` and an Upstash Redis instance. The cron-driven auto-redeploy is Vercel-specific and is simply unused off Vercel — you control rebuilds yourself.

### Vercel

The project autodetects as Next.js. Add the required env vars in the Vercel project settings.

To enable the scheduled SPX/NDX freshness check + automatic redeploy:

1. Install the Upstash Redis Marketplace integration (provides `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` automatically).
2. Generate a Deploy Hook in Settings → Git → Deploy Hooks and store its URL as `VERCEL_DEPLOYMENT_HOOK_URL`.
3. Set `CRON_SECRET` to a random string.

The cron schedule lives in [`vercel.json`](./vercel.json); the build orchestration is in [`scripts/build-vercel.ts`](./scripts/build-vercel.ts). Both are no-ops in local/self-host setups — running `npm run build` instead of `npm run build:vercel` skips all of it.

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start the Next.js dev server. |
| `npm run build` | Production build. |
| `npm start` | Run the production server (after `build`). |
| `npm run lint` | ESLint with zero-warnings policy. |
| `npm run typecheck` | TypeScript check (no emit). |
| `npm test` | Unit tests (Node test runner). |
| `npm run test:coverage` | Unit tests with coverage report. |
| `npm run fetch-data` | Refresh local market-data CSVs in `./data/`. Accepts optional args (e.g. `npm run fetch-data index-sp`, `... borrow`, `... risk-off`, `... UPRO TQQQ`). |
| `npm run calibrate` | Recalibrate simulated-LETF parameters against real ETF history. |
| `npm run snapshots:generate` | Generate compact per-page tool snapshots used by the UI for fast first paint. |
| `npm run notify:sma-alerts` | Compute the default SMA regime and send push alerts to subscribed Home Screen devices. Pass `--force` to send even when status has not changed. |
| `npm run ui-tests` | Puppeteer-based UI smoke tests. |

## Data sources & attribution

Public-domain or freely-licensed sources used by `fetch-data`:

- **Tiingo** — modern ETF prices and some proxy anchors. Free tier with attribution.
- **FRED (St. Louis Fed)** — `CPIAUCSL`, `SOFR`, `DGS2`, `TB3MS`, etc. Public domain.
- **Yahoo Finance** chart endpoint — benchmark `^GSPC` / `^NDX` open/close. Unofficial; rate-limit politely.
- **Stooq** — early S&P 500 history before Yahoo `^GSPC` starts.
- **Datahub** — monthly gold price history for the GLDM proxy.
- **`SteelCerberus/swap_rates`** (GitHub) — historical USD swap rates used in the stitched borrow curve.

See [`DataFetch.md`](./DataFetch.md) for the detailed fetch and stitching logic.

## Project layout

```
src/
  app/                Next.js App Router pages & API routes
  components/         UI components
  lib/                core simulation, data, push, etc.
scripts/              fetch-data, calibration, snapshots, build orchestration
data/                 generated CSVs (populated by `npm run fetch-data`)
unit-tests/           Node test-runner unit tests
ui-tests/             Puppeteer UI smoke tests
```

## App structure

The main workflow lives under `/tools` with tabs:

- `Strategies`, `SMA Period`, `SMA Buffer`, `SMA Risk-Off Assets`, `Statistics`, `Backtest`, `Futures`.

Additional pages:

- `/signals` — current S&P 500 and Nasdaq 100 SMA signals.
- `/faq` — methodology and product questions.
- `/box-trades` — SPX box-spread implied APY (hidden by default; enable with `NEXT_PUBLIC_DISPLAY_BOX_TRADES=true`).

## Core concepts

### Simulated vs real LETFs

The default preset names are the simulated series:

- `UPRO`, `SSO` — simulated leveraged S&P 500
- `TQQQ`, `QLD` — simulated leveraged Nasdaq 100

The real ETFs are separate presets (`UPRO-real`, `SSO-real`, `TQQQ-real`, `QLD-real`). The shared LETF selector focuses on the simulated presets; ETF cards can select either simulated or real.

### History Wrap

`History Wrap` is used on rolling-window pages so recent start dates can still produce full-length windows.

- It does **not** peek into future data beyond your selected end date.
- It completes incomplete windows by wrapping back through earlier history.
- Wrapped windows are included in the simulation set and flagged as wrapped.

### Score

The `Score` column is a comparative ranking metric for rolling-window strategy tables. Higher is better, but it is not meant to be interpreted as an investment return or probability. It rewards higher average final real value, higher average real CAGR, and better worst-window real CAGR; it penalizes larger average drawdowns, larger worst-ever drawdowns, excessive trading, and especially catastrophic drawdowns above roughly the 80% range. Exact coefficients live in `src/lib/simulation/score.ts` and may evolve.

### Supported assets

- **Indexes:** `VOO` (S&P 500, stitched long-history total-return-style series; 0.03% expense-ratio parity drag for proxy history), `QQQ` (Nasdaq 100, 0.18% ER drag).
- **Simulated leveraged presets:** `UPRO` (3x SPX), `SSO` (2x SPX), `TQQQ` (3x NDX), `QLD` (2x NDX).
- **Real leveraged ETFs:** `UPRO-real`, `SSO-real`, `TQQQ-real`, `QLD-real`.
- **Risk-off:** `SGOV`, `VGSH`, `GLDM`, `BRK.B`, and equal-weight mixes (`BRK.B+GLDM`, `VGSH+GLDM`, `BRK.B+VGSH`, `BRK.B+GLDM+VGSH`). Historical proxies are used before ETF inception where needed.

## Development notes

- Shared tool inputs persist across pages via local storage and URL params; URL params override stored defaults so shared links are reproducible.
- Initial page loads with meaningful params can auto-run; tab switches do not auto-run unless explicitly marked.
- Snapshot generation writes one compact JSON per page under `src/lib/tool-snapshots/`.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Issues and PRs are welcome.

## License

[MIT](./LICENSE)
