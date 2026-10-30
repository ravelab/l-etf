# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.
- `npm install` is required before `npm run typecheck` / `npm run lint` / `npm test` — `node_modules` is not pre-provisioned in fresh worktrees.
- **Never join engine output by array index.** The engine drops entries
  independently per config, so a returned array is "requested order *minus the
  drops*" and positional zipping shifts every later entry onto the wrong config.
  This has bitten twice, in different shapes:
  - Rolling-window buckets (`src/lib/simulation/parallel.ts`) drop windows
    independently per config when extraction returns null (a leveraged config
    wiped out, a synthetic-tail resimulation that failed) — the same `windows`
    array can produce buckets of different lengths per config. Join on
    `` `${startDate}|${endDate}` `` (see `joinByWindow` in
    `src/lib/simulation/win-rates.ts`).
  - Mode `sweep` drops a config whose bucket came back empty, so `rows` is not
    1:1 with `configs`. Join on `row.parameterValue`, which `paramValues` stamps
    with the owning config's index (see `joinSweepRowsToConfigs` in
    `src/lib/mcp/sweep-core.ts`).
  When adding a new engine output, decide what its join key is before writing
  the consumer.
- Web-push `endpoint`s are pinned to HTTPS on known push services by
  `src/lib/push/endpoint.ts`. They arrive from unauthenticated callers and are
  later POSTed to by `notify-sma-alerts` **from the deploy container**, which
  holds `VAPID_PRIVATE_KEY`, `CRON_SECRET`, and the data-provider keys — an
  unvalidated endpoint is a blind SSRF that also hands an attacker a signed VAPID
  JWT. Extend the host lists for a new browser's push service; never relax them
  to accept arbitrary hosts.

## Branches and CI

`dev` is day-to-day; `main` is production (Vercel production branch) and only
advances by fast-forward from an already-tested `dev` tip (`npm run promote` /
`npm run ship`). Wire local hooks once with `npm run setup:hooks`
(`.githooks`: pre-commit = lint/typecheck/knip). Unit tests + coverage and
post-deploy E2E run in GitHub Actions after push. Actions:
`Test` runs unit on pushes to `dev` and PRs (node:test logic + Vitest/jsdom
components, overall `src/**` coverage);
`Test the deployment` runs the Puppeteer E2E suite (`npm run test:e2e`) against
preview deploys and the `@smoke`-tagged subset against production. Prefer
`npm run push:dev` over a bare `git push` when you need the post-deploy wait.

`npm run promote` refusing with "main could not be fast-forwarded to dev. Someone
has committed to main directly" is routine, not a fault: the refresh-data cron
commits `chore(data): refresh generated artifacts` straight to `main`, so `main`
runs ahead every few days. Fix it by merging `origin/main` into `dev`, then
re-running the gates — the merge brings new `data/*.csv` rows, and the futures and
engine tests read those files — then push and promote. Never rebase `dev` and
never force-push it; that rewrites commits already pushed and already green in CI,
for no gain. If `main` is ahead with anything that is not a data-only cron commit,
stop and ask: that is the case the refusal was written for, and it stays.

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

There are TWO paths that trim a simulated result down to a display window, and
they must agree: `sliceBacktestResultToWindow` (engine.ts, the warm-up trim used
by `simulateWithWarmUp`) and `trimEtfResultToStartDate` (parallel.ts). Both must
(a) resolve `endInRiskOff` as well as `startInRiskOff` and deduct the exit
spread, and (b) recompute `totalTradingCostPct` from the signals that land
*inside* the window — the incoming value covers warm-up trades that happened
before it. Route both through `finalizeTradingCosts` rather than reimplementing.
The engine path silently did neither until 2026-08, so the same strategy
reported a different final value depending only on whether warm-up data existed
(the `displayStartIdx === 0` early return does deduct it).

`src/lib/simulation/worker.ts` is a hand-maintained duplicate of
`parallel.ts`'s windowed-extraction logic for the Web Worker bundle (it
doesn't import from `parallel.ts`). When changing spread/cost logic in
`extractRegularWindowSimulation` (parallel.ts), mirror the change in
`buildWindowSimulation` (worker.ts) — `wrapped-worker.ts` doesn't have this
problem since it imports `wrapped-window.ts` directly. Range max-drawdown is no
longer part of that duplication: both now import `buildDrawdownRangeQuery` from
`simulation/drawdown-range.ts`. Prefer moving shared logic there over mirroring
it a third time.

Window metrics split into an O(1) half and an O(window) half. `factor` and
`finalValue` need only the endpoints (`computeRenormalizedEndpointMetrics`);
only peak/drawdown needs the walk, and a prebuilt `DrawdownRangeQuery` answers
that in O(log n). Any new code sweeping many windows over one series should
build the tree once per config rather than walking per window — the main-thread
path is not a rare fallback (`win-rates.ts` uses it for 32 holding-period
lengths, and every MCP heavy tool is main-thread-only server-side).

Both `worker.ts`'s `mode_type === 'backtest'` branch and `parallel.ts`'s
`extractResultsMainThread`'s `mode === 'backtest'` branch are dead code as of
2026-07 — no caller passes that literal mode. They contain the same
spread-deduction bug pattern as the live paths; leave them alone unless you
also verify they've become reachable.

