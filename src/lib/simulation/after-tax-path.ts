// After-tax daily paths of whole backtest results, for every table that shows one
// (the backtest and futures results tables, the yearly growth table). One routine,
// so each page taxes a row the same way; rolling windows use after-tax-window.ts.

import { calcCagr } from "./metrics";
import { estimateFuturesAfterTaxPath, type FuturesTaxRates } from "./futures-tax";
import { buildLetfTaxSchedule, runLetfTaxLedger, type LetfTaxRun } from "./letf-tax";
import { buyAndHoldAfterTaxValue, taxesApply } from "./after-tax-window";
import type { EtfResult, LetfTaxSchedule } from "./types";

/** A row's after-tax CAGR and its after-tax value on each of its own dates, in its own dollars. */
export type AfterTaxPath = { cagr: number; values: number[] };

/** Rows the results tables add for the 1x index, bought and held. */
function isIndexRow(row: Pick<EtfResult, "id">): boolean {
  return row.id.startsWith("__index");
}

function isFuturesRow(row: Pick<EtfResult, "id">): boolean {
  return row.id.includes("futures-sma");
}

/** The path with its last value replaced by the reported final value (which includes the closing trade). */
function withFinalValue(values: readonly number[], finalValue: number): number[] {
  const out = [...values];
  out[out.length - 1] = finalValue;
  return out;
}

/**
 * A position bought on the first date and sold on the last, gaps (an index aligned
 * onto another calendar) carrying the last close: nothing is taxed until the sale.
 */
export function afterTaxBuyAndHoldPath(
  dates: readonly string[],
  values: readonly number[],
  rates: FuturesTaxRates
): AfterTaxPath | null {
  let lastValue = 0;
  const carried = values.map((value) => {
    if (Number.isFinite(value) && value > 0) lastValue = value;
    return lastValue;
  });
  const initialValue = carried[0];
  if (dates.length < 2 || carried.length !== dates.length || !(initialValue > 0)) return null;
  const finalValue = buyAndHoldAfterTaxValue({
    initialValue,
    finalValue: carried[carried.length - 1],
    startDate: dates[0],
    endDate: dates[dates.length - 1],
    rates,
  });
  return {
    cagr: calcCagr(initialValue, finalValue, dates[0], dates[dates.length - 1]),
    values: withFinalValue(carried, finalValue),
  };
}

/**
 * The after-tax account on each of the row's dates. Every trade the ledger makes
 * keeps the account's holdings in proportion to the pretax strategy's: a switch
 * sells and rebuys the same units, a fund reset splits both 50/50, a tax payment
 * sells (and a refund buys) every sleeve pro rata. So between two events the
 * after-tax path is the pretax path times a constant ratio, re-read at each event
 * as the account's value over the pretax value at the same prices. A schedule in
 * the engine's dollars still applies to a rescaled row: `scale` converts.
 */
function afterTaxDailyValues(row: EtfResult, schedule: LetfTaxSchedule, run: LetfTaxRun, scale: number): number[] {
  const { events } = schedule;
  const executed = run.ruinedAt ?? run.unitsAfter.length;
  const values = new Array<number>(row.dates.length);
  let ratio = 1;
  let next = 0;
  for (let day = 0; day < row.dates.length; day++) {
    for (; next < executed && events[next].date <= row.dates[day]; next++) {
      const event = events[next];
      const account = run.unitsAfter[next].reduce((sum, units, s) => sum + units * event.prices[s], 0);
      // A trade executes at the open, priced at the prior close, net of a reset's cost.
      const traded = Boolean(event.switched || event.reset);
      const pretax = traded
        ? (row.dailyValues[Math.max(0, day - 1)] / scale) * (1 - (event.reset?.costFraction ?? 0))
        : row.dailyValues[day] / scale;
      if (pretax > 0) ratio = account / pretax;
    }
    const ruined = run.ruinedAt !== undefined && events[run.ruinedAt].date <= row.dates[day];
    values[day] = ruined ? 0 : ratio * row.dailyValues[day];
  }
  if (run.ruinedAt === undefined) values[values.length - 1] = run.finalValue * scale;
  return values;
}

/**
 * A backtest row taxed at `rates`: LETF lines on their sales (`letf-tax.ts`),
 * futures lines marked to market each year (`futures-tax.ts`, from
 * `futuresInitialEquity`), the 1x index as a buy-and-hold. Null when the row cannot
 * be priced. At 0% it is the pretax path ending at the reported final value.
 */
export function afterTaxResultPath(
  row: EtfResult,
  rates: FuturesTaxRates,
  futuresInitialEquity?: number
): AfterTaxPath | null {
  const n = row.dates.length;
  if (n < 2 || row.dailyValues.length !== n) return null;
  if (isIndexRow(row)) return afterTaxBuyAndHoldPath(row.dates, row.dailyValues, rates);
  const pretax = withFinalValue(row.dailyValues, row.finalValue);
  if (!taxesApply(rates)) return { cagr: row.cagr, values: pretax };

  if (isFuturesRow(row)) {
    if (!(futuresInitialEquity && futuresInitialEquity > 0)) return null;
    const path = estimateFuturesAfterTaxPath(row.dates, pretax, futuresInitialEquity, rates);
    if (!path) return null;
    return { cagr: path.cagr, values: Array.from({ length: n }, (_, i) => path.values[i] ?? 0) };
  }

  // Rows carry their own schedule when built before a rescale (the futures page's
  // LETF twins) or when they cannot be rebuilt from the row (the UPRO/TQQQ fund).
  const schedule = row.taxSchedule ?? buildLetfTaxSchedule(row);
  const run = schedule ? runLetfTaxLedger(schedule, rates) : undefined;
  if (!schedule || !run) return null;
  const scheduleStart = schedule.startValues.reduce((sum, value) => sum + value, 0);
  const scale = scheduleStart > 0 ? row.dailyValues[0] / scheduleStart : 1;
  return { cagr: run.cagr, values: afterTaxDailyValues(row, schedule, run, scale) };
}
