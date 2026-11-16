// After-tax estimates for LETF strategies: one LETF, or the UPRO/TQQQ fund. Unlike
// futures (Section 1256: marked to market every year at a 60/40 blend,
// `futures-tax.ts`), ETF shares are taxed only when sold, short-term or long-term
// by how long each lot was held. So the tax comes from the trades: an SMA switch
// sells a sleeve's whole position, a fund's 50/50 reset sells or buys part of the
// staying sleeve's basket, and the run ends by selling all. The tax is paid on the
// safe-harbor schedule (`safe-harbor.ts`): each installment or April balance sells
// every sleeve pro rata, whose own gains count in that year, and a refund buys back
// in; whatever is still owed at the end comes out of the closing sale.
//
// The trades come from the result's `taxSchedule`, so the rates can change without
// re-simulating. Not modeled: fund distributions, the collectibles rate on gold,
// state exemption of Treasury interest, the $3,000 deduction against ordinary
// income and outside gains or losses. Risk-off income is taxed as capital gains
// when its basket is sold.

import { CONSTANT_INITIAL_INVESTMENT } from "@/lib/constants";
import type { FuturesTaxRates } from "./futures-tax";
import { exitFraction, heldRiskOnByDay, letfTaxCloseEvent } from "./letf-dual-sleeve";
import { calcCagr } from "./metrics";
import { SafeHarborTaxes } from "./safe-harbor";
import type { EtfResult, LetfTaxEvent, LetfTaxSchedule } from "./types";

/** A loss on a sale is disallowed when the same sleeve buys the asset back within this many days. */
const WASH_SALE_DAYS = 30;
const MS_PER_DAY = 86_400_000;

export type CapitalGains = { shortTerm: number; longTerm: number };

export function areLetfTaxRatesZero(rates: FuturesTaxRates): boolean {
  return rates.ltcg === 0 && rates.stcg === 0 && rates.state === 0 && rates.medicare === 0;
}

const NO_GAINS: CapitalGains = { shortTerm: 0, longTerm: 0 };

type Lot = { units: number; basis: number; acquired: string };

/** A loss the wash-sale rule disallowed, carried into the purchase that replaces it. */
type WashedLoss = { loss: number; value: number; heldMs: number };

/** Combined marginal rates (federal + state + Medicare surcharge) on each class of gain. */
export function capitalGainsRates(rates: FuturesTaxRates): CapitalGains {
  const surcharge = rates.state + rates.medicare;
  const clamp = (pct: number) => Math.min(1, Math.max(0, pct / 100));
  return { shortTerm: clamp(rates.stcg + surcharge), longTerm: clamp(rates.ltcg + surcharge) };
}

/** Long-term means held more than one year: sold after the purchase's first anniversary. */
export function isLongTermHolding(acquired: string, sold: string): boolean {
  return sold > `${Number(acquired.slice(0, 4)) + 1}${acquired.slice(4)}`;
}

/**
 * One year's tax (Schedule D): each class nets against its own carryover, a net
 * loss in one class offsets a net gain in the other, and an overall loss carries
 * forward keeping its character.
 */
export function settleCapitalGainsYear(
  net: CapitalGains,
  carryover: CapitalGains,
  rates: CapitalGains
): { tax: number; carryover: CapitalGains } {
  const st = net.shortTerm - carryover.shortTerm;
  const lt = net.longTerm - carryover.longTerm;
  if (st >= 0 && lt >= 0) return { tax: st * rates.shortTerm + lt * rates.longTerm, carryover: NO_GAINS };
  if (st < 0 && lt < 0) return { tax: 0, carryover: { shortTerm: -st, longTerm: -lt } };
  const combined = st + lt;
  if (combined >= 0) return { tax: combined * (st < 0 ? rates.longTerm : rates.shortTerm), carryover: NO_GAINS };
  return { tax: 0, carryover: st < 0 ? { shortTerm: -combined, longTerm: 0 } : { shortTerm: 0, longTerm: -combined } };
}

