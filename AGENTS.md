# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.
- `npm install` is required before `npm run typecheck` / `npm run lint` / `npm test` — `node_modules` is not pre-provisioned in fresh worktrees.
- Rolling-window simulation buckets (`src/lib/simulation/parallel.ts`) drop windows independently per config when extraction returns null (e.g. a leveraged config wiped out, or a synthetic-tail resimulation that fails) — the same `windows` array can produce buckets of different lengths per config. Never zip two buckets by array index; join on `` `${startDate}|${endDate}` `` instead (see `joinByWindow` in `src/lib/simulation/win-rates.ts`, mirrored from the SGOV comparison in the same file).

## Simulation engine: entry/exit spread contract

`src/lib/simulation/window-calculations.ts` is the single source of truth for
entry/exit trading-cost deduction, shared by `engine.ts`, `parallel.ts`,
`wrapped-window.ts`, and `worker.ts`. Contract: entry spread is folded into
the renormalization factor at a window's start (so it compounds through the
whole path, matching `simulateSingleEtf`'s day-0 bake-in); exit spread is
only ever deducted from the final reported value, never baked into a
`dailyValues` array. Any new code that renormalizes a windowed sub-range of a
precomputed daily-value series must route through `computeRenormalizedPathMetrics`
/ `renormalizeSeriesFromIndex` (both take an `entrySpread` param) rather than
hand-rolling `factor = CONSTANT_INITIAL_INVESTMENT / firstValue` — that
pattern silently discards the entry-spread cost.

`src/lib/simulation/worker.ts` is a hand-maintained duplicate of
`parallel.ts`'s windowed-extraction logic for the Web Worker bundle (it
doesn't import from `parallel.ts`). When changing spread/cost logic in
`extractRegularWindowSimulation` (parallel.ts), mirror the change in
`buildWindowSimulation` (worker.ts) — `wrapped-worker.ts` doesn't have this
problem since it imports `wrapped-window.ts` directly.

Both `worker.ts`'s `mode_type === 'backtest'` branch and `parallel.ts`'s
`extractResultsMainThread`'s `mode === 'backtest'` branch are dead code as of
2026-07 — no caller passes that literal mode. They contain the same
spread-deduction bug pattern as the live paths; leave them alone unless you
also verify they've become reachable.

## Futures ladder plans

`src/lib/simulation/futures-plan.ts` builds both the futures ladder rungs and the
LETF configs "Check Emulations" checks them against, from one `SmaBand` per
index. Keep new rungs going through it. It exists because the two used to be
separate literals in `futures-tool/page.tsx` (plus a third copy in
`generate-snapshots.ts`) and drifted: the ladders carried a single buffer and
used it for both sides of the band while the LETF twins took the calibrated
asymmetric pair. Upper governs re-entry and lower governs the exit, so that moved
the trapdoor rather than the band — the ladders rode 1973-74 down 91.5% where
their twins stopped at 65.9%. Same failure mode `sweep-items.ts` prevents.

## Futures engine: total-return invariant

`src/lib/simulation/futures.ts` must keep a held position earning exactly
`indexTotalReturn − (rate + fundingSpread) × calendarDays`, where the spread is
the contract's roll richness over the risk-free rate
(`DEFAULT_FUTURES_FUNDING_SPREAD_ANNUAL`, 0.35%/yr, charged on notional so it
scales with the rung). `futuresCarryForHoldingPeriod` nets the
row's *realized* dividend (`adj_close` return minus `close` return, already
covering weekend gaps) against the rate. The raw `close`/`open` columns drive only
SMA signals, fill prices, and notional — never the P&L path. This matters because
`index-sp.csv` before 1988-04-06 takes `adj_close` from Fama-French Hi 30 and
`close` from the old S&P price path (`src/lib/data/ff-large-cap-splice.ts`); the
two disagree by up to 3% on ~50 days, which a price-driven P&L would compound at
full leverage.

Real NDX back to the 1985-01-31 launch lives in `data/index-ndx-1985.csv`, pulled
from the index owner's Global Index Watch endpoint by `scripts/build-ndx-1985.ts`
(free, unauthenticated, closes only). Yahoo's `^NDX` only starts 1985-10-01, so
without it those 168 sessions are Nasdaq *Composite* backfill.

