import { calcCagr } from "./metrics";
import { SafeHarborTaxes, taxDueDatesBetween } from "./safe-harbor";

/** User-entered rates in percentage points. */
export type FuturesTaxRates = {
  ltcg: number;
  stcg: number;
  state: number;
  medicare: number;
};

export const DEFAULT_FUTURES_TAX_RATES: FuturesTaxRates = {
  ltcg: 15,
  stcg: 22,
  state: 8,
  medicare: 3.8,
};

export function futuresTaxRate(rates: FuturesTaxRates): number {
  return Math.min(1, Math.max(0, (0.6 * rates.ltcg + 0.4 * rates.stcg + rates.state + rates.medicare) / 100));
}

/**
 * Annual mark-to-market estimate using strategy equity changes as a proxy for
 * Section 1256 income: each calendar year's gain is taxed, losses carry forward,
 * with no assumed refunds of past tax, outside-income offsets, or carrybacks. The
 * tax is paid from the account on the safe-harbor schedule (`safe-harbor.ts`):
 * estimated installments and the April true-up leave the account on their due
 * dates, and whatever is still owed at the window's end is paid then. This is not
 * a tax-lot calculation for the strategy's collateral or risk-off securities.
 */
export function estimateFuturesAfterTaxCagr(
  dates: readonly string[],
  values: readonly number[],
  initialEquity: number,
  rates: FuturesTaxRates,
): number | undefined {
  if (dates.length < 2 || dates.length !== values.length || initialEquity <= 0) return undefined;
  const taxRate = futuresTaxRate(rates);
  const taxes = new SafeHarborTaxes();
  const last = dates.length - 1;
  // After-tax equity is `scale × value`: the same positions, less what taxes took.
  let scale = 1;
  let previousValue = initialEquity;
  let yearGain = 0;
  let lossCarryforward = 0;
  for (let i = 0; i <= last; i++) {
    const value = values[i];
    if (!Number.isFinite(value) || value < 0) return undefined;
    yearGain += scale * (value - previousValue);
    previousValue = value;
    if (i > 0 && i < last) {
      for (const dueDate of taxDueDatesBetween(dates[i - 1], dates[i])) {
        const cash = taxes.due(dueDate);
        if (cash === 0) continue;
        const equity = scale * value;
        if (!(equity > 0) || cash >= equity) return -100;
        scale *= 1 - cash / equity;
      }
    }
    if (i === last || dates[i].slice(0, 4) !== dates[i + 1].slice(0, 4)) {
      const netGain = yearGain - lossCarryforward;
      taxes.setTax(Number(dates[i].slice(0, 4)), Math.max(0, netGain) * taxRate);
      lossCarryforward = Math.max(0, -netGain);
      yearGain = 0;
    }
  }
  const afterTax = scale * values[last] - taxes.outstanding();
  if (!(afterTax > 0)) return -100;
  return calcCagr(initialEquity, afterTax, dates[0], dates[last]);
}
