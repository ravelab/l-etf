// Shared "not investment advice" disclaimer for every MCP tool that returns
// simulated performance figures. It is attached both to tool descriptions and
// to the structured payloads so that a consuming agent cannot present backtest
// output as a recommendation without also surfacing the caveat.

export const DISCLAIMER =
  "For educational and research use only. NOT investment advice. Figures are " +
  "simulated backtests over historical data; past performance does not predict " +
  "future returns. Leveraged ETFs are high-risk instruments. Consult a licensed " +
  "financial advisor before making any investment decision.";

// Short suffix appended to a tool `description` so the caveat is visible at
// tool-discovery time, not just in the output.
export const DISCLAIMER_TOOL_SUFFIX = ` ${DISCLAIMER}`;

/**
 * Attach the disclaimer to any structured payload without mutating the input.
 */
export function withDisclaimer<T extends object>(payload: T): T & { disclaimer: string } {
  return { ...payload, disclaimer: DISCLAIMER };
}