Vet any other "NDX" source for that era before believing it: it must match real
`^NDX` returns over the Oct-Dec 1985 overlap *and* differ materially from the
Composite before it. Stooq's `^ndx` fails the second test — it reproduces our
Composite proxy to 0.0045% across all 188 sessions of 1985-01..09 and its file
starts in 1938, decades before the Composite existed.

`NDQ-TR` in `data/index-nq.csv` is not a misspelling of NDX: it tags the
1971-02-05..1985-09-30 rows, which are the Nasdaq *Composite* scaled to meet NDX
at the seam (the Nasdaq-100 did not exist yet) and carry their own dividend-yield
table in `fetch-data.ts`. Display labels say NDX everywhere; only the data layer
keeps the distinction.

Margin is a requirement, not a payment: `maintMarginRate` governs capacity and
excess liquidity, never the cash-sweep base. Netting it out of the interest base
charges a phantom `maintMarginRate × leverage × rate` that scales with leverage
and so tilts the ladder against its own higher rungs.

Day 0 establishes the starting position at the first *close* in both regimes —
the bar `dailyEquity[0]` marks, and what `simulateSingleEtf` books — so the
opening bar's intraday move can never leak into the result.

Commissions and bid/ask spreads are deflated on *different* axes, deliberately.
Spreads ride `futuresPriceScale` (fill price / anchor price) so half a tick stays a
constant fraction of notional; commissions are a fixed dollar schedule
(`IBKR_FEE_PER_CONTRACT`, all-in per side) deflated by CPI, because tying them to the
index level had a 1988 fill paying ~4c a contract. The CPI anchor is the explicit
`FEE_SCHEDULE_ANCHOR_DATE`/`_CPI` pair rather than the series' own tail: the engine is
only ever handed CPI up to the simulation's end date, so a window ending in 1980 has no
present-day row to anchor on and would otherwise charge today's schedule in 1980 dollars.
Refresh the pair when the fee constants are requoted, not on every CPI print.

The futures ladders and their LETF twins ("Check Emulations" on /futures-tool)
model different instruments and are not expected to match: the LETF pays
`(L−1)·(borrow + swapSpread)` per *trading* day, the futures pay carry on notional
per *calendar* day plus a sweep on collateral. Residual annual drift is that model
difference; daily tracking error is not, and is worth chasing.

## Swap spread: fitted range and the cap above it

`getSwapSpreadDaily` is a line in the rate level, fitted by `calibrate-etfs.ts`
against the real ETFs — which only exist from 2006 (SSO/QLD) and 2009-10
(UPRO/TQQQ), where the benchmark tops out at 5.82%. The slope is genuinely
identified there (pinning it to zero costs UPRO ~6% of final tracking error), so
do not flatten it. Above `SWAP_SPREAD_CALIBRATED_RATE_MAX` (6%) the fitted credit
spread holds flat while the rate still passes through in full, via
`SWAP_SPREAD_RATE_PASSTHROUGH_SLOPE` (`360/252 − 1`) — the engine charges
`rate/360` on ~252 trading days, so a naive cap would make leveraged financing
cheaper than risk-free. Everything at or below 6% is bit-identical to the raw
fitted line, which is what keeps post-2006 results and the calibration itself
untouched; `unit-tests/swap-spread-extrapolation.test.ts` guards all three
properties.

## MCP server (AI-agent API)

The remote MCP endpoint lives at `src/app/[transport]/route.ts` (served at
`/mcp` over stateless Streamable HTTP; SSE disabled, so no Redis needed) with
all tools/resources/prompts under `src/lib/mcp/`. Wiring is centralized in
`register.ts`; the in-memory-transport test (`unit-tests/mcp-server.test.ts`)
is the fastest way to exercise the whole surface.

Sharp edges:
- MCP tools run inside a serverless function, so they load market data via the
  server query layer (`@/lib/db/queries`), NOT `fetch-market-data.ts` — that
  module fetches the app's own `/api/*` routes with relative URLs and only
  works in the browser. `server-data.ts` is the server-side loader (price
  coercion, borrow-rate mapping, risk-off source-key mapping mirrored from
  `api/risk-off-prices/route.ts`).
