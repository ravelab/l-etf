import type { RatePoint } from "./types";

/**
 * Borrowing rate for leveraged ETF simulation.
 * Single source: rate-borrow.csv (GitHub CSV 1885-2018 + FRED SOFR 2018-present)
 *
 * Boundary handling (standard pattern):
 * - GitHub CSV: 1885-01-01 to 2018-04-03 (last INCLUDED row)
 * - FRED SOFR: 2018-04-03 (REFERENCE only) → 2018-04-04 (first INCLUDED row)
 *
 * The CSV is pre-filled with no gaps (forward-filled during generation).
 */

interface RateLookup {
  getRate(date: string): number;
}

function normalizeLookupDate(date: string): string {
  const isoDayMatch = date.match(/^\d{4}-\d{2}-\d{2}/);
  if (isoDayMatch) return isoDayMatch[0];

  const isoMonthMatch = date.match(/^\d{4}-\d{2}$/);
  if (isoMonthMatch) return isoMonthMatch[0];

  return date;
}

/**
 * Build a borrowing rate lookup from rate-borrow.csv data.
 * Rates are stored as annualized decimals (e.g., 0.0525 = 5.25%).
 * Returns daily rate = annualRate / 360 (money market convention).
 *
 * Uses Map for O(1) lookup - CSV is pre-filled with no gaps.
 * For missing dates (weekends/holidays), finds the most recent previous rate.
 * Handles both YYYY-MM (monthly) and YYYY-MM-DD (daily) date formats.
 *
 * Note: rate-borrow.csv contains daily data (GitHub swap rates + FRED SOFR).
 * Other rate series (tbill-1m, treasury-2y) may be monthly or daily.
 */
const rateLookupCache = new WeakMap<RatePoint[], RateLookup>();

export function buildRateLookup(rates: RatePoint[]): RateLookup {
  const cached = rateLookupCache.get(rates);
  if (cached) return cached;

  // Build sorted array for binary search
  const sortedRates = rates
    .map((r) => ({ date: r.date, rate: r.rateValue }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const rateMap = new Map<string, number>();
  const sortedDates = sortedRates.map((r) => r.date);

  for (const r of rates) {
    rateMap.set(r.date, r.rateValue);
  }

  // Binary search to find the most recent date <= target date
  function findMostRecentRate(targetDate: string): number | undefined {
    const normalizedTargetDate = normalizeLookupDate(targetDate);

    // Quick check: if exact match exists, return it
    const exactMatch = rateMap.get(normalizedTargetDate);
    if (exactMatch !== undefined) return exactMatch;

    // If target is YYYY-MM-DD, also check for YYYY-MM monthly match
    if (normalizedTargetDate.length === 10) {
      const monthKey = normalizedTargetDate.slice(0, 7);
      const monthlyMatch = rateMap.get(monthKey);
      if (monthlyMatch !== undefined) return monthlyMatch;
    }

    // Binary search for insertion point
    let lo = 0;
    let hi = sortedDates.length;

    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (sortedDates[mid] <= normalizedTargetDate) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }

    // lo is now the index of the first date > targetDate
    // So lo - 1 is the most recent date <= targetDate
    if (lo > 0 && lo <= sortedDates.length) {
      const prevDate = sortedDates[lo - 1];
      return rateMap.get(prevDate);
    }

    return undefined;
  }

  const lookup: RateLookup = {
    getRate(date: string): number {
      const rate = findMostRecentRate(date);
      if (rate !== undefined) {
        // Convert annualized decimal to daily rate (money market: /360)
        return rate / 360;
      }
      throw new Error(
        `Borrowing rate data is missing for ${date}. ` +
          "The simulation requires a rate on or before every simulated date."
      );
    },
  };

  rateLookupCache.set(rates, lookup);
  return lookup;
}