## Deployment updates

`DeployVersionWatcher` must compare the server version with the loaded build's
`BUILD_DEPLOY_VERSION`, frozen by `next.config.ts` and shared with
`/api/deploy-version`. Never use localStorage as the running version: a fresh
load already has the new build but retains the previous visit's id, and other
tabs can overwrite it. Storage events are hints to re-check the server only.

## Tool pages: risk-off assets are per index

The tool pages hold one SPX and one NDX risk-off asset (`spxRiskOffAsset` /
`ndxRiskOffAsset`, URL `ros` / `ron`, defaults `DEFAULT_RISK_OFF_ASSETS`), shared
across pages by `use-shared-inputs.ts`; every config takes its own `smaIndex`'s
asset, futures rungs and their Check Emulations twins included. Read and write
the URL through `risk-off-url-params.ts`: it still reads the legacy single `ro`
as both, which old history links and MCP permalinks carry. The SMA calibration
and the MCP tools' single `riskOffAsset` keep `DEFAULT_RISK_OFF_ASSET`. Canned
snapshots load only into a form whose pair matches, so changing the defaults
means `npm run snapshots:generate` and re-measuring the worst-time windows
(`scripts/find-worst-drawdowns.ts`).

## Tool pages: cancellation and run races

Every tool page runs a long simulation behind an `AbortController`, and the same
two mistakes have been made on all of them:

- Raise cancellation through `throwIfAborted(signal)` / `abortError(signal)` from
  `src/lib/abort.ts`, never `throw new Error("Aborted")`. Catch blocks match on
  `isAbortError`, which keys off `name`; a plain Error has name `"Error"`, so it
  falls through to the failure branch, wipes the displayed results and raises an
  error banner that then persists into the next successful run.
- A superseded run must not publish. Guard the `finally` with
  `abortControllerRef.current === controller` before clearing loading/progress
  (otherwise the spinner clears while the replacement is still running and Cancel
  is left with a null ref), and re-check `throwIfAborted(signal)` immediately
  before writing state / storage / `router.push` — a long compute that ignores
  its signal will otherwise finish late and overwrite the run that replaced it.

Any long-running helper the pages call needs to take a `signal` and check it
between chunks; `computeWinRatesByWindowLength` checks per holding-period year.

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

A ladder step is turned into something runnable by `buildFuturesRunPlans`
(`futures-run-plan.ts`) — the single place that decides a step with `secondary`
runs as a two-sleeve fund. Three callers share it: the page, the MCP
`compare_futures_ladder` tool, and `generate-snapshots.ts`. The snapshot script
is the one that gets forgotten: it mapped steps itself, never learned about
`secondary`, and so shipped a canned futures page whose fund row was a second
copy of the plain 4.5x SPX rung (1.0B where the fund makes 1.8B). Whatever the
page renders *off* a run — currently which rungs list their trades
(`showsFuturesTransactions`) — is shared the same way, because the snapshot
keeps `transactions[]` only for those.

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

Contract expiry is **not** a pure function of the contract symbol, so never
memoize it keyed on the symbol alone. `resolveTwoDigitYear` slides its century
window off the *trade* year, so `ESZ25` is 1925 in a 1962 run and 2025 in a 2026
run; a symbol-keyed cache silently corrupts long runs. Cache the symbol *parse*
(`{quarterMonth, yy}`) and key the resolved expiry on `(year, month)` — that is
what `contractSymbolPartsCache` / `contractExpiryEpochCache` do. Expiry feeds
basis → fill price → notional → leverage, so a bad memo shows up as
`avgActualLeverageRiskOn` drifting off the target rather than as an error.

Cash-like exposure accrues per **calendar** day, not per trading row: the daily
rate is `annual / 360`, so accruing once per session pays only ~252 of 360 days
and understates the position by ~30% of the rate. The futures cash sweep walks
`extraSweepDays` for this; the risk-off cash fallback uses
`riskOffCashAccrualDays`. Any new cash-like accrual must do the same.

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

Margin is a requirement, not an expense, but interest eligibility depends on the
broker and collateral. Production futures callers enable `treasuryCollateral`:
`futures-collateral.ts` models a separate SGOV/VGSH pool without a fixed cash
reserve. The user holds no margin cash reserve: margin constrains capacity and
excess liquidity, never subtract it from investable capital or the interest base. Never credit cash interest on Treasury holdings as well.
The engine's `cash` variable remains consolidated marked capital including that
pool; purchases are internal transfers, and only P&L/costs change it. Low-level
callers omitting the option retain the legacy analytical cash-sweep model.

The live-policy reference is `~/futures/src/treasury/sleeve.ts` and its execution
code (some config/README comments lag). Scope deliberately excludes core equities
and box loans. See `docs/futures-collateral-model.md` for broker sources and the
remaining approximations: daily execution proxies, estimated margin requirements/haircuts,
share-equivalent order bands and per-sleeve
rather than account-netted Treasury management. Do not tune these costs to match
LETF returns. Both Treasury series must be loaded even when neither is risk-off.
Snapshot ledgers omit collateral maintenance rows to stay within the download
budget; costs and equity include them, and the UI directs users to rerun for the
full ledger. SGOV/VGSH jointly cover Treasury targets and survive re-entry; a
non-Treasury risk-off target must sell enough collateral to fund its full
allocation (100% BRK.B for an all-BRK.B sleeve). Never restrict that purchase to
residual cash. Treasury values are already included in `cash`; carry their
ownership through the dual-sleeve in-kind reset without adding equity twice.

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

