/**
 * Monthly CPI history (`data/inflation.csv`):
 *
 * - before 1913-01   Shiller's CPI, recovered from the upstream seed CSV
 * - 1913-01..1946-12 FRED `CPIAUCNS` (not seasonally adjusted; the only CPI before 1947)
 * - 1947-01 ..       FRED `CPIAUCSL`
 *
 * The upstream "CPI" column is monthly CPI linearly interpolated to trading
 * days, anchored on the 1st. Its last row in a month is therefore close to the
 * NEXT month's CPI; reading that row shifted the whole pre-1947 series a month
 * early. Two rows in the same month pin the line, so the month's own value is
 * recovered exactly (checked against CPIAUCNS 1913-1946: max error 0.0000%).
 */

export const CPI_NSA_START_MONTH = "1913-01";
export const CPI_NSA_END_DATE = "1946-12-31";
export const CPI_SA_START_MONTH = "1947-01";

export interface CpiRow {
  /** `YYYY-MM` */
  date: string;
  value: number;
  name: string;
  source: string;
}

function dayOfMonth(date: string): number {
  return Number(date.slice(8, 10));
}

/** Each month's CPI from its first and last interpolated rows; months with <2 distinct days are omitted. */
export function monthlyCpiFromInterpolatedDaily(
  rows: ReadonlyArray<{ date: string; cpi: number }>
): Map<string, number> {
  const bounds = new Map<string, { first: { day: number; cpi: number }; last: { day: number; cpi: number } }>();
  for (const row of rows) {
    if (!Number.isFinite(row.cpi) || row.cpi <= 0) continue;
    const month = row.date.slice(0, 7);
    const point = { day: dayOfMonth(row.date), cpi: row.cpi };
    const seen = bounds.get(month);
    bounds.set(month, seen ? { first: seen.first, last: point } : { first: point, last: point });
  }
  const byMonth = new Map<string, number>();
  for (const [month, { first, last }] of bounds) {
    if (last.day === first.day) continue;
    const slopePerDay = (last.cpi - first.cpi) / (last.day - first.day);
    byMonth.set(month, first.cpi - slopePerDay * (first.day - 1));
  }
  return byMonth;
}

interface FredMonthlyRow {
  date: string;
  value: number;
  carriedForward?: boolean;
}

export function composeCpiHistory(inputs: {
  upstreamCpiByMonth: ReadonlyMap<string, number>;
  nsaRows: ReadonlyArray<FredMonthlyRow>;
  saRows: ReadonlyArray<FredMonthlyRow>;
}): CpiRow[] {
  const shiller = [...inputs.upstreamCpiByMonth.entries()]
    .filter(([month]) => month < CPI_NSA_START_MONTH)
    .map(([month, value]) => ({ date: month, value, name: "CPI", source: "github-csv" }));
  const nsa = inputs.nsaRows
    .map((row) => ({ ...row, date: row.date.slice(0, 7) }))
    .filter((row) => row.date >= CPI_NSA_START_MONTH && row.date < CPI_SA_START_MONTH)
    .map((row) => ({ date: row.date, value: row.value, name: "CPIAUCNS", source: "fred" }));
  const sa = inputs.saRows
    .map((row) => ({ ...row, date: row.date.slice(0, 7) }))
    .filter((row) => row.date >= CPI_SA_START_MONTH)
    .map((row) => ({
      date: row.date,
      value: row.value,
      name: "CPIAUCSL",
      source: row.carriedForward ? "fred-carry-forward" : "fred",
    }));

  if (nsa[0]?.date !== CPI_NSA_START_MONTH) throw new Error(`inflation: CPIAUCNS does not start at ${CPI_NSA_START_MONTH}`);
  if (sa[0]?.date !== CPI_SA_START_MONTH) throw new Error(`inflation: CPIAUCSL does not start at ${CPI_SA_START_MONTH}`);

  return [...shiller, ...nsa, ...sa].sort((a, b) => a.date.localeCompare(b.date));
}
