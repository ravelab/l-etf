/**
 * Monthly short-Treasury yield history behind the SGOV and VGSH pre-inception
 * proxies (VGSH switches to FRED `DGS2` once it starts in 1976-06).
 *
 * - before 1920-01   upstream seed CSV "Risk Free Rate" (Shiller 10-year yield
 *                    minus 1%; there was no short Treasury market to quote)
 * - 1920-01..1933-12 NBER yields on short-term US securities: 3-6 month notes
 *                    and certificates, then 3-month bills (FRED `M1329AUSM193NNBR`)
 * - 1934-01 ..       3-month T-bill, monthly average (FRED `TB3MS`)
 *
 * The upstream column is not used from 1920: for 1926-1953 it is Ken French's
 * daily T-bill, quantized to 2.52% steps (see borrow-rate-history.ts), which
 * gave the VGSH duration model fake ±5% months and an 18-year run at 0%.
 */

export const SHORT_GOV_FRED_SERIES = "M1329AUSM193NNBR";
export const SHORT_GOV_YIELD_START_MONTH = "1920-01";
export const SHORT_GOV_END_DATE = "1933-12-31";
export const TB3MS_START_MONTH = "1934-01";

export const SHORT_TREASURY_YIELD_NAMES = {
  upstream: "SHILLER10Y-1",
  shortGov: "NBER-SHORTGOV",
  tb3ms: "TB3MS",
} as const;

export interface MonthlyYield {
  /** `YYYY-MM` */
  date: string;
  /** Annualized decimal yield. */
  value: number;
  name: string;
}

interface ShortTreasuryInputs {
  /** Decimal yields keyed `YYYY-MM`; only months before 1920 are used. */
  upstreamRiskFreeByMonth: ReadonlyMap<string, number>;
  /** Percent, keyed `YYYY-MM`. */
  shortGovPctByMonth: ReadonlyMap<string, number>;
  /** Percent, keyed `YYYY-MM`. */
  tb3msPctByMonth: ReadonlyMap<string, number>;
}

function fromPct(byMonth: ReadonlyMap<string, number>, lo: string, hi: string | null, name: string): MonthlyYield[] {
  return [...byMonth.entries()]
    .filter(([month]) => month >= lo && (hi === null || month < hi))
    .map(([month, pct]) => ({ date: month, value: pct / 100, name }));
}

export function composeShortTreasuryYieldsByMonth(inputs: ShortTreasuryInputs): MonthlyYield[] {
  const upstream = [...inputs.upstreamRiskFreeByMonth.entries()]
    .filter(([month]) => month < SHORT_GOV_YIELD_START_MONTH)
    .map(([month, value]) => ({ date: month, value, name: SHORT_TREASURY_YIELD_NAMES.upstream }));
  const shortGov = fromPct(
    inputs.shortGovPctByMonth, SHORT_GOV_YIELD_START_MONTH, TB3MS_START_MONTH, SHORT_TREASURY_YIELD_NAMES.shortGov
  );
  const tb3ms = fromPct(inputs.tb3msPctByMonth, TB3MS_START_MONTH, null, SHORT_TREASURY_YIELD_NAMES.tb3ms);

  if (!shortGov.some((row) => row.date === SHORT_GOV_YIELD_START_MONTH)) {
    throw new Error(`short-Treasury yields: no NBER short-term government yield for ${SHORT_GOV_YIELD_START_MONTH}`);
  }
  if (!tb3ms.some((row) => row.date === TB3MS_START_MONTH)) {
    throw new Error(`short-Treasury yields: TB3MS does not start at ${TB3MS_START_MONTH}`);
  }

  return [...upstream, ...shortGov, ...tb3ms].sort((a, b) => a.date.localeCompare(b.date));
}
