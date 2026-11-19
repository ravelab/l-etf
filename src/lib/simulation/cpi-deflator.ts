// CPI as it was known on each trading day, for the inflation-adjusted SMA band.
//
// A month's CPI is published around the middle of the next month, so a day before
// the 15th sees the month before last and a day from the 15th sees last month.
// Days past the newest print hold it; days before the series hold its first value.

import cpiModule from "@/lib/tool-snapshots/cpi-monthly.json";

export type MonthlyCpiModule = { startMonth: string; values: number[] };

/** Day of the month from which the previous month's CPI counts as published. */
export const CPI_RELEASE_DAY = 15;

const CPI = cpiModule as MonthlyCpiModule;
const START = Number(CPI.startMonth.slice(0, 4)) * 12 + Number(CPI.startMonth.slice(5, 7)) - 1;

export function cpiKnownOn(date: string, cpi: MonthlyCpiModule = CPI): number {
  const start = cpi === CPI ? START : Number(cpi.startMonth.slice(0, 4)) * 12 + Number(cpi.startMonth.slice(5, 7)) - 1;
  const month = Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
  const lag = Number(date.slice(8, 10)) >= CPI_RELEASE_DAY ? 1 : 2;
  const k = Math.min(cpi.values.length - 1, Math.max(0, month - lag - start));
  return cpi.values[k];
}

const deflatorCache = new WeakMap<readonly string[], number[]>();

/** `cpiKnownOn` for every date, cached per dates array. */
export function cpiDeflatorForDates(dates: readonly string[]): number[] {
  let deflator = deflatorCache.get(dates);
  if (!deflator) {
    deflator = dates.map((date) => cpiKnownOn(date));
    deflatorCache.set(dates, deflator);
  }
  return deflator;
}
