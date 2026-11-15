// Rewrites the calibrated SWAP_SPREAD_MODEL literal inside the engine's source.
// `npm run calibrate` ships its coefficients this way, so the markers below must
// match `src/lib/simulation/swap-spread.ts` exactly; a unit test pins them.

import type { SwapSpreadModel } from "../../src/lib/simulation/swap-spread";

export const SWAP_SPREAD_SOURCE_PATH = ["src", "lib", "simulation", "swap-spread.ts"] as const;
const SWAP_SPREAD_MODEL_START_MARKER =
  "let SWAP_SPREAD_MODEL: Record<string, Record<number, SwapSpreadModel>> = {";
const SWAP_SPREAD_MODEL_END_MARKER = "const DEFAULT_SWAP_MODEL";

function etfNameFor(index: string, leverage: number): string {
  if (index === "sp500") return leverage === 2 ? "SSO" : "UPRO";
  return leverage === 2 ? "QLD" : "TQQQ";
}

function renderModelLiteral(results: Record<string, Record<number, SwapSpreadModel>>, calibrationDate: string): string {
  const lines = [SWAP_SPREAD_MODEL_START_MARKER];
  for (const [index, leverageMap] of Object.entries(results)) {
    const indexComment = index === "sp500" ? "S&P 500" : "Nasdaq 100";
    lines.push(`  // ${indexComment} - calibrated ${calibrationDate}`, `  ${index}: {`);
    const sortedLevers = Object.keys(leverageMap).map(Number).sort((a, b) => a - b);
    for (const leverage of sortedLevers) {
      const m = leverageMap[leverage];
      lines.push(
        `    // ${etfNameFor(index, leverage)} (${leverage}x)`,
        `    ${leverage}: { rateSensitivity: ${m.rateSensitivity.toFixed(6)}, baseSpread: ${m.baseSpread.toFixed(6)} },`
      );
    }
    lines.push("  },");
  }
  lines.push("};");
  return lines.join("\n");
}

/**
 * `source` with its SWAP_SPREAD_MODEL literal replaced by `results`.
 * Throws when the markers are missing, so a moved or renamed model fails the
 * calibration run instead of silently shipping the old coefficients.
 */
export function replaceSwapSpreadModelLiteral(
  source: string,
  results: Record<string, Record<number, SwapSpreadModel>>,
  calibrationDate: string
): string {
  const startIndex = source.indexOf(SWAP_SPREAD_MODEL_START_MARKER);
  const endIndex = startIndex === -1 ? -1 : source.indexOf(SWAP_SPREAD_MODEL_END_MARKER, startIndex);
  if (startIndex === -1 || endIndex === -1) {
    throw new Error(`Could not find SWAP_SPREAD_MODEL in ${SWAP_SPREAD_SOURCE_PATH.join("/")}`);
  }

  const closingBraceIndex = source.lastIndexOf("};", endIndex);
  if (closingBraceIndex < startIndex) {
    throw new Error("Could not find closing brace for SWAP_SPREAD_MODEL");
  }

  return source.substring(0, startIndex)
    + renderModelLiteral(results, calibrationDate)
    + source.substring(closingBraceIndex + 2);
}
