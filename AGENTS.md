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
  (no-SMA) and `<id>-sma` results — select by id, never `etfResults[0]`.
- The heavy tools (`run_rolling_window_analysis`, `compare_strategies`) reuse
  the engine via `sweep-core.ts` → `runParallelSimulations` (mode `sweep`,
  `historyWrap:false`, single-threaded main-thread fallback server-side).
  Breadth is bounded by `limits.ts`.
- Sweep EtfConfig construction is centralized in
  `src/lib/simulation/sweep-items.ts` (server-safe, pure) and shared by the three
  `"use client"` compare pages (`compare-sma-strategies`,
  `compare-riskoff-assets`, `compare-threshold-strategies`) AND the MCP
  `compare-configs.ts`. Keep new sweep configs going through
  `makeSweepEtfConfig` so the field set can't drift between browser and server.
  These builders deliberately omit `smaExecutionMode` (the engine defaults an
  undefined mode to `next-day-open`).
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
