// Compute guardrails for the heavy (rolling-window / sweep) MCP tools. These
// tools run the single-threaded engine inside one serverless invocation, so we
// bound their breadth to stay well under the function timeout and keep payloads
// small.

export const MAX_SWEEP_CONFIGS = 24;
export const MIN_WINDOW_YEARS = 1;
export const MAX_WINDOW_YEARS = 50;

// Upper bound on the SMA-period sweep breadth (count = (max-min)/step + 1).
export const MAX_SMA_PERIOD_STEPS = 24;

// Upper bound on the symmetric-buffer sweep breadth.
export const MAX_BUFFER_STEPS = 24;

// Upper bound on the 2-D (upper, lower) buffer grid, in cells. Kept under
// MAX_SWEEP_CONFIGS so a grid plus its baseline costs no more engine time than
// any other sweep mode; agents refine a promising region with a second, finer
// call rather than one huge grid (the same coarse→fine flow the page uses).
export const MAX_BUFFER_GRID_CELLS = 20;

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
  // Not engine-heavy, but each call fans out one upstream request per SPX
  // expiry to a third party, so it belongs on the strict budget.
  "get_box_spread_apy",
]);