## Futures: sleeves and the two-sleeve fund

`simulateFuturesSmaStrategy` is a thin driver over `createFuturesSleeve`, which
returns a sleeve that can be stepped one day at a time (`stepDay`), read and
rewritten (`readHoldings` / `writeHoldings`), then closed out (`finish`). The day
loop became a `stepDay` closure holding all its state as closure variables rather
than a threaded state object, so the body moved verbatim and every existing rung
is bit-identical — keep it that way. Its old `continue` is a `return` and its old
`break` is the `ruined` flag; a new early exit must set that flag, never just
return, or later days will overwrite the zeroed tail.

`futures-dual-sleeve.ts` runs one fund as two sleeves (one per index family),
never rebalanced against each other except on a day when both were risk-off and
one is about to go risk-on, when the fund resets to 50/50. That reset is
deliberately free, and two things make it so: both sleeves hold the SAME risk-off
basket, and it is applied BEFORE the day is stepped, while the re-entering sleeve
still holds its basket instead of the futures it is about to buy. Giving each
sleeve half of every combined holding leaves the fund's share count per ticker
untouched, so nothing trades. Splitting the drifted weights any other way, or
applying it a day later, books real trades and is wrong.
`unit-tests/futures-dual-sleeve.test.ts` pins the exactness case: with a band that
never exits, the fund must equal two independent half-size sleeves to the cent.

## Swap spread: fitted range and the cap above it

ETF calibration and real/simulated backtest comparisons must end on an observed
close shared by every participating series (`latestCommonCloseDate`). The monthly
2026-10-05 calibration included a provisional index day while ETF data ended on
10-02; forward-filling the ETF tail forced a false financing-cost adjustment.
Calibration excludes provisional closes and fails if a pair cannot be fitted;
`runParallelBacktest` caps all compared paths together when real ETFs are selected.
Simulated-only runs can still use the newest index day.

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
`/mcp`) with all tools/resources/prompts under `src/lib/mcp/`. It runs on
`mcp-handler` 2 and MCP SDK v2 (`@modelcontextprotocol/server`; tests use
`@modelcontextprotocol/client`), which serves the 2026-07-28 protocol natively
and 2025-era Streamable HTTP clients statelessly, with no session store and
`maxSubscriptions: 0`. mcp-handler 2 answers every request it is handed, so the
route itself 404s any `[transport]` segment other than `mcp`. Input, args and
output schemas are full `z.object(...)` schemas (v2 dropped raw shapes), and
handlers read the request through `ctx.mcpReq` (`signal`, `_meta`, `notify`).
Wiring is centralized in `register.ts`; the in-memory-transport test
(`unit-tests/mcp-server.test.ts`) is the fastest way to exercise the whole surface.

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
  resolve with `findEtfResult(result, id)` (`simulation/result-lookup.ts`)
  rather than a bare
  `etfResults.find(...)`. Configs that compute identically (most often the
  `<id>-base` twins of several SMA configs on one LETF) are simulated and
  emitted ONCE so charts draw no duplicate series; the other requested ids map
  to the surviving one in `result.etfResultIdAliases`, which only
  `findEtfResult` consults.
- The heavy tools reuse the engine server-side (single-threaded main-thread
  fallback; breadth bounded by `limits.ts` + `compute-budget.ts`): `sweep-core.ts` →
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
- Tools are annotated from `annotations.ts` (read-only everywhere; only
  `get_box_spread_apy` is open-world) and the server ships `instructions.ts` at
  `initialize`. Tools with a stable payload declare an `outputSchema`
  (`output-schemas.ts`) and return via `toolSuccessTyped`, whose text block is
  the summary alone — the untyped `toolSuccess` serializes the payload into text
  *as well as* `structuredContent`, which doubled the token cost of every call.
  The SDK validates `structuredContent` against the schema and raises a protocol
  (not tool) error on a mismatch, so only declare a schema that
  `unit-tests/mcp-output-schema.test.ts` exercises with a real call, and route
  payloads through `sanitizeNonFinite` — `z.number()` rejects NaN.
  **A test harness must call `client.listTools()` before `callTool`**: listing is
  what caches the schema on the client, which then validates against the
  generated JSON Schema (emitted `additionalProperties: false`) instead of the
  zod object, which silently strips unknown keys. Every MCP harness in
  `unit-tests/` primes it; without that, a schema missing a pass-through field
  (`DailyPrice.name`/`.source`, say) passes the suite and fails in every real
  client. `get_precomputed_analysis`, `get_sma_calibration`,
  `get_sma_signal_history` and `get_box_spread_apy` stay untyped on purpose —
  their payloads are pass-through snapshots or third-party shapes.
