import type { EtfResult } from "./types";

/**
 * Calculate CAGR (Compound Annual Growth Rate).
 * dates can be YYYY-MM-DD strings or pre-parsed timestamps (ms).
 */
export function calcCagr(
  startValue: number,
  endValue: number,
  startDate: string | number,
  endDate: string | number,
  nominalStartDate?: string,
  nominalEndDate?: string
): number {
  const sIso = nominalStartDate || (typeof startDate === 'string' ? startDate : null);
  const eIso = nominalEndDate || (typeof endDate === 'string' ? endDate : null);
  
  let years: number;
  if (sIso && eIso && sIso.length >= 10 && eIso.length >= 10) {
    const s = new Date(`${sIso.slice(0, 10)}T00:00:00Z`).getTime();
    const e = new Date(`${eIso.slice(0, 10)}T00:00:00Z`).getTime();
    years = (e - s) / (365.25 * 24 * 60 * 60 * 1000);
  } else {
    const startMs = typeof startDate === 'number' ? startDate : new Date(startDate).getTime();
    const endMs = typeof endDate === 'number' ? endDate : new Date(endDate).getTime();
    years = (endMs - startMs) / (365.25 * 24 * 60 * 60 * 1000);
  }
  
  if (years <= 0 || startValue <= 0) return 0;
  if (!isFinite(endValue) || !isFinite(startValue)) {
    return 0;
  }
  const result = (Math.pow(endValue / startValue, 1 / years) - 1) * 100;
  return isFinite(result) ? result : 0;
}

/**
 * Cache for max drawdown calculations.
 */
export type DrawdownMetrics = {
  pct: number;
  dollar: number;
  longestDays: number;
  maxDrawdownDates?: { start: string; end: string };
  longestDrawdownDates?: { start: string; end: string };
};

type MonthlyExtremes = {
  bestMonth: number;
  worstMonth: number;
  bestMonthDates?: { start: string; end: string };
  worstMonthDates?: { start: string; end: string };
};

const drawdownCache = new WeakMap<number[], WeakMap<string[], DrawdownMetrics>>();

/**
 * Optimized Max Drawdown calculation that works on a range of an existing array.
 * This avoids array slicing (allocation + copy) which is critical for performance
 * when processing thousands of rolling windows.
 */
function calcMaxDrawdownInRange(
  values: number[],
  dates: string[],
  startIdx: number,
  endIdx: number
): DrawdownMetrics {
  if (endIdx - startIdx < 1) return { pct: 0, dollar: 0, longestDays: 0 };
  
  let peak = values[startIdx];
  let maxDrawdownPct = 0;
  let maxDrawdownDollar = 0;
  let longestDays = 0;
  let currentDrawdownStart = 0;
  let peakIdx = startIdx;
  let maxDrawdownStartIdx = startIdx;
  let maxDrawdownEndIdx = startIdx;
  let longestDrawdownStartIdx = startIdx;
  let longestDrawdownEndIdx = startIdx;

  for (let i = startIdx + 1; i <= endIdx; i++) {
    const val = values[i];
    if (val > peak) {
      peak = val;
      peakIdx = i;
    }

    const drawdownDollar = peak - val;
    const drawdownPct = drawdownDollar / peak;

    if (drawdownPct > maxDrawdownPct) {
      maxDrawdownPct = drawdownPct;
      maxDrawdownDollar = drawdownDollar;
      maxDrawdownStartIdx = peakIdx;
      maxDrawdownEndIdx = i;
    }

    if (val < peak) {
      if (currentDrawdownStart === 0) {
        currentDrawdownStart = peakIdx;
      }
      // Simple day calculation from ISO strings to avoid new Date()
      const days = daysBetween(dates[currentDrawdownStart], dates[i]);
      if (days > longestDays) {
        longestDays = days;
        longestDrawdownStartIdx = currentDrawdownStart;
        longestDrawdownEndIdx = i;
      }
    } else {
      currentDrawdownStart = 0;
    }
  }

  return {
    pct: maxDrawdownPct * 100,
    dollar: maxDrawdownDollar,
    longestDays,
    maxDrawdownDates:
      maxDrawdownPct > 0
        ? { start: dates[maxDrawdownStartIdx], end: dates[maxDrawdownEndIdx] }
        : undefined,
    longestDrawdownDates:
      longestDays > 0
        ? { start: dates[longestDrawdownStartIdx], end: dates[longestDrawdownEndIdx] }
        : undefined,
  };
}