/**
 * The schedule of one simulated LETF sleeve (an SMA line, or buy-and-hold without
 * one), in the result's own dollars: build it before scaling the result. Each
 * regime change sells everything at the open; the prior close stands in for it.
 */
export function buildLetfTaxSchedule(result: EtfResult): LetfTaxSchedule | undefined {
  const { dates, dailyValues } = result;
  if (dates.length < 2 || dailyValues.length !== dates.length) return undefined;
  return buildLetfTaxScheduleFromPath({
    dates,
    dailyValues,
    heldRiskOn: heldRiskOnByDay(result),
    exitFraction: exitFraction(result),
  });
}

function buildLetfTaxScheduleFromPath({
  dates,
  dailyValues,
  heldRiskOn,
  exitFraction: finalExitFraction = 1,
}: {
  dates: readonly string[];
  dailyValues: readonly number[];
  heldRiskOn: readonly boolean[];
  exitFraction?: number;
}): LetfTaxSchedule | undefined {
  if (dates.length < 2 || dailyValues.length !== dates.length || heldRiskOn.length !== dates.length) return undefined;
  const events: LetfTaxEvent[] = [];
  const last = dates.length - 1;
  for (let k = 0; k <= last; k++) {
    if (k > 0 && heldRiskOn[k] !== heldRiskOn[k - 1]) {
      events.push({ date: dates[k], prices: [dailyValues[k - 1]], switched: [true] });
    }
    const closeEvent = letfTaxCloseEvent(dates, k, 0, last, [dailyValues[k]]);
    if (closeEvent) events.push(closeEvent);
  }
  return {
    // The engine's base: the pre-spread starting amount, which `result.cagr` is measured from.
    initialInvestment: CONSTANT_INITIAL_INVESTMENT,
    startDate: dates[0],
    endDate: dates[last],
    startValues: [dailyValues[0]],
    startPrices: [dailyValues[0]],
    exitFractions: [finalExitFraction],
    events,
  };
}

function isUsable(schedule: LetfTaxSchedule): boolean {
  const positive = (v: number) => Number.isFinite(v) && v > 0;
  const sleeves = schedule.startPrices.length;
  return (
    sleeves > 0 &&
    schedule.startValues.length === sleeves &&
    schedule.exitFractions.length === sleeves &&
    schedule.events.length > 0 &&
    schedule.events[schedule.events.length - 1].yearEnd === true &&
    positive(schedule.initialInvestment) &&
    schedule.startPrices.every(positive) &&
    schedule.startValues.every((v) => Number.isFinite(v) && v >= 0) &&
    schedule.exitFractions.every((v) => Number.isFinite(v) && v >= 0) &&
    schedule.events.every((event) => event.prices.length === sleeves && event.prices.every(positive))
  );
}

function shiftIsoDate(date: string, ms: number): string {
  return new Date(Date.parse(date) + ms).toISOString().slice(0, 10);
}

/**
 * The account, sleeve by sleeve. Positions are lots of "sleeve units": a sleeve's
 * own simulated value is the price of whatever it holds, so a lot is worth
 * `units × price` and the lots of a sleeve all hold the same asset.
 */
class LetfTaxLedger {
  readonly lots: Lot[][];
  /** Realized this tax year. */
  private year: CapitalGains = NO_GAINS;
  private carryover: CapitalGains = NO_GAINS;
  private readonly washed: WashedLoss[][];

  constructor(schedule: LetfTaxSchedule, private readonly rates: CapitalGains) {
    const basis = schedule.initialInvestment / schedule.startPrices.length;
    this.lots = schedule.startPrices.map((price, s) => [{
      units: schedule.startValues[s] / price,
      basis,
      acquired: schedule.startDate,
    }]);
    this.washed = this.lots.map(() => []);
  }

  values(prices: readonly number[]): number[] {
    return this.lots.map((lots, s) => lots.reduce((sum, lot) => sum + lot.units * prices[s], 0));
  }

