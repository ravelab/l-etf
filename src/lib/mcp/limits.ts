// Compute guardrails for the heavy (rolling-window / sweep) MCP tools.
//
// These tools run the single-threaded engine inside one serverless invocation.
// Breadth used to be a flat 24 configs everywhere, on the theory that the 300 s
// function timeout was the binding constraint. Measured against the real engine
// over full history, 24 configs takes ~0.7 s — the true constraint was retained
// heap, since the engine holds a full daily series per config for the life of
// one call. `sweep-chunking.ts` now keeps that flat, so the rolling-sweep path
// is bounded by the time budget in `compute-budget.ts` and the structural caps
// below, which exist to keep response payloads sane rather than to dodge a
// timeout.

import { MCP_SWEEP_BUDGET_MS, maxConfigsInBudget } from "@/lib/mcp/compute-budget";

/**
 * Breadth cap for the tools that take an explicit list of presets
 * (`compare_backtests`, `compare_letfs`). These run `runParallelBacktest` /
 * `runParallelVariants`, which are NOT chunked and so still hold every config's
 * series at once — this cap stays where it was.
 */
export const MAX_COMPARE_PRESETS = 24;

export const MIN_WINDOW_YEARS = 1;
export const MAX_WINDOW_YEARS = 50;

/**
 * Rolling windows step monthly (`CONSTANT_STEP_MONTHS`), not daily, so the
 * count is bounded by the months of available history (~141 years) minus the
 * holding period — even at the 1-year minimum. That bound is what makes the
 * cost estimate in `compute-budget.ts` trustworthy.
 */
const MAX_ROLLING_WINDOWS = 1690;

/**
 * Breadth cap for the chunked rolling-window sweep (`compare_strategies`).
 * Structural: 400 rows is already a large tool payload, and a caller wanting
 * more should narrow its range or refine coarse→fine. The budget term is a
 * backstop so the cap can never quietly exceed what one invocation can finish.
 */
export const MAX_ROLLING_SWEEP_CONFIGS = Math.min(
  400,
  maxConfigsInBudget(MAX_ROLLING_WINDOWS, MCP_SWEEP_BUDGET_MS),
);

// Upper bound on the SMA-period sweep breadth (count = (max-min)/step + 1).
export const MAX_SMA_PERIOD_STEPS = 240;

// Upper bound on the symmetric-buffer sweep breadth.
export const MAX_BUFFER_STEPS = 240;

// Upper bound on the 2-D (upper, lower) buffer grid, in cells. Each grid also
// carries a no-SMA baseline config, so this stays below
// MAX_ROLLING_SWEEP_CONFIGS with room for it.
export const MAX_BUFFER_GRID_CELLS = 384;

// Max raw rolling-window rows returned when a caller opts into the per-window
// distribution. Windows overlap daily, so a long range yields thousands; past
// this the rows are strided (the statistics still cover every window).
export const MAX_RETURNED_WINDOWS = 400;

// Max per-day rows returned by `get_sma_signal_history`'s opt-in series
// (strided past this, so a decade of daily bars stays a bounded payload).
export const MAX_SIGNAL_SERIES_ROWS = 1000;

// Max number of distinct holding-period window lengths per call.
export const MAX_HOLDING_PERIODS = 12;

// Rate limiting (per client IP, fixed window). Global limit guards the whole
// endpoint; the heavy limit throttles the compute-intensive sweep tools.
export const MCP_RL_WINDOW_SEC = 60;
export const MCP_RL_GLOBAL_LIMIT = 120;
export const MCP_RL_HEAVY_LIMIT = 20;

// Tools whose single call runs a full rolling-window sweep.
// `run_holding_period_analysis` runs one sweep per requested holding period,
// and doubles that when `includePercentiles` asks for the per-window pass, so
// it belongs on the strict budget alongside the single-sweep tools.
export const MCP_HEAVY_TOOLS = new Set<string>([
  "run_rolling_window_analysis",
  "run_holding_period_analysis",
  "compare_strategies",
  "compare_letfs",
  // The most expensive tool here: a joint grid search, evaluated twice when the
  // split-sample check is on, so up to MAX_ROLLING_SWEEP_CONFIGS simulations.
  "optimize_strategy",
  // Not engine-heavy, but each call fans out one upstream request per SPX
  // expiry to a third party, so it belongs on the strict budget.
  "get_box_spread_apy",
]);
