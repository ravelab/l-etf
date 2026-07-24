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

// Max number of distinct holding-period window lengths per call.
export const MAX_HOLDING_PERIODS = 12;

// Rate limiting (per client IP, fixed window). Global limit guards the whole
// endpoint; the heavy limit throttles the compute-intensive sweep tools.
export const MCP_RL_WINDOW_SEC = 60;
export const MCP_RL_GLOBAL_LIMIT = 120;
export const MCP_RL_HEAVY_LIMIT = 20;

// Tools whose single call runs a full rolling-window sweep.
export const MCP_HEAVY_TOOLS = new Set<string>([
  "run_rolling_window_analysis",
  "compare_strategies",
]);
