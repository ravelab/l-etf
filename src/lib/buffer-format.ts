// Shared formatting for SMA buffer percentages so the input fields, run
// summary, and signals page all render the same way.

const MINUS = "−"; // U+2212 MINUS SIGN, matches the buffer input UI.

/**
 * Format a single buffer percent, trimming trailing zeros and capping at two
 * fractional digits. e.g. `3.3` → `"3.3%"`, `3` → `"3%"`.
 */
export function formatBufferPercent(value: number): string {
  if (!Number.isFinite(value)) return "0%";
  const rounded = Math.round(value * 100) / 100;
  return `${rounded}%`;
}

/** Lower (below-SMA) buffer with a leading minus sign, e.g. `3.3` → `"−3.3%"`. */
export function formatLowerBuffer(value: number): string {
  return `${MINUS}${formatBufferPercent(value)}`;
}

/**
 * Compact one-line SMA summary, e.g. `formatSmaSummary("SPX", 186, 3.3, 3)`
 * → `"SPX: 186/−3.3%/3%"`.
 */
export function formatSmaSummary(
  index: string,
  period: number,
  lowerBuffer: number,
  upperBuffer: number,
): string {
  return `${index}: ${period}/${formatLowerBuffer(lowerBuffer)}/${formatBufferPercent(upperBuffer)}`;
}
