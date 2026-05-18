import type { PricePoint } from "@/lib/simulation/types";

export const parseNumberOrKeep = (raw: string, current: number): number => {
  if (raw.trim() === "") return current;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : current;
};

export function parsePositiveIntegerOrFallback(raw: string, fallback: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.round(parsed));
}

/**
 * Check if a date string is in monthly format (YYYY-MM) vs daily format (YYYY-MM-DD).
 */
function isMonthlyDate(date: string): boolean {
  return date.length === 7 && /^\d{4}-\d{2}$/.test(date);
}

/**
 * Convert monthly date to daily by appending -01 for comparison purposes.
 */
function monthlyToDailyDate(monthlyDate: string): string {
  return isMonthlyDate(monthlyDate) ? monthlyDate + "-01" : monthlyDate;
}

/**
 * Interpolate monthly price series to daily frequency.
 * Distributes monthly returns evenly across trading days using geometric interpolation.
 * 
 * Example:
 *   Monthly: [100 at 2020-01, 101 at 2020-02] (1% monthly return)
 *   Daily: [100, 100.03, 100.06, ..., 101] (smooth compounding, ~0.03% daily)
 * 
 * @param monthlyPoints - Price points with monthly dates (YYYY-MM)
 * @param dailyDates - Array of daily dates (YYYY-MM-DD) to interpolate to
 * @returns Array of interpolated daily prices
 */
function interpolateMonthlyToDaily(
  monthlyPoints: Array<{ date: string; adj_close: number }>,
  dailyDates: string[]
): number[] {
  if (monthlyPoints.length === 0 || dailyDates.length === 0) {
    return dailyDates.map(() => NaN);
  }

  // Convert monthly points to daily format for comparison
  const dailyPoints = monthlyPoints.map(p => ({
    date: monthlyToDailyDate(p.date),
    adj_close: p.adj_close,
  }));

  const result: number[] = [];
  let pointIndex = 0;

  for (const targetDate of dailyDates) {
    // Find the two monthly points that bracket this date
    while (
      pointIndex < dailyPoints.length - 1 &&
      dailyPoints[pointIndex + 1].date <= targetDate
    ) {
      pointIndex++;
    }

    const prevPoint = dailyPoints[pointIndex];
    const nextPoint = dailyPoints[Math.min(pointIndex + 1, dailyPoints.length - 1)];

    // If before first point, use first price (no return)
    if (targetDate < prevPoint.date) {
      result.push(prevPoint.adj_close);
      continue;
    }

    // If after last point or at a known point, use exact price
    if (targetDate >= nextPoint.date || prevPoint.date === nextPoint.date) {
      result.push(nextPoint.adj_close);
      continue;
    }

    // Geometric interpolation: distribute log returns evenly
    const prevTime = new Date(prevPoint.date).getTime();
    const nextTime = new Date(nextPoint.date).getTime();
    const targetTime = new Date(targetDate).getTime();

    const totalDays = (nextTime - prevTime) / (1000 * 60 * 60 * 24);
    const elapsedDays = (targetTime - prevTime) / (1000 * 60 * 60 * 24);
    const fraction = Math.max(0, Math.min(1, elapsedDays / totalDays));

    // Geometric interpolation: price = prev * (next/prev)^fraction
    const ratio = nextPoint.adj_close / prevPoint.adj_close;
    const interpolatedPrice = prevPoint.adj_close * Math.pow(ratio, fraction);

    result.push(interpolatedPrice);
  }

  return result;
}

/**
 * Align a series of price points to a base date series.
 * Returns an array of prices aligned to basePrices dates.
 *
 * Automatically detects if input is monthly (YYYY-MM) or daily (YYYY-MM-DD):
 * - Monthly data: Interpolates returns evenly across days using geometric interpolation
 * - Daily data: Forward-fills from most recent known price for missing dates
 * - Mixed data: Interpolates monthly portion, uses exact/forward-fill for daily portion
 *
 * This prevents artificial volatility spikes when monthly data is aligned to daily frequency.
 */
