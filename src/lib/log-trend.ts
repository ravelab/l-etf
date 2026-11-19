const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

export type LogTrend = {
  /** The fitted value at each input point; a straight line on a log axis. */
  values: number[];
  /** The fit's slope as a compound rate per year (0.25 = +25%/yr). */
  annualGrowth: number;
};

/**
 * Least-squares line through ln(value) against time: the constant growth rate
 * that best fits the path, which a log axis draws as a straight line. Points with
 * a non-positive value are skipped. Null with fewer than two usable points or no
 * time spread.
 */
export function fitLogTrend(times: readonly number[], values: readonly number[]): LogTrend | null {
  let n = 0;
  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumXY = 0;
  const t0 = times[0] ?? 0;
  for (let k = 0; k < times.length; k++) {
    const value = values[k];
    if (!(value > 0) || !Number.isFinite(times[k])) continue;
    const x = (times[k] - t0) / MS_PER_YEAR;
    const y = Math.log(value);
    n += 1;
    sumX += x;
    sumY += y;
    sumXX += x * x;
    sumXY += x * y;
  }
  const spread = n * sumXX - sumX * sumX;
  if (n < 2 || !(spread > 0)) return null;
  const slope = (n * sumXY - sumX * sumY) / spread;
  const intercept = (sumY - slope * sumX) / n;
  return {
    values: times.map((time) => Math.exp(intercept + slope * ((time - t0) / MS_PER_YEAR))),
    annualGrowth: Math.exp(slope) - 1,
  };
}