- `get_forward_sma_returns` (`forward-returns-core.ts`) is the only analysis here
  that conditions on a state and looks forward rather than back over a window.
  Its bin geometry lives in `src/lib/forward-sma-bins.ts`, shared with
  `ForwardReturnVsSmaGapChart.tsx` — the bins used to be private to that
  `"use client"` component, which a server tool cannot import, and a second copy
  would let chart and tool answer the same question differently.
- `compare_futures_ladder` (`futures-ladder-core.ts`) runs the page's whole
  ladder server-side, reusing `buildFuturesLadderPlan` and
  `runParallelFuturesStrategies` (whose `typeof Worker === "undefined"` branch is
  the server path). `hasNasdaqData` must mean "NDX covers the WHOLE range", not
  "NDX rows exist": the dual-sleeve fund walks the union of its sleeves' trading
  days and steps a sleeve only on days it has, so an 1885 start leaves the NDX
  sleeve frozen at half the fund's equity until 1971 and reports a result
  indistinguishable from the plain SPX rung. It defaults to
  `CONSTANT_SP500_SHORTCUT_DATE` like the page, not to the S&P's 1885 start.
- `stress_test_strategy` (`crisis-episodes.ts` catalog + `stress-core.ts`) runs a
  config through each named drawdown. Each episode is its OWN backtest with its
  own warm-up, not a slice of a longer run — a windowed sub-range of a
  precomputed series has to be renormalized through `window-calculations.ts` to
  keep the entry-spread contract, and re-running a two-year window is ~20ms. The
  warm-up is the point: it decides whether the rule was already out when the
  crisis opened (`startedInvested`). A test asserts every catalogued episode is a
  real 1x index drawdown, which is what would catch a wrong date.
- `optimize_strategy` (`optimize-grid.ts` pure geometry + `optimize-core.ts`
  orchestration) searches SMA period x upper x lower jointly. It is the tool the
  chunked sweep exists for — the same search used to need ~53 `compare_strategies`
  calls. It must never return a bare winner: a split-sample pass re-runs the whole
  grid on a half of history the search never saw and reports the winner's rank
  there, and the winner's one-step grid neighbourhood shows plateau vs spike.
  Both guardrails earn their keep — a 112-cell UPRO search picks SMA 125 U1/L3
  in sample, which ranks 89/112 out of sample with neighbours 149% worse, while
  out-of-sample's own best (SMA 200 U4/L3) sits near the calibrated default. The
  breadth cap counts BOTH passes, not one.
- `deep-link.ts` links a tool result back to the same run on the site, as a plain
  `permalink` field rather than an MCP `resource_link` (a client may try to
  `resources/read` an `https://` URI this server does not serve). Both builders
  return undefined rather than approximating: a custom leverage has no preset for
  the backtest page to select, and the futures page has NO leverage input — it
  runs the fixed ladder from `futures-plan.ts` in full — so only leverages that
  are actual rungs link, read from `buildFuturesLadderPlan` rather than restated.
  The canonical SMA-buffer URL keys live in `SMA_BUFFER_URL_KEYS`; use it rather
  than spelling `smatspU` and friends again.
- `letf://preset/{name}` is a `ResourceTemplate` with argument completion. Two
  completers, deliberately: the resource offers every preset, the
  `analyze_strategy` prompt offers only the simulated ones, because
  `run_backtest` rejects the `-real` series and completing one there could only
  produce a tool error. MCP completion covers prompt and resource arguments
  only — there is no such thing for tool arguments.
- MCP progress (`progress.ts`) is opt-in — no `progressToken` on the request
  means no reporter is built. Reports are fire-and-forget, monotonic, and
  clamped to [0,1] with `total:1`; a failed notification must never fail a tool.
  `runParallelVariants`' own `onProgress` is typed for the compare-letfs page's
  `(done, total)` progress bar, NOT the engine's `(fraction, label)` — that is
  why `sweep-core.ts`'s per-window pass calls `runParallelSimulations`
  (mode `variants`) directly.
- `get_precomputed_analysis` (`snapshot-core.ts`) serves
  `src/lib/tool-snapshots/*.json`, which embed full daily series (backtesting
  ~1.8MB, futures ~6MB) — always distil, never return `pageState` raw. Those
  snapshots are generated with history wrap ENABLED while every MCP tool runs
  `historyWrap:false`, so their best/worst window dates can sit in the future;
  the tool attaches a caveat saying so and it must stay attached.
  `MAX_SNAPSHOT_SIZE_BYTES` in `generate-snapshots.ts` budgets what a visitor
  downloads with a page's canned default; a page over it FAILS the run and keeps
  the file already on disk. It used to delete that file and exit 0, so the
  monthly build committed the deletion and the page lost its default silently.
- `unit-tests/mcp-discovery.test.ts` pins `public/.well-known/mcp.json` and
  `public/llms.txt` to `register.ts`, so adding a tool fails the suite until
  both discovery documents list it.
- Every `/mcp` request logs one line (`[mcp] tool=... ms=... status=...`) from
  `request-info.ts`. A Request body can only be read once, so the route parses
  the tool names there and passes them to `enforceMcpRateLimit` rather than each
  cloning its own copy.