/**
 * Calculate max drawdown from a series of portfolio values.
 */
export function calcMaxDrawdown(
  values: number[],
  dates: string[]
): DrawdownMetrics {
  const byDates = drawdownCache.get(values);
  const cached = byDates?.get(dates);
  if (cached) return cached;
  
  const result = calcMaxDrawdownInRange(values, dates, 0, values.length - 1);
  if (byDates) {
    byDates.set(dates, result);
  } else {
    drawdownCache.set(values, new WeakMap([[dates, result]]));
  }
  return result;
}

/**
 * Cache for monthly extremes calculations.
 */
const monthlyExtremesCache = new WeakMap<number[], WeakMap<string[], MonthlyExtremes>>();

/**
 * Calculate best and worst monthly returns.
 * Returns { bestMonth, worstMonth } as percentages.
 * Results are cached by values array identity.
 */
export function calcMonthlyExtremes(
  values: number[],
  dates: string[]
): MonthlyExtremes {
  const byDates = monthlyExtremesCache.get(values);
  const cached = byDates?.get(dates);
  if (cached) return cached;

  if (values.length < 2 || dates.length < 2) {
    return { bestMonth: 0, worstMonth: 0 };
  }

  let bestMonth = -Infinity;
  let worstMonth = Infinity;
  let bestMonthDates: { start: string; end: string } | undefined;
  let worstMonthDates: { start: string; end: string } | undefined;

  // Each month's return is measured from the prior month's last value (or the
  // series start) to the month's last value, so the move across the month
  // boundary is attributed to the month it occurs in and monthly returns
  // compound to the total return.
  let monthBaseIdx = 0;
  let currentMonth = dates[0]?.slice(0, 7);

  const recordMonth = (endIdx: number) => {
    const base = values[monthBaseIdx];
    if (base === 0 || !isFinite(base)) return;
    const monthReturn = ((values[endIdx] - base) / base) * 100;
    if (!isFinite(monthReturn)) return;
    const monthDates = { start: dates[monthBaseIdx], end: dates[endIdx] };
    if (monthReturn > bestMonth) {
      bestMonth = monthReturn;
      bestMonthDates = monthDates;
    }
    if (monthReturn < worstMonth) {
      worstMonth = monthReturn;
      worstMonthDates = monthDates;
    }
  };

  for (let i = 1; i < dates.length; i++) {
    const month = dates[i].slice(0, 7);
    if (month !== currentMonth) {
      recordMonth(i - 1);
      monthBaseIdx = i - 1;
      currentMonth = month;
    }
  }

  // Last (possibly partial) month
  if (monthBaseIdx < values.length - 1) {
    recordMonth(values.length - 1);
  }

  const result = {
    bestMonth: bestMonth === -Infinity ? 0 : bestMonth,
    worstMonth: worstMonth === Infinity ? 0 : worstMonth,
    bestMonthDates,
    worstMonthDates,
  };
  if (byDates) {
    byDates.set(dates, result);
  } else {
    monthlyExtremesCache.set(values, new WeakMap([[dates, result]]));
  }
  return result;
}

/** Trading days per year used to annualize the daily-return ratios. */
const RATIO_TRADING_DAYS_PER_YEAR = 252;

/**
 * Finite simple daily returns of a value path, skipping days that start at or
 * below zero (a wiped-out leveraged path has no defined return after that).
 * Null when the path is too short for a ratio: under 3 values or 2 returns.
 */
function ratioDailyReturns(values: number[]): number[] | null {
  if (values.length < 3) return null;

  const dailyReturns: number[] = [];
  for (let i = 1; i < values.length; i++) {
    if (values[i - 1] <= 0) continue;
    const ret = (values[i] - values[i - 1]) / values[i - 1];
    if (isFinite(ret)) dailyReturns.push(ret);
  }
  return dailyReturns.length < 2 ? null : dailyReturns;
}

function meanOf(values: number[]): number {
  return values.reduce((sum, r) => sum + r, 0) / values.length;
}

const sharpeCache = new WeakMap<number[], number>();