  units(): number[] {
    return this.lots.map((lots) => lots.reduce((sum, lot) => sum + lot.units, 0));
  }

  private realize(gain: number, acquired: string, sold: string): void {
    const key = isLongTermHolding(acquired, sold) ? "longTerm" : "shortTerm";
    this.year = { ...this.year, [key]: this.year[key] + gain };
  }

  /** Sell `fraction` of every lot for `proceeds` in total; `washed` holds back losses that will be bought back. */
  sell(s: number, fraction: number, proceeds: number, date: string, washed = false): void {
    const units = this.lots[s].reduce((sum, lot) => sum + lot.units, 0);
    if (!(units > 0) || !(fraction > 0)) return;
    for (const lot of this.lots[s]) {
      const lotProceeds = proceeds * (lot.units / units);
      const gain = lotProceeds - lot.basis * fraction;
      if (gain < 0 && washed) {
        this.washed[s].push({ loss: -gain, value: lotProceeds, heldMs: Date.parse(date) - Date.parse(lot.acquired) });
      } else {
        this.realize(gain, lot.acquired, date);
      }
    }
    this.lots[s] = fraction >= 1
      ? []
      : this.lots[s].map((lot) => ({ ...lot, units: lot.units * (1 - fraction), basis: lot.basis * (1 - fraction) }));
  }

  /**
   * Buy `value` at `price` for `cost`. A switch's purchase replaces every share the
   * sleeve last sold at a disallowed loss: that loss joins the new lots' basis and
   * their holding period runs on from the old lots'.
   */
  buy(s: number, value: number, cost: number, price: number, date: string, replaces: WashedLoss[] = []): void {
    if (!(value > 0)) return;
    const units = value / price;
    const washedValue = replaces.reduce((sum, w) => sum + w.value, 0);
    const bought = washedValue > 0
      ? replaces.map((w) => ({
          units: units * (w.value / washedValue),
          basis: cost * (w.value / washedValue) + w.loss,
          acquired: shiftIsoDate(date, -w.heldMs),
        }))
      : [{ units, basis: cost, acquired: date }];
    this.lots[s] = [...this.lots[s], ...bought];
  }

  /** Disallowed losses waiting for this sleeve's next purchase of the asset it sold. */
  takeWashed(s: number): WashedLoss[] {
    const pending = this.washed[s];
    this.washed[s] = [];
    return pending;
  }

  /**
   * Pay `cash` out of the account by selling every sleeve pro rata, or reinvest a
   * refund (negative `cash`) the same way. False when the account cannot pay.
   */
  pay(cash: number, prices: readonly number[], date: string): boolean {
    const values = this.values(prices);
    const total = values.reduce((sum, v) => sum + v, 0);
    if (!(total > 0) || cash >= total) return false;
    values.forEach((v, s) => {
      const share = v / total;
      if (cash > 0) this.sell(s, cash / total, cash * share, date);
      else this.buy(s, -cash * share, -cash * share, prices[s], date);
    });
    return true;
  }

  /** The year's tax, after which realized gains count toward the next year. */
  settleYear(): number {
    const { tax, carryover } = settleCapitalGainsYear(this.year, this.carryover, this.rates);
    this.year = NO_GAINS;
    this.carryover = carryover;
    return tax;
  }
}

/** Whether a sale by sleeve `s` at `index` is bought back by its next switch within the wash-sale window. */
function isWashed(events: readonly LetfTaxEvent[], index: number, s: number): boolean {
  const saleDate = events[index].date;
  for (let j = index + 1; j < events.length; j++) {
    if (!events[j].switched?.[s]) continue;
    return (Date.parse(events[j].date) - Date.parse(saleDate)) / MS_PER_DAY <= WASH_SALE_DAYS;
  }
  return false;
}

