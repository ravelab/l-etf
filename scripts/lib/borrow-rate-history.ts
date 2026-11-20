/**
 * The LETF borrow-rate history (`data/rate-borrow.csv`), one source per era.
 *
 * Every era is an overnight or short private funding rate, so the base the
 * swap spread sits on does not change meaning at a splice:
 *
 * - 1885-03 .. 1954-06  NBER commercial paper rate, New York (monthly; FRED
 *   `M13002US35620M156NNBR`). Each trading day takes its month's rate.
 * - 1954-07 .. 1985-12  Effective federal funds rate (daily; FRED `DFF`).
 * - 1986-01 .. 2018-04-02  1-month USD LIBOR, from the upstream seed CSV.
 * - 2018-04-03 ..       SOFR (daily; FRED `SOFR`).
 *
 * The upstream seed CSV supplies only the trading-day grid and LIBOR. Its
 * "Swap Rate" column before 1986 is unusable: 1926-1985 comes from Ken
 * French's daily T-bill file, which stores a two-decimal percent PER DAY, so
 * the annualized rate moves in 2.52% steps (0% from 1932 to 1950, flat for
 * years at 2.52/5.04%); before 1926 it is the Shiller 10-year yield minus 1%.
 */

export const COMMERCIAL_PAPER_FRED_SERIES = "M13002US35620M156NNBR";
export const COMMERCIAL_PAPER_END_DATE = "1954-06-30";
export const FED_FUNDS_START_DATE = "1954-07-01";
export const FED_FUNDS_END_DATE = "1985-12-31";
export const LIBOR_START_DATE = "1986-01-02";
export const SOFR_START_DATE = "2018-04-03";

export const BORROW_RATE_SEGMENT_NAMES = {
  commercialPaper: "CP",
  fedFunds: "DFF",
  libor: "LIBOR1M",
  sofr: "SOFR",
} as const;

export interface BorrowRateRow {
  date: string;
  /** Annualized decimal (0.05 = 5%). */
  value: number;
  name: string;
  source: string;
}

interface BorrowRateInputs {
  /** Upstream trading days, with its swap-rate column in percent (LIBOR from 1986). */
  upstreamRows: ReadonlyArray<{ date: string; swapRatePct: number }>;
  /** Monthly commercial-paper rate in percent, keyed `YYYY-MM`. */
  commercialPaperPctByMonth: ReadonlyMap<string, number>;
  /** Daily effective fed funds in percent, keyed `YYYY-MM-DD`. */
  fedFundsPctByDate: ReadonlyMap<string, number>;
  sofrRows: ReadonlyArray<{ date: string; valuePct: number }>;
}

function preSofrRow(
  row: { date: string; swapRatePct: number },
  inputs: BorrowRateInputs
): BorrowRateRow | null {
  const { date } = row;
  if (date < FED_FUNDS_START_DATE) {
    const pct = inputs.commercialPaperPctByMonth.get(date.slice(0, 7));
    if (pct === undefined) throw new Error(`rate-borrow: no commercial paper rate for ${date.slice(0, 7)}`);
    return { date, value: pct / 100, name: BORROW_RATE_SEGMENT_NAMES.commercialPaper, source: "fred" };
  }
  if (date < LIBOR_START_DATE) {
    const pct = inputs.fedFundsPctByDate.get(date);
    if (pct === undefined) throw new Error(`rate-borrow: no fed funds rate for ${date}`);
    return { date, value: pct / 100, name: BORROW_RATE_SEGMENT_NAMES.fedFunds, source: "fred" };
  }
  if (!Number.isFinite(row.swapRatePct) || row.swapRatePct <= 0) return null;
  return { date, value: row.swapRatePct / 100, name: BORROW_RATE_SEGMENT_NAMES.libor, source: "github-csv" };
}

export function composeBorrowRateHistory(inputs: BorrowRateInputs): BorrowRateRow[] {
  const preSofr = inputs.upstreamRows
    .filter((row) => row.date < SOFR_START_DATE)
    .map((row) => preSofrRow(row, inputs))
    .filter((row): row is BorrowRateRow => row !== null);

  if (!preSofr.some((row) => row.name === BORROW_RATE_SEGMENT_NAMES.libor)) {
    throw new Error("rate-borrow: the upstream seed CSV has no LIBOR rows (1986-01-02 .. 2018-04-02)");
  }

  const sofr = inputs.sofrRows
    .filter((row) => row.date >= SOFR_START_DATE && Number.isFinite(row.valuePct))
    .map((row) => ({ date: row.date, value: row.valuePct / 100, name: BORROW_RATE_SEGMENT_NAMES.sofr, source: "fred" }));

  return [...preSofr, ...sofr].sort((a, b) => a.date.localeCompare(b.date));
}