/**
 * Calculate annualized Sharpe ratio from daily portfolio values.
 * Assumes a 0% risk-free rate (the same 0% hurdle Sortino uses) and divides
 * by the sample standard deviation of daily returns.
 * Flat or insufficient paths return 0. Cached by values array identity.
 */
export function calcSharpeRatio(values: number[]): number {
  const cached = sharpeCache.get(values);
  if (cached !== undefined) return cached;

  const dailyReturns = ratioDailyReturns(values);
  if (!dailyReturns) return 0;

  const mean = meanOf(dailyReturns);
  const variance =
    dailyReturns.reduce((sum, r) => sum + (r - mean) ** 2, 0) /
    (dailyReturns.length - 1);
  const stdDev = Math.sqrt(variance);
  if (!isFinite(stdDev) || stdDev === 0) return 0;

  const result = (mean / stdDev) * Math.sqrt(RATIO_TRADING_DAYS_PER_YEAR);
  sharpeCache.set(values, result);
  return result;
}

const sortinoCache = new WeakMap<number[], number>();

/**
 * Calculate annualized Sortino ratio from daily portfolio values.
 * Uses a 0% minimum acceptable return and 252 trading days per year.
 * Downside deviation averages squared negative returns over ALL observations.
 * Positive paths without downside return Infinity; flat/insufficient paths return 0.
 * Results are cached by values array identity.
 */
export function calcSortinoRatio(values: number[]): number {
  const cached = sortinoCache.get(values);
  if (cached !== undefined) return cached;

  const dailyReturns = ratioDailyReturns(values);
  if (!dailyReturns) return 0;

  const mean = meanOf(dailyReturns);
  const downsideVariance =
    dailyReturns.reduce((sum, r) => sum + Math.min(r, 0) ** 2, 0) /
    dailyReturns.length;
  const downsideDeviation = Math.sqrt(downsideVariance);
  const result = downsideDeviation === 0
    ? (mean > 0 ? Infinity : 0)
    : (mean / downsideDeviation) * Math.sqrt(RATIO_TRADING_DAYS_PER_YEAR);
  sortinoCache.set(values, result);
  return result;
}

/**
 * Everything an `EtfResult` reads off its daily value path other than CAGR,
 * which depends on the caller's choice of start value and final-value costs.
 */
export type PathMetrics = Pick<
  EtfResult,
  | "sharpeRatio"
  | "sortinoRatio"
  | "maxDrawdownPct"
  | "maxDrawdownDollar"
  | "maxDrawdownDates"
  | "longestDrawdownDays"
  | "longestDrawdownDates"
  | "bestMonth"
  | "bestMonthDates"
  | "worstMonth"
  | "worstMonthDates"
>;

/** Path metrics of a result whose metrics were skipped or whose path is degenerate. */
export const EMPTY_PATH_METRICS: PathMetrics = Object.freeze({
  sharpeRatio: 0,
  sortinoRatio: 0,
  maxDrawdownPct: 0,
  maxDrawdownDollar: 0,
  longestDrawdownDays: 0,
  bestMonth: 0,
  worstMonth: 0,
});

/**
 * Drawdown, monthly extremes and both risk-adjusted ratios for one value path.
 * Every `EtfResult` builder goes through this, so a metric added to the result
 * cannot be forgotten by one of them.
 */
export function calcPathMetrics(values: number[], dates: string[]): PathMetrics {
  const drawdown = calcMaxDrawdown(values, dates);
  const monthlyExtremes = calcMonthlyExtremes(values, dates);
  return {
    sharpeRatio: calcSharpeRatio(values),
    sortinoRatio: calcSortinoRatio(values),
    maxDrawdownPct: drawdown.pct,
    maxDrawdownDollar: drawdown.dollar,
    maxDrawdownDates: drawdown.maxDrawdownDates,
    longestDrawdownDays: drawdown.longestDays,
    longestDrawdownDates: drawdown.longestDrawdownDates,
    bestMonth: monthlyExtremes.bestMonth,
    bestMonthDates: monthlyExtremes.bestMonthDates,
    worstMonth: monthlyExtremes.worstMonth,
    worstMonthDates: monthlyExtremes.worstMonthDates,
  };
}

function daysBetween(date1: string, date2: string): number {
  const d1 = new Date(date1);
  const d2 = new Date(date2);
  return Math.round(
    Math.abs(d2.getTime() - d1.getTime()) / (24 * 60 * 60 * 1000)
  );
}
