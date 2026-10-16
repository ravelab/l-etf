import { calcCagr } from "./metrics";

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
 * Section 1256 income. Pay from the account at each year-end and at the window's
 * end; scale subsequent gains to the remaining capital. Losses carry forward,
 * with no assumed refunds, outside-income offsets, or carrybacks. This is not a
 * tax-lot calculation for the strategy's collateral or risk-off securities.
 */
export function estimateFuturesAfterTaxCagr(
  dates: readonly string[],
  values: readonly number[],
  initialEquity: number,
  rates: FuturesTaxRates,
): number | undefined {
  if (dates.length < 2 || dates.length !== values.length || initialEquity <= 0) return undefined;
  const taxRate = futuresTaxRate(rates);
  let pretaxBase = initialEquity;
  let equity = initialEquity;
  let lossCarryforward = 0;
  for (let i = 0; i < dates.length; i++) {
    if (i < dates.length - 1 && dates[i].slice(0, 4) === dates[i + 1].slice(0, 4)) continue;
    const value = values[i];
    if (!Number.isFinite(value) || value < 0) return undefined;
    if (pretaxBase <= 0 || value === 0) return -100;
    const gain = equity * (value / pretaxBase - 1);
    equity += gain;
    const netGain = gain - lossCarryforward;
    equity -= Math.max(0, netGain) * taxRate;
    lossCarryforward = Math.max(0, -netGain);
    pretaxBase = value;
  }
  return calcCagr(initialEquity, equity, dates[0], dates[dates.length - 1]);
}
