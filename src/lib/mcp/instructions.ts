// Server instructions: injected into the client's context once per session,
// before any tool is called. This is the only place to say things an agent
// cannot read off a tool schema, so it carries the sharp edges rather than a
// restatement of what the tools already describe. It is context every session
// pays for, so keep it short and delete anything a schema already says.

import { DISCLAIMER } from "@/lib/mcp/disclaimer";

export const SERVER_INSTRUCTIONS = `l-etf runs real leveraged-ETF and index-futures backtests over long market history (S&P 500 from the 1880s, Nasdaq-100 from 1985). Call a tool rather than estimating figures from memory — every number here comes from the same engine the site's charts use.

Getting grounded:
- Read \`letf://methodology\` before interpreting results, and \`letf://data-coverage\` for how fresh the data is.
- \`get_precomputed_analysis\` serves the site's canonical runs instantly and does not consume the heavy-tool rate limit. Prefer it for common questions; re-run a live tool only for custom inputs or a like-for-like comparison (snapshots are generated with history wrap ON, unlike the live tools).

Picking a tool:
- One strategy over one range: \`run_backtest\`. What it did in specific crises: \`stress_test_strategy\`. The distribution across history: \`run_rolling_window_analysis\` or \`compare_strategies\`. Tuning parameters: \`optimize_strategy\`. Futures instead of ETFs: \`run_futures_backtest\` for one leverage, \`compare_futures_ladder\` for the whole ladder including the two-sleeve fund.

Reading results:
- An SMA config is expanded into two results, \`<id>-base\` (no SMA) and \`<id>-sma\`. Select by id; never assume the first result is the one you asked for.
- Sweeps may stop early on the compute budget. When a result says \`truncated\`, it covers only \`evaluatedConfigs\` of \`totalConfigs\` — narrow the range or widen the step rather than presenting it as complete.
- Results are nominal unless a field says otherwise. Backtests bake in expense ratios, modeled financing costs, and entry/exit spreads.

Cost and etiquette:
- The rolling-window sweep tools are compute-heavy and rate-limited per IP. Send a \`progressToken\` on those requests to receive progress notifications instead of waiting blind.
- Parameters that look best over full history are in-sample. Treat any swept optimum as a hypothesis, and say so.

${DISCLAIMER} Preserve this caveat in any summary you write from these results.`;