/** Switch sales, then a fund reset's basket trade, then switch purchases, as the strategy trades. */
function applyTrades(ledger: LetfTaxLedger, events: readonly LetfTaxEvent[], index: number): void {
  const event = events[index];
  const values = ledger.values(event.prices);
  const switched = values.map((_, s) => s).filter((s) => event.switched?.[s]);
  const replaces = values.map((_, s) => (switched.includes(s) ? ledger.takeWashed(s) : []));
  for (const s of switched) ledger.sell(s, 1, values[s], event.date, isWashed(events, index, s));

  const buyFor = switched.map((s) => values[s]);
  if (event.reset && values.length === 2) {
    const fund = values[0] + values[1];
    const cost = event.reset.costFraction * fund;
    const target = (fund - cost) / 2;
    const staying = event.reset.staying;
    if (staying >= 0 && values[staying] > target) {
      const moved = values[staying] - target;
      ledger.sell(staying, moved / values[staying], moved - cost, event.date);
    } else if (staying >= 0 && values[staying] < target) {
      const moved = target - values[staying];
      ledger.buy(staying, moved, moved + cost, event.prices[staying], event.date);
    }
    buyFor.fill(target);
  }
  switched.forEach((s, k) => ledger.buy(s, buyFor[k], buyFor[k], event.prices[s], event.date, replaces[s]));
}

/** One run of the tax ledger over a schedule. */
export type LetfTaxRun = {
  /** Nominal after-tax CAGR (%); -100 when the account could not pay its tax. */
  cagr: number;
  /** What the closing sale leaves once the last tax settles; 0 when the account could not pay. */
  finalValue: number;
  /**
   * Units each sleeve holds once event `j` has executed, for every event before the
   * last. A sleeve's value at any later close is `units × its price`, so a caller can
   * mark the account on days with no event without re-running the ledger.
   */
  unitsAfter: number[][];
  /** Index of the event whose tax payment the account could not meet: empty from then on. */
  ruinedAt?: number;
};

/**
 * Run the ledger: trades, the safe-harbor schedule, then the closing sale, from
 * which whatever is still owed (or owed back) settles. Undefined when the schedule
 * cannot be priced.
 */
export function runLetfTaxLedger(schedule: LetfTaxSchedule, rates: FuturesTaxRates): LetfTaxRun | undefined {
  if (!isUsable(schedule)) return undefined;
  const ledger = new LetfTaxLedger(schedule, capitalGainsRates(rates));
  const taxes = new SafeHarborTaxes();
  const { events } = schedule;
  const last = events.length - 1;
  const unitsAfter: number[][] = [];
  const yearOf = (date: string) => Number(date.slice(0, 4));
  for (let j = 0; j < last; j++) {
    const event = events[j];
    if (event.switched || event.reset) applyTrades(ledger, events, j);
    if (event.yearEnd) taxes.setTax(yearOf(event.date), ledger.settleYear());
    for (const dueDate of event.taxDue ?? []) {
      const cash = taxes.due(dueDate);
      if (cash !== 0 && !ledger.pay(cash, event.prices, event.date)) {
        return { cagr: -100, finalValue: 0, unitsAfter, ruinedAt: j };
      }
    }
    unitsAfter.push(ledger.units());
  }

  const end = events[last];
  const proceeds = ledger.values(end.prices).map((v, s) => v * schedule.exitFractions[s]);
  proceeds.forEach((p, s) => ledger.sell(s, 1, p, end.date));
  taxes.setTax(yearOf(end.date), ledger.settleYear());
  const afterTax = proceeds.reduce((sum, p) => sum + p, 0) - taxes.outstanding();
  return {
    cagr: afterTax > 0 ? calcCagr(schedule.initialInvestment, afterTax, schedule.startDate, schedule.endDate) : -100,
    finalValue: Math.max(0, afterTax),
    unitsAfter,
  };
}

/**
 * Nominal after-tax CAGR (%) for these rates, paying the tax on the safe-harbor
 * schedule and settling what is still owed from the closing sale. Undefined when
 * the schedule cannot be priced.
 */
export function estimateLetfAfterTaxCagr(schedule: LetfTaxSchedule, rates: FuturesTaxRates): number | undefined {
  return runLetfTaxLedger(schedule, rates)?.cagr;
}
