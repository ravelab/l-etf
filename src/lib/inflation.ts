/**
 * Build a lookup from "YYYY" → year-over-year CPI inflation rate.
 * Uses the last CPI observation per year; rate for year Y is
 * (CPI_last_Y - CPI_last_{Y-1}) / CPI_last_{Y-1}.
 */
export function buildYearlyCpiInflation(
  monthlyCpi: Array<{ date: string; value: number }>,
): Map<string, number> {
  const decByYear = new Map<string, number>();
  for (const obs of monthlyCpi) {
    const year = obs.date.slice(0, 4);
    decByYear.set(year, obs.value);
  }
  const years = [...decByYear.keys()].sort();
  const map = new Map<string, number>();
  for (let i = 1; i < years.length; i++) {
    const prev = decByYear.get(years[i - 1])!;
    const curr = decByYear.get(years[i])!;
    if (prev > 0 && isFinite(curr)) {
      map.set(years[i], (curr - prev) / prev);
    }
  }
  return map;
}

/**
 * Compute annualized inflation rate for a specific date range using monthly CPI data.
 * Finds the nearest CPI observations to start and end dates, then annualizes.
 * Returns the rate as a fraction (e.g., 0.03 for 3%).
 */
export function annualizedInflationForRange(
  monthlyCpi: Array<{ date: string; value: number }>,
  startDate: string,
  endDate: string,
): number {
  if (monthlyCpi.length < 2) return 0;

  // monthlyCpi is sorted by date — find nearest observations.
  // If startDate is before the earliest CPI record, use the first available
  // observation and measure inflation only over the CPI-covered range.
  let startCpi = NaN;
  let startCpiDate = startDate;
  let endCpi = NaN;

  for (const obs of monthlyCpi) {
    if (obs.date <= startDate) {
      startCpi = obs.value;
      startCpiDate = obs.date;
    }
    if (obs.date <= endDate) endCpi = obs.value;
  }

  // Fallback: use earliest available CPI when startDate predates CPI data
  if (isNaN(startCpi) && monthlyCpi.length > 0) {
    startCpi = monthlyCpi[0].value;
    startCpiDate = monthlyCpi[0].date;
  }

  if (isNaN(startCpi) || isNaN(endCpi) || startCpi <= 0) return 0;

  const startMs = new Date(startCpiDate).getTime();
  const endMs = new Date(endDate).getTime();
  const years = (endMs - startMs) / (365.25 * 24 * 60 * 60 * 1000);
  if (years <= 0) return 0;

  return Math.pow(endCpi / startCpi, 1 / years) - 1;
}

/**
 * CPI index ratio: last observation on/before endDate divided by last on/before startDate.
 * To express nominal dollars at endDate in startDate purchasing power: divide by this ratio
 * (equivalently multiply by startCpi/endCpi).
 */
export function cpiIndexRatioEndOverStart(
  monthlyCpi: Array<{ date: string; value: number }>,
  startDate: string,
  endDate: string,
): number {
  if (monthlyCpi.length < 2 || endDate < startDate) return 1;

  let startCpi = NaN;
  let endCpi = NaN;

  for (const obs of monthlyCpi) {
    if (obs.date <= startDate) startCpi = obs.value;
    if (obs.date <= endDate) endCpi = obs.value;
  }

  if (isNaN(startCpi) && monthlyCpi.length > 0) {
    startCpi = monthlyCpi[0].value;
  }

  if (isNaN(startCpi) || isNaN(endCpi) || startCpi <= 0 || endCpi <= 0) return 1;

  return endCpi / startCpi;
}

export function displayedAnnualizedInflationPct(
  monthlyCpi: Array<{ date: string; value: number }>,
  startDate: string,
  endDate: string,
  annualizedInflation?: number,
): number {
  return monthlyCpi.length >= 2
    ? annualizedInflationForRange(monthlyCpi, startDate, endDate) * 100
    : (annualizedInflation ?? 0) * 100;
}

/**
 * “Avg Inflation” next to sweep/rolling section titles. Annualizes CPI over
 * [section display start, end] so it matches the subtitle “Start Date: …”
 * (e.g. combo UPRO vs TQQQ when index data clips at different dates).
 */
export function inflationPctForSweepSectionTitle(options: {
  monthlyCpi: Array<{ date: string; value: number }>;
  /** Matches UI: min window start for that sweep (or baseline), optional */
  sectionDisplayStartDate: string | null | undefined;
  /** Form start when display start is missing */
  fallbackStartDate: string;
  /** Prefer last run end: `runSummaryInputs?.endDate ?? endDate` */
  cpiEndDate: string;
  annualizedInflation: number;
}): number | null {
  const start = options.sectionDisplayStartDate ?? options.fallbackStartDate;
  return displayedAnnualizedInflationPct(
    options.monthlyCpi,
    start,
    options.cpiEndDate,
    options.annualizedInflation,
  );
}

function inflationForRange(
  monthlyCpi: Array<{ date: string; value: number }>,
  startDate: string,
  endDate: string,
): number {
  if (monthlyCpi.length < 2) return 0;

  let startCpi = NaN;
  let endCpi = NaN;

  for (const obs of monthlyCpi) {
    if (obs.date <= startDate) startCpi = obs.value;
    if (obs.date <= endDate) endCpi = obs.value;
  }

  if (isNaN(startCpi) && monthlyCpi.length > 0) {
    startCpi = monthlyCpi[0].value;
  }

  if (isNaN(startCpi) || isNaN(endCpi) || startCpi <= 0) return 0;

  return endCpi / startCpi - 1;
}

/**
 * Compute real yearly growth, including partial first/last years.
 * Interior years use Dec-to-Dec returns. The first and last years use the
 * actual series boundary dates when the range starts/ends mid-year.
 */
export function sampleYearlyRealGrowth(
  dates: string[],
  dailyValues: number[],
  cpiInflation: Map<string, number>,
  monthlyCpi?: Array<{ date: string; value: number }>,
): { years: string[]; values: number[]; inflation: number[] } {
  const firstIdxByYear = new Map<string, number>();
  const lastIdxByYear = new Map<string, number>();
  for (let i = 0; i < dates.length; i++) {
    const year = dates[i].slice(0, 4);
    if (!firstIdxByYear.has(year)) firstIdxByYear.set(year, i);
    lastIdxByYear.set(year, i);
  }
  const sortedYears = [...lastIdxByYear.keys()].sort();
  const resultYears: string[] = [];
  const values: number[] = [];
  const inflationValues: number[] = [];

  if (sortedYears.length === 0) {
    return { years: resultYears, values, inflation: inflationValues };
  }

  for (let y = 0; y < sortedYears.length; y++) {
    const year = sortedYears[y];
    const endIdx = lastIdxByYear.get(year)!;
    const startIdx = y === 0
      ? firstIdxByYear.get(year)!
      : lastIdxByYear.get(sortedYears[y - 1])!;
    if (endIdx <= startIdx) continue;

    const startDate = dates[startIdx];
    const endDate = dates[endIdx];
    const nominalReturn =
      (dailyValues[endIdx] - dailyValues[startIdx]) /
      dailyValues[startIdx];
    const inflation = monthlyCpi && monthlyCpi.length >= 2
      ? inflationForRange(monthlyCpi, startDate, endDate)
      : cpiInflation.get(year) ?? 0;
    const realReturn = ((1 + nominalReturn) / (1 + inflation) - 1) * 100;
    resultYears.push(year);
    values.push(realReturn);
    inflationValues.push(inflation);
  }
  return { years: resultYears, values, inflation: inflationValues };
}