- `MCP_HEAVY_TOOLS` (the strict per-IP budget) is hand-maintained, and
  `unit-tests/mcp-heavy-classification.test.ts` enforces it by reading the tool
  sources: any tool importing a sweeping engine core (`sweep-core`,
  `optimize-core`, `buffer-grid-core`, `letf-compare-core`) must be in the set.
  This exists because `optimize_strategy` — the most expensive tool here — first
  shipped on the light 120/min budget.
- The endpoint is rate-limited in `rate-limit.ts` (Upstash-backed when the
  `UPSTASH_REDIS_REST_*` env vars are set, per-instance in-memory otherwise);
  a global per-IP budget plus a stricter one for `MCP_HEAVY_TOOLS`. The route
  handler in `[transport]/route.ts` calls `enforceMcpRateLimit` before the MCP
  handler. Two things that are easy to get wrong: the in-memory fallback engages
  on ANY Redis error (not just missing config) and so needs its expiry sweep and
  size cap to stay bounded; and the client IP must never come from the *leftmost*
  `x-forwarded-for` entry, which is caller-controlled and makes every per-IP
  budget resettable — prefer `x-vercel-forwarded-for`, then `x-real-ip`, then the
  rightmost XFF entry.
- `toolError` (`tool-result.ts`) surfaces the message only for `McpToolError`;
  everything else is logged server-side and reported generically. The endpoint is
  unauthenticated, and a raw `Error.message` leaks absolute `/var/task/...` paths
  and bundle layout. Throw `McpToolError` for anything a caller should read.
- A tool that fans out to a third party needs a timeout AND an in-process cache,
  and probably belongs in `MCP_HEAVY_TOOLS` even if it is not engine-heavy:
  `get_box_spread_apy` issues one upstream request *per SPX expiry*, so on the
  light budget it turned each inbound call into 10-30 outbound ones from our
  egress IPs.
- Discovery for agents: `public/llms.txt`, `public/robots.txt`, and
  `public/.well-known/mcp.json` advertise the `/mcp` endpoint. Keep the tool
  list in `.well-known/mcp.json` in sync with `register.ts`.
- `next.config.ts` `outputFileTracingIncludes` must include the `/[transport]`
  route (alongside `/api/**/*`) so the CSV data and calibration snapshot are
  bundled into the MCP function on Vercel.

## SMA calibration: why it is two scripts

`src/lib/simulation/score.ts` uses ONE formula for SPX and NDX: real rolling
CAGR and worst returns, drawdown penalties, and a smooth two-sided switching
penalty. Each exit or re-entry is one switch. The preferred frequency is
0.3/year; its penalty is `19500 * max(0, 1 - frequency / 0.3)^2` below the
target and `200 * max(0, frequency - 0.3)^2` above it, plus the existing
heavy churn penalties above one switch/year. This balances return against
limited evidence, not a rank by trade count. It is a scoring preference, not
statistical confidence: overlapping rolling windows do not create independent
trades. Do not introduce index-specific formulas, parameter-specific bonuses,
or an evidence surcharge in addition to the smooth sparse penalty.
The engine regression through 2026-10-09 pins the user's reference order:
NDX 136/−18%/+9.6% (10 switches), 126/−17.9%/+19.4% (6), then
200/−11.8%/+5% (16), each adjacent stable-score lead below 2%.
It also pins the preceding six SPX rules' relative order. A subsequent search
may discover stronger rules; do not force these three into preset positions.
Changing its strength or target requires regenerating search seeds and calibration.
Before manual recalibration/search, refresh market data with `npm run fetch-data`
and use the latest complete shared trading day rather than a stale snapshot end.
Use `npm run refresh-sma` for the combined SPX/NDX refresh: it has a 55-minute
hard ceiling, including data refresh and canned tool results. It re-scores all
saved period seeds under the current formula instead of automatically repeating
the exhaustive coarse grid. The artifact records `searchMode` to distinguish
a seed re-score from a new coarse-grid exploration. Calibration has a 15-minute
watchdog; on timeout the preset search re-scores the saved bands itself.
`explore-sma-cagr` has a shared 15-minute optional-refinement budget, divided
between indices, and records when that budget stops the search. Only candidates
with complete immediate stability neighborhoods may become presets. Establish
four positive, distinct, fully checked rules before optional refinement, choosing
fallback seeds by score rather than ascending period. A zero-minute budget
finalizes this checked pool. Worker process groups are stopped on timeouts and
interruptions. Exhaustive `explore-sma` is a separate, potentially long operation;
do not invoke it automatically or bypass the combined ceiling unless the user
explicitly authorizes a longer search. Budget-limited presets are the best fully
checked candidates found, not a claim of exhaustive convergence.
The standalone npm calibration/exploration commands also have process-group
watchdogs, capped at 55 minutes (preset refinement normally has a 20-minute
watchdog around its 15-minute soft budget). A coarse exploration that times out
keeps the existing seed artifact; `refresh-sma` is the path that finalizes useful
results within the combined budget.

The shipped SMA band (`src/lib/tool-snapshots/sma-calibration.json`, applied by
the Signals page and the push-alert cron) comes from a JOINT search over
period x upper buffer x lower buffer, scored over SEVERAL date ranges at once.