- `run_backtest` routes through `simulateWithWarmUp` (preserving the entry/exit
  spread contract). `expandEtfConfigs` splits an SMA config into `<id>-base`
  (no-SMA) and `<id>-sma` results — select by id, never `etfResults[0]`, and
  resolve with `findEtfResult(result, id)` rather than a bare
  `etfResults.find(...)`. Configs that compute identically (most often the
  `<id>-base` twins of several SMA configs on one LETF) are simulated and
  emitted ONCE so charts draw no duplicate series; the other requested ids map
  to the surviving one in `result.etfResultIdAliases`, which only
  `findEtfResult` consults.
- The heavy tools reuse the engine server-side (single-threaded main-thread
  fallback; breadth bounded by `limits.ts`): `sweep-core.ts` →
  `runParallelSimulations` mode `sweep` (rolling-window / holding-period /
  `compare_strategies`); `letf-compare-core.ts` → `runParallelVariants` mode
  `variants` + `strategy-percentiles` (`compare_letfs`);
  `backtest-compare-core.ts` → `runParallelBacktest` (multi-config / real-ETF /
  multi-index `compare_backtests`, which aligns risk-off & real-ETF series
  itself); and `run-futures-backtest.ts` → `simulateFuturesSmaStrategy`. All use
  `historyWrap:false`.
- Real-ETF overlays: `etfPricePointsByName` is keyed by base ticker
  (`getHistoricalPriceSymbol` strips the `-real`/strategy suffix); load via
  `getPrices('etf:<TICKER>')`. The futures engine runs SMA over the full
  (warm-up-inclusive) series then trades the sliced range, so pass warm-up rows.
- Sweep EtfConfig construction is centralized in
  `src/lib/simulation/sweep-items.ts` (server-safe, pure) and shared by the three
  `"use client"` compare pages (`compare-sma-strategies`,
  `compare-riskoff-assets`, `compare-threshold-strategies`) AND the MCP
  `compare-configs.ts`. Keep new sweep configs going through
  `makeSweepEtfConfig` so the field set can't drift between browser and server.
  `smaExecutionMode` is an optional passthrough there: the pages leave it unset
  (engine default `next-day-open`), the MCP tools pass the caller's choice.
- MCP progress (`progress.ts`) is opt-in — no `progressToken` on the request
  means no reporter is built. Reports are fire-and-forget, monotonic, and
  clamped to [0,1] with `total:1`; a failed notification must never fail a tool.
  `runParallelVariants`' own `onProgress` is typed for the compare-letfs page's
  `(done, total)` progress bar, NOT the engine's `(fraction, label)` — that is
  why `sweep-core.ts`'s per-window pass calls `runParallelSimulations`
  (mode `variants`) directly.
- `get_precomputed_analysis` (`snapshot-core.ts`) serves
  `src/lib/tool-snapshots/*.json`, which embed full daily series (backtesting
  ~1.8MB, futures ~4MB) — always distil, never return `pageState` raw. Those
  snapshots are generated with history wrap ENABLED while every MCP tool runs
  `historyWrap:false`, so their best/worst window dates can sit in the future;
  the tool attaches a caveat saying so and it must stay attached.
- `unit-tests/mcp-discovery.test.ts` pins `public/.well-known/mcp.json` and
  `public/llms.txt` to `register.ts`, so adding a tool fails the suite until
  both discovery documents list it.
- The endpoint is rate-limited in `rate-limit.ts` (Upstash-backed when the
  `UPSTASH_REDIS_REST_*` env vars are set, per-instance in-memory otherwise);
  a global per-IP budget plus a stricter one for `MCP_HEAVY_TOOLS`. The route
  handler in `[transport]/route.ts` calls `enforceMcpRateLimit` before the MCP
  handler.
- Discovery for agents: `public/llms.txt`, `public/robots.txt`, and
  `public/.well-known/mcp.json` advertise the `/mcp` endpoint. Keep the tool
  list in `.well-known/mcp.json` in sync with `register.ts`.
- `next.config.ts` `outputFileTracingIncludes` must include the `/[transport]`
  route (alongside `/api/**/*`) so the CSV data and calibration snapshot are
  bundled into the MCP function on Vercel.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