export function alignCloseSeriesToDates(
  basePrices: PricePoint[],
  points: PricePoint[],
): number[] {
  if (points.length === 0) {
    return [];
  }

  const dailyDates = basePrices.map(p => p.date);

  // Check if data has a monthly segment (detects mixed monthly+daily data)
  const hasMonthlySegment = points.some(p => isMonthlyDate(p.date));

  if (hasMonthlySegment) {
    // Separate monthly and daily points
    const monthlyPoints = points.filter(p => isMonthlyDate(p.date));
    const dailyPoints = points.filter(p => !isMonthlyDate(p.date));

    // If mostly monthly, use pure interpolation
    if (monthlyPoints.length > points.length / 2) {
      return interpolateMonthlyToDaily(points, dailyDates);
    }

    // Mixed data: interpolate monthly portion, use exact/forward-fill for daily portion
    // Build a map of all known prices (daily points + interpolated monthly points)
    const priceByDate = new Map<string, number>();

    // First, add all daily points (they take precedence)
    for (const p of dailyPoints) {
      priceByDate.set(p.date, p.adj_close);
    }

    // Interpolate monthly points to daily frequency
    if (monthlyPoints.length > 0) {
      const interpolatedMonthly = interpolateMonthlyToDaily(monthlyPoints, dailyDates);
      // Only use interpolated values for dates before the first daily point
      const firstDailyDate = dailyPoints.length > 0
        ? dailyPoints.sort((a, b) => a.date.localeCompare(b.date))[0].date
        : null;

      for (let i = 0; i < dailyDates.length; i++) {
        const date = dailyDates[i];
        if (firstDailyDate === null || date < firstDailyDate) {
          // Use interpolated monthly value for dates before daily data starts
          if (!priceByDate.has(date) && isFinite(interpolatedMonthly[i])) {
            priceByDate.set(date, interpolatedMonthly[i]);
          }
        }
      }
    }

    // Forward-fill for any remaining gaps
    const sortedDates = Array.from(priceByDate.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    let lastKnownPrice = sortedDates[0]?.[1] ?? points[0].adj_close;

    return dailyDates.map((date) => {
      const price = priceByDate.get(date);
      if (price !== undefined) {
        lastKnownPrice = price;
        return price;
      }
      // Forward-fill: use the most recent known price
      if (date < sortedDates[0]?.[0]) {
        return sortedDates[0]?.[1] ?? points[0].adj_close;
      }
      return lastKnownPrice;
    });
  }

  // Pure daily/sparse data: forward-fill from the latest known point on/before each date.
  // This handles sparse monthly proxy rows (e.g. 1971-02-01) when base dates are trading
  // days (e.g. 1971-02-05) and avoids anchoring to the very first historical point.
  const sortedPoints = [...points].sort((a, b) => a.date.localeCompare(b.date));
  if (sortedPoints.length === 0) return [];

  let sourceIdx = 0;
  let lastKnownPrice = sortedPoints[0].adj_close;
  const firstSourceDate = sortedPoints[0].date;

  return basePrices.map((p) => {
    while (sourceIdx < sortedPoints.length && sortedPoints[sourceIdx].date <= p.date) {
      lastKnownPrice = sortedPoints[sourceIdx].adj_close;
      sourceIdx += 1;
    }

    if (p.date < firstSourceDate) {
      return sortedPoints[0].adj_close;
    }

    return lastKnownPrice;
  });
}

export function alignOpenSeriesToDates(
  basePrices: PricePoint[],
  points: PricePoint[],
): number[] {
  const openProjected = points.map((point) => ({
    ...point,
    adj_close: adjustedOpenFromPricePoint(point),
  }));
  return alignCloseSeriesToDates(basePrices, openProjected);
}

export function adjustedOpenFromPricePoint(point: PricePoint): number {
  const open = point.open;
  const close = point.close;
  const adjClose = point.adj_close;
  if (
    Number.isFinite(open) &&
    Number.isFinite(close) &&
    open != null &&
    close != null &&
    open > 0 &&
    close > 0 &&
    Number.isFinite(adjClose) &&
    adjClose > 0
  ) {
    return adjClose * (open / close);
  }
  return point.adj_open ?? Number.NaN;
}

export function intersectCommonDates(dateLists: string[][]): string[] {
  if (dateLists.length === 0) return [];
  const first = dateLists[0];
  const otherSets = dateLists.slice(1).map((dates) => new Set(dates));
  return first.filter((d) => otherSets.every((s) => s.has(d))).sort();
}

export function filterPricesByDates(
  prices: PricePoint[],
  dates: string[],
): PricePoint[] {
  const dateSet = new Set(dates);
  return prices.filter((p) => dateSet.has(p.date));
}

export function formatDateSpan(dates?: { start: string; end: string }): string {
  if (!dates) return "";
  const fmt = (d: string) => d.slice(0, 7).replace("-", "/");
  return `${fmt(dates.start)} – ${fmt(dates.end)}`;
}

/**
 * Validates that price rows are ready for simulation (have finite, positive adj_close).
 * Filters out rows after requestedEndDate and rows with missing/invalid adjusted data.
 */
export function validateSimulationReadyPrices(
  _index: string,
  rows: Array<PricePoint | { date: string; adj_close?: number; close?: number }>,
  requestedEndDate: string
): PricePoint[] {
  return rows.filter((row) => {
    if (row.date > requestedEndDate) return false;
    const adjClose = row.adj_close ?? Number.NaN;
    return Number.isFinite(adjClose) && adjClose > 0;
  }) as PricePoint[];
}

/**
 * Get current date in America/New_York as YYYY-MM-DD.
 */
export function getNewYorkIsoDate(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) {
    throw new Error("Failed to derive New York date");
  }
  return `${year}-${month}-${day}`;
}