Joint, because the best buffer is strongly period-dependent — SPX wants ~3%
near 185d but ~9-15% near 40d — so sweeping the period at one fixed buffer and
then the buffer at that period is coordinate descent on a surface with no
reason to be separable. That is what `calibrate-sma.ts` used to do, and the
fixed starting buffer, not the data, decided which basin it landed in: it
shipped NDX 150d -17.6%/+20.4% while 131d -18%/+20% scored ~9% higher.

Multi-era, because one range picks a rule for one regime. See
`src/lib/simulation/sma-calibration-eras.ts` for the ranges and weights (they
start at the tool pages' own date presets, so any band can be checked by hand).
The modern ranges contain no 1929-32 and no 1973-74, so the combos that top
them are short-SMA rules that ride those crashes down 88-95%, and the score's
`(maxDrawdown - 80)^4` capitulation term then detonates on an older range: a
`start`-only search returned SPX 32d -6.1%/+7.9%, worth 8,802 on `start` and
-4,354 on the full history. Because that term is already unbounded below, a
plain weighted sum of RAW per-era scores is the whole "must not be terrible
anywhere" rule. Never normalise per-era scores before combining — min-max or
z-scoring rescales a -51,721 wipeout into merely "the worst candidate" and
discards exactly the signal the eras were added to carry.

The eras are DISJOINT — each `endDate` is the next era's `startDate`, and only
the live era runs to today. They used to be nested (every era ran to today), so
the modern data was counted in all of them and a weight did not mean what it
said: under the old nested NDX 2:8 only 167 of proto's 668 windows began before
1985, leaving that segment an effective ~0.5/10. A closed era also runs with
history wrap OFF: wrap extends the final windows past the end of DATA, but
inside a closed era the continuation is real — it is the next era — so wrapping
would fabricate a tail over data that exists. Only the live era keeps wrap, and
its synthetic windows are why it has more windows than its span implies.

A full joint grid is far too slow for the monthly Vercel build, so the work is
split across two scripts that MUST score a combo identically — both go through
`scripts/lib/sma-sweep-context.ts`, and the parameter box is
`src/lib/simulation/sma-search-bounds.ts`. Neither may grow a second copy. Those are BASE scores; the calibrator then
applies the fine-grid stability objective below to its proposed candidates.

- `npm run explore-sma` (`explore-sma-space.ts`) is the expensive half: every
  period against every buffer cell, each scored on every era, forked across
  cores. It writes `sma-search-space.json`, whose payload is a PER-PERIOD
  buffer seed — the best (upper, lower) at each period. Run it by hand when the
  score function, the era weights, the trading-cost model or the risk-off
  default changes, never on a schedule; `unit-tests/sma-calibration-artifacts.test.ts`
  fails when the committed seeds were generated under different era weights.
  `sma-known-seeds.ts` re-scores prior seeds and the saved band after the grid
  pass so a coarser refresh cannot discard a better fractional-buffer candidate.
  Its `--buffer-step` is the cost dial (2% ~ 30 min, 1% ~ 2 h) and must stay at
  or below the calibrator's `BASIN_BUFFER_HALF_WIDTH`, which is what re-searches
  around each seed.
- `npm run calibrate-sma` is the monthly half (a few minutes/index including
  complete stability neighborhoods, inside the Vercel
  build on the first Monday). It reads those seeds and does a real joint search:
  score every period at its seed, open up the best few *separated* periods over
  a buffer square, re-search the period axis around the leaders, refine buffers
  to 0.1%.

The split works because the surface is spiky along the period axis (NDX 105d
beats 110d by 2.5x) but smooth in the buffer plane at a fixed period, and it is
the buffer plane that is expensive. Step 1 still visits EVERY period, so a
stale seed costs accuracy at one period rather than hiding a basin — which is
what lets the expensive run stay a one-off. With no snapshot at all a bounded
coarse scan stands in, so a missing artifact costs a minute, not an hour.

`src/lib/simulation/defaults.ts` imports the calibration JSON directly for its
asymmetric band (`getDefaultSmaUpperBuffer` / `getDefaultSmaLowerBuffer`), so
new input defaults and omitted MCP parameters follow the same snapshot as
calibrated push alerts. The monthly build rewrites the snapshot before bundling;
do not reintroduce a separate literal band. `defaults.test.ts` checks agreement.
Upper and lower remain independent fields even when calibration happens to
choose equal numbers (SPX 175d, 3.6% on both sides under half-gap scoring).
There is no `getDefaultSmaBuffer`: feeding one default to both sides is the
futures-ladder bug above waiting to happen.

The Signals page's saved `signals-use-calibrated-defaults` preference is for
push alerts only. `SmaPushAlertsCard` applies the calibration snapshot when it
builds an alert subscription; loading that preference or the snapshot must not
replace the page's shared SMA inputs. "Set default" explicitly applies the
latest scored calibration. Five Signals alternatives are selected from the
multi-era per-period search seeds, refined jointly over one-day periods and
0.1 percentage-point buffer steps, with the same raw era weights and complete
±1-day/±0.1% stability neighborhoods as calibration. Keep pre-1988 SPX and
pre-1985 NDX in selection: a modern-only CAGR winner can fail those eras badly.
Both indices are scored, displayed and verified WITH the volatility risk-off
gate (`SMA_CALIBRATION_VOL_GATE`, `vol-gate.ts`), because the gate ships on by
default. Ungated, NDX ranks 182/−18.1%/+6.9% first; gated, 115/−20%/+16% wins
by a wide margin, so flipping that flag reorders the whole NDX preset set.
Gate parameters are PER INDEX (`SMA_VOL_GATE[index]`), resolved from
`smaIndex` wherever signals are generated; one UI switch turns both on, so the
switch itself never shows parameters. Both currently share 11d 49%/31%: a
window x exit x re-entry grid for SPX, ranked by the worst one-step neighbour,
found nothing stably better (best robust cell within 0.5% of the score;
5d/54%/12% peaked, then lost ~27% one step away). Labels collapse to one set
when they match (`volGateParamsTextFor`). They are constants, not searched by
the monthly calibration; re-pick them only alongside a band re-search. A
gate-only rule (no SMA exits) loses badly on both indices in the
pre-1988/1985 eras.
Every era score also pays shape penalties (`smaScorePenaltyFraction`,
`sma-search-bounds.ts`), both general rules rather than per-rule exceptions:
- Re-entry (`SMA_REENTRY_PENALTY`): an upper buffer that only a steep steady
 climb reaches. History's recoveries were mostly V-shaped, so unpenalized NDX
 picked 107d +16.4% (needs ~106%/yr; sat out 1987–1991 while NDX rose 41%).
- Long period (`SMA_LONG_PERIOD_PENALTY`): 1% per 5 days beyond 200. Under
 some SPX gates 262/−2.3%/+3.4% otherwise outscored 175/−3.6%/+3.6% on a
 handful of slow, well-timed exits.
Keep one default and three alternatives per index. The calibrated default stays first. Alternatives in `sma-cagr-presets.json`
rank each index by descending stability-adjusted weighted multi-era score and
pair the SPX/NDX rules by rank through `sma-preset-ranking.ts`. CAGR is only a
comparison metric: re-sorting by modern sleeve or portfolio CAGR promoted the
weakest NDX rule despite its terrible proto era. Preserve the score order through
selection, pairing and display. Refresh with `npm run explore-sma-cagr`; reorder
saved selections without searching via `npm run explore-sma-cagr -- --rerank-presets`.
The manual search must visit all 231 integer periods (50–280; shorter SMAs are excluded), both at their
per-period seeds and at each saved fine buffer pair: restricting to five-day
periods missed NDX 177/−12.1%/+7.8%, which beats the saved 150-day rule on the
stable score. Refine separated basins over ±5 days and both buffers, then walk
joint one-day/0.1% neighborhoods and rescan each leading buffer pair at every
integer period until leaders stop improving. Reuse temporary
score checkpoints only for matching scoring code/data. `bestFound` records feed
the monthly calibrator alongside prior defaults/alternatives so discoveries
are rescored and shared defaults cannot silently revert to a narrower search.
The manual search promotes its strongest stable discovery into the same
`sma-calibration.json` used by defaults/alerts, retaining the prior band on score
ties. Both search scripts publish through `scripts/lib/sma-calibration-result.ts`.
Signals preset buttons apply only their own index, so SPX and NDX can be mixed
independently. Keep the compact stats in proxy-before-proto order; scores and
methodology prose are not displayed. Each button shares its stats row and the
text wraps after it at every width — never a horizontal scroll.
Desktop pairs each rank in two columns matching the controls: SPX left, NDX right.
Displayed NDX real CAGR and switches use a separate 1985-01-31 launch backtest,
so the modern period begins exactly where proto ends. Store real-return dates
explicitly as `realCagrStartDate`/`realCagrEndDate` and count dates as `switchHistory`.
The nominal `cagr`/`finalMultiple`/`trades` fields and distinct-regime comparison
use that same per-index start: 1988 for SPX, 1985 for NDX. Verify the entire
displayed range against the engine, never mix modern metrics from different starts.
Count only SMA switches, excluding initial establishment and terminal liquidation.
NDX 125/−17.9%/+19.4% has six switches since launch through 2026-10-09,
five since 1988; do not attach that count to a different calibrated default.
The search retains distinct trade regimes against the calibrated default and
centers tied stable-score plateaus. After stability scoring, a plateau center
must not displace a higher stable score (the monthly calibrator follows this
same ordering). The UI shows per-index inflation-adjusted whole-era CAGRs (SPX proto/proxy, NDX proto)
alongside default-window CAGRs; NDX has no proxy era. Each era is independently
backtested with warm-up and that index's `DEFAULT_RISK_OFF_ASSETS` entry (the
basket a visitor's backtest holds, recorded as `cagrRiskOffAssets`), without
history wrap. The search itself still scores on `DEFAULT_RISK_OFF_ASSET`.
Real CAGR deflates the ending multiple by `cpiIndexRatioEndOverStart` before
annualizing over the actual backtest dates; do not subtract annual inflation
from nominal CAGR. Preserve nominal CAGR for engine parity and disclose the
last CPI observation used (which can precede the market-data end date).
There is no combined 50/50 ranking metric. Refresh only the displayed
historical CAGRs with `npm run explore-sma-cagr -- --refresh-era-cagrs`.

The asymmetric SMA-buffer heatmap uses `pickTopCell` to highlight a stable
plateau-center band. That selection must not override `SweepComparisonTable`'s
numeric Score sort: when Score is descending, the highest score is the first
table row. The buffer tool's default Max SMA Buffer and its input `max` are 21.

Two things that look like details and are not:

- Pick top-N periods with `pickTopDistinctPeriods`, not a plain top-N. Because
  the surface is spiky, a plain top-N is N adjacent points on one spike and the
  next stage then refines one basin N times.
- **Never ship the argmax.** The surface is spiky, and the top point routinely
  sits one step from a cliff: NDX 125, 126 and 127 all scored 18,050 while 128
  scored 8,780, so reporting 127 put the rule one step from a 2.1x drop for no
  gain over 126. `src/lib/simulation/plateau.ts` takes the points within
  `PLATEAU_TOLERANCE` of the best, keeps the CONNECTED region containing it,
  and returns the member nearest that region's centre. Connectivity is the part
  that matters — a centroid taken across two same-height basins lands in the
  valley between them, in neither. The calibrator flood-fills the region by
  evaluating outward from its leader; the sweep pages already hold a dense grid
  and just hand their rows over. The calibrator then ranks proposed bands by
  `baseScore - 0.5 * max(0, baseScore - worstImmediateNeighborBaseScore - 0.05 * max(0, baseScore))`
  through `rankStableSmaCandidates` (`sma-stability-score.ts`).
  Small neighbor drops up to 5% of a positive base score are tolerated; larger
  drops retain the half-loss penalty. This shared rule lets higher raw scores
  win on reasonably stable neighborhoods without rewarding severe cliffs.
  It evaluates complete,
  unique neighborhoods (±1 day and ±0.1% on both buffer axes); missing engine
  results fail calibration rather than making a band look safe. Base score is
  an upper bound, so candidates below the center's proven stable score need
  no neighbor runs. Preserve the selected default on an exact highest stable-score
  tie; otherwise prefer the raw plateau center when it ties. This never raises
  a lower-scoring saved band above a stronger candidate. The selected NDX
  default is 182/−18.1%/+6.9%, one of the equally highest raw/stable-score bands
  through 2026-10-09. Never reintroduce the known-band override: it chose NDX 127 over the
  stable 125 center despite 127's worst neighbor losing 61% of the score.
  The snapshot records `baseScore`, `stabilityPenalty` and final `score`
  separately; era scores and exhaustive seeds remain base scores.
- That module is shared on purpose: `getBestSweepRow` (1-D period/buffer
  sweeps), `pickTopCell` (the 2-D asymmetric buffer grid) and `calibrate-sma`
  (3-D) all call it, so the band a page highlights and the band the calibration
  ships follow the same plateau geometry, with the calibrator stability ranking
  above.
  Its tie-breaks compare coordinates NUMERICALLY — a string compare of joined
  coords orders "10" before "9" — and the peak itself is tie-broken on
  coordinates so a plateau never depends on the caller's array order.
- `summarizePlateau` separately records `neighborhoodMinScore` /
  `neighborhoodMedianScore` for the shipped band. Half the downward gap is
  deducted from the base score; a winner whose neighbors collapse is fitted
  to this sample,
  and the same in-sample spike is what `optimize_strategy`'s split-sample
  guardrail exists to catch.

## Sweep breadth: what actually bounds it

Breadth was capped at a flat 24 configs on the theory that the 300s function
timeout bound it. It does not: 24 configs over full history (1,572 monthly-stepped
rolling windows) runs in ~0.7s, 1,000 in ~37s. **Memory** was the real ceiling,
from two independent sources, and both had to be fixed:

- `runParallelSimulations` precomputes a full daily-value series per config and
  holds every one for the life of the call. `sweep-core.ts` now runs the config
  list in chunks of `SWEEP_CHUNK_SIZE` (`sweep-chunking.ts`), loading market data
  once and re-entering the engine per chunk (~50ms setup each).
- `sma.ts`'s `smaCache` / `signalCache` are WeakMaps keyed on the *price series*,
  whose inner Maps were unbounded and keyed by SMA parameters. Since the price
  series stays alive for a whole sweep, those grew once per distinct config, each
  entry retaining a full-length array — a leak per *config*, which chunking alone
  cannot reach. They are LRU-bounded via `bounded-cache.ts`. Any new
  parameter-keyed memo under a long-lived WeakMap key needs the same treatment.

Measured at a 512MB heap: chunked+bounded is flat at ~670-700MB RSS for 400,
1,000 and 2,000 configs (2,000 in ~64s); unchunked OOMs at 1,000. Rolling windows
step monthly (`CONSTANT_STEP_MONTHS`), so the window count is bounded (~1,690 even
at the 1-year minimum) — that bound is what makes `estimateSweepMs` trustworthy.

When chunking, stamp `paramValues` from the **whole** config list before slicing.
Rows are joined on `row.parameterValue` (never array index — see the rule above),
so a chunk-local restamp makes later chunks overwrite earlier ones.
`unit-tests/mcp-sweep-chunked.test.ts` pins chunked output as bit-identical to a
single pass.

## Maintaining this file

`CLAUDE.md` is a symlink to this file — edit `AGENTS.md` directly; tools that
refuse to write through symlinks will fail on the `CLAUDE.md` path.

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
