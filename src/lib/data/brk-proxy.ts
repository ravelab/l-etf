/**
 * The BRK.B risk-off proxy before real BRK-A starts (1980-03-17): 70% equity + 30%
 * VGSH, rebalanced daily. The equity leg is Fama-French large value from 1926-07-01
 * (data/index-fflargevalue.csv, scripts/build-brk-proxy.py) and the S&P series
 * before that, where no large-value data exists; the same 70% keeps the proxy's
 * market exposure at Berkshire's ~0.7 on both sides of the 1926 seam.
 *
 * Against real BRK-A over 1980-2026, 70/30 large value matches Berkshire's market
 * beta (0.70 vs 0.71) and worst drawdown (-51.3% vs -51.5%) and trends like it
 * (20/60-day variance ratios 0.86/0.83 vs 0.90/0.89). The 50% S&P / 50% VGSH blend
 * it replaced had beta 0.49 and 8.8% volatility against BRK's 22.4%. No portfolio
 * reproduces a single stock's own volatility; the blend's 14.4% is the honest part.
 */
export const BRK_PROXY_EQUITY_WEIGHT = 0.7;

function normalizeDate(date: string): string {
  // VGSH's pre-2009 rows are monthly and dated YYYY-MM; they mark the 1st.
  return date.length === 7 ? `${date}-01` : date;
}

const DAY_MS = 86_400_000;

/**
 * Log level on any date from a sparse series, interpolated linearly in calendar days
 * between rows, and held flat before the first and after the last.
 */
export function logLevelInterpolator(rows: Array<{ date: string; adj_close: number }>): (date: string) => number | null {
  const points = rows
    .filter((row) => Number.isFinite(row.adj_close) && row.adj_close > 0)
    .map((row) => ({ time: Date.parse(`${normalizeDate(row.date)}T00:00:00Z`), log: Math.log(row.adj_close) }))
    .sort((a, b) => a.time - b.time);
  return (date: string) => {
    if (points.length === 0) return null;
    const time = Date.parse(`${date}T00:00:00Z`);
    let lo = 0;
    let hi = points.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (points[mid].time < time) lo = mid + 1;
      else hi = mid;
    }
    if (lo < points.length && points[lo].time === time) return points[lo].log;
    if (lo === 0) return points[0].log;
    if (lo >= points.length) return points[points.length - 1].log;
    const left = points[lo - 1];
    const right = points[lo];
    const frac = Math.round((time - left.time) / DAY_MS) / Math.round((right.time - left.time) / DAY_MS);
    return left.log + (right.log - left.log) * frac;
  };
}

/**
 * Blend levels on `dates` (ascending sessions), starting at 100. Each step takes
 * large value's return when it has both sessions, else the S&P's, weighted by
 * BRK_PROXY_EQUITY_WEIGHT, with the rest in Treasuries.
 * `equity` records which leg drove each row's return (the first row has none,
 * and is tagged with the S&P).
 */
export function buildBrkProxyLevels(params: {
  dates: string[];
  sp500: Map<string, number>;
  largeValue: Map<string, number>;
  treasuryLogLevel: (date: string) => number | null;
}): Array<{ date: string; close: number; equity: "sp500" | "largeValue" }> {
  const { dates, sp500, largeValue, treasuryLogLevel } = params;
  const out: Array<{ date: string; close: number; equity: "sp500" | "largeValue" }> = [];
  let level = 100;
  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    if (i === 0) {
      out.push({ date, close: level, equity: "sp500" });
      continue;
    }
    const prev = dates[i - 1];
    const lvPrev = largeValue.get(prev);
    const lvCurr = largeValue.get(date);
    const spPrev = sp500.get(prev);
    const spCurr = sp500.get(date);
    let equityReturn: number;
    let equity: "sp500" | "largeValue";
    if (lvPrev! > 0 && lvCurr! > 0) {
      equityReturn = lvCurr! / lvPrev! - 1;
      equity = "largeValue";
    } else if (spPrev! > 0 && spCurr! > 0) {
      equityReturn = spCurr! / spPrev! - 1;
      equity = "sp500";
    } else {
      throw new Error(`brk-proxy: no equity return for ${date}`);
    }
    const tPrev = treasuryLogLevel(prev);
    const tCurr = treasuryLogLevel(date);
    const treasuryReturn = tPrev != null && tCurr != null ? Math.exp(tCurr - tPrev) - 1 : 0;
    const weight = BRK_PROXY_EQUITY_WEIGHT;
    level *= 1 + weight * equityReturn + (1 - weight) * treasuryReturn;
    out.push({ date, close: level, equity });
  }
  return out;
}
