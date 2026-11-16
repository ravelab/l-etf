// After-tax results for windows of one strategy path, the single routine every
// rolling page goes through (window-extraction.ts, wrapped-window.ts, the
// forward-return chart). Worker-safe: no simulation, no Worker construction.
//
// Taxing a window by replaying the ledger every day costs O(window) per window,
// which made rolling sweeps ~60x slower. It does not need to: an LETF sleeve's
// position only changes when it trades, and the ledger only acts on switches,
// year-ends and estimated-tax due dates. So a calendar of those days is built
// once per path, each window runs the ledger on its own few events, and the
// after-tax path is the pretax path times a units count that only changes at an
// event. Its max drawdown then comes from range queries over the pretax series,
// one per span between tax payments, instead of a daily walk.

import { CONSTANT_INITIAL_INVESTMENT } from "../constants";
import type { FuturesTaxRates } from "./futures-tax";
import { areLetfTaxRatesZero, capitalGainsRates, isLongTermHolding, runLetfTaxLedger, type LetfTaxRun } from "./letf-tax";
import { taxDueDatesBetween } from "./safe-harbor";
import { composeLetfFundPath, letfFundTaxSchedule, type LetfFundPathSleeve } from "./letf-dual-sleeve";
import type { RollingSimulationPoint } from "./rolling";
import type { LetfTaxEvent, LetfTaxSchedule } from "./types";

/** The days of one path on which the tax ledger can act. */
export interface TaxCalendar {
  dates: readonly string[];
  /** Days whose held regime differs from the day before: the switch trades at that day's open. */
  switchDays: Int32Array;
  /** Days whose next session falls in a later calendar year. */
  yearEndDays: Int32Array;
  /** First session on or after an estimated-tax due date, with the dates it settles. */
  dueDays: Int32Array;
  dueDatesByDay: ReadonlyMap<number, string[]>;
}

/** The after-tax counterpart of a window's final value, CAGR and max drawdown. */
export interface AfterTaxWindowResult {
  finalValue: number;
  cagr: number;
  maxDrawdownPct: number;
}

/** Max drawdown (%) and raw min/max of a path over `[startDay, endDay]`. */
export type PathRangeStats = (startDay: number, endDay: number) => { pct: number; min: number; max: number };

const NO_DUE_DATES: string[] = [];

/** `taxDueDatesBetween`, skipping the common case of two sessions in a month with no due date between them. */
function dueDatesCrossed(after: string, through: string): string[] {
  if (after.slice(0, 7) === through.slice(0, 7)) {
    const month = after.slice(5, 7);
    if (month !== "01" && month !== "04" && month !== "06" && month !== "09") return NO_DUE_DATES;
    if (after.slice(8) >= "15" || through.slice(8) < "15") return NO_DUE_DATES;
  }
  return taxDueDatesBetween(after, through);
}

/** O(n), once per path. `heldRiskOn(day)` is the regime held through that day's session. */
export function buildTaxCalendar(dates: readonly string[], heldRiskOn: (day: number) => boolean): TaxCalendar {
  const switchDays: number[] = [];
  const yearEndDays: number[] = [];
  const dueDays: number[] = [];
  const dueDatesByDay = new Map<number, string[]>();
  let previousHeld = dates.length > 0 ? heldRiskOn(0) : true;
  for (let day = 0; day < dates.length; day++) {
    if (day > 0) {
      const held = heldRiskOn(day);
      if (held !== previousHeld) switchDays.push(day);
      previousHeld = held;
      const due = dueDatesCrossed(dates[day - 1], dates[day]);
      if (due.length > 0) {
        dueDays.push(day);
        dueDatesByDay.set(day, due);
      }
    }
    if (day + 1 < dates.length && dates[day + 1].slice(0, 4) !== dates[day].slice(0, 4)) yearEndDays.push(day);
  }
  return {
    dates,
    switchDays: Int32Array.from(switchDays),
    yearEndDays: Int32Array.from(yearEndDays),
    dueDays: Int32Array.from(dueDays),
    dueDatesByDay,
  };
}

function lowerBound(days: Int32Array, day: number): number {
  let lo = 0;
  let hi = days.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (days[mid] < day) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const dayAt = (days: Int32Array, i: number) => (i < days.length ? days[i] : Infinity);

/**
 * The tax schedule of a position opened at `startDay`'s close and sold at `endDay`'s:
 * a switch inside the window sells everything at the open (the prior close stands
 * in), and each year-end and due date settles. `valueAt(day)` is the position's
 * value in dollars, already net of the entry spread; `exitFraction` is the share
 * the closing trade keeps. The same events a daily schedule would hold, minus the
 * days nothing happens.
 */
export function buildWindowTaxSchedule(params: {
  calendar: TaxCalendar;
  startDay: number;
  endDay: number;
  valueAt: (day: number) => number;
  exitFraction: number;
}): { schedule: LetfTaxSchedule; eventDays: number[] } {
  const { calendar, startDay, endDay, valueAt, exitFraction } = params;
  const events: LetfTaxEvent[] = [];
  const eventDays: number[] = [];
  let si = lowerBound(calendar.switchDays, startDay + 1);
  let yi = lowerBound(calendar.yearEndDays, startDay);
  let di = lowerBound(calendar.dueDays, startDay + 1);
  for (;;) {
    const day = Math.min(dayAt(calendar.switchDays, si), dayAt(calendar.yearEndDays, yi), dayAt(calendar.dueDays, di), endDay);
    const date = calendar.dates[day];
    if (dayAt(calendar.switchDays, si) === day) {
      events.push({ date, prices: [valueAt(day - 1)], switched: [true] });
      eventDays.push(day);
      si++;
    }
    const isYearEnd = day === endDay || dayAt(calendar.yearEndDays, yi) === day;
    if (dayAt(calendar.yearEndDays, yi) === day) yi++;
    const taxDue = dayAt(calendar.dueDays, di) === day ? calendar.dueDatesByDay.get(day) : undefined;
    if (taxDue) di++;
    if (isYearEnd || taxDue) {
      events.push({
        date,
        prices: [valueAt(day)],
        ...(isYearEnd ? { yearEnd: true } : {}),
        ...(taxDue ? { taxDue } : {}),
      });
      eventDays.push(day);
    }
    if (day >= endDay) break;
  }
  const startValue = valueAt(startDay);
  return {
    schedule: {
      // The engine's base: the pre-spread starting amount, which the pretax CAGR is measured from.
      initialInvestment: CONSTANT_INITIAL_INVESTMENT,
      startDate: calendar.dates[startDay],
      endDate: calendar.dates[endDay],
      startValues: [startValue],
      startPrices: [startValue],
      exitFractions: [exitFraction],
      events,
    },
    eventDays,
  };
}

/**
 * Max drawdown (%) of the after-tax path: `scale × units × raw value` on each day
 * before the last, then the closing sale net of tax. Units change only at events,
 * so each span between changes is one range query.
 */
function afterTaxMaxDrawdownPct(
  run: LetfTaxRun,
  eventDays: readonly number[],
  startDay: number,
  endDay: number,
  scale: number,
  stats: PathRangeStats
): number {
  let peak = 0;
  let maxDrawdown = 0;
  const visit = (from: number, to: number, units: number) => {
    if (to < from) return;
    const range = stats(from, to);
    const multiplier = scale * units;
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - multiplier * range.min) / peak);
    maxDrawdown = Math.max(maxDrawdown, range.pct / 100);
    peak = Math.max(peak, multiplier * range.max);
  };
  let from = startDay;
  let units = 1;
  const executed = run.ruinedAt ?? run.unitsAfter.length;
  for (let j = 0; j < executed; j++) {
    const next = run.unitsAfter[j][0];
    if (next === units) continue;
    visit(from, eventDays[j] - 1, units);
    from = eventDays[j];
    units = next;
  }
  if (run.ruinedAt !== undefined) {
    visit(from, eventDays[run.ruinedAt] - 1, units);
    return 100;
  }
  visit(from, endDay - 1, units);
  if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - run.finalValue) / peak);
  return Math.min(100, Math.max(0, maxDrawdown * 100));
}

/**
 * One window of a path, taxed: opened at `startDay`'s close for `scale × raw[startDay]`
 * dollars and sold at `endDay`'s. Null when the window cannot be priced.
 */
export function afterTaxWindowResult(params: {
  calendar: TaxCalendar;
  startDay: number;
  endDay: number;
  /** Raw path; dollars are `scale × raw`. */
  raw: ArrayLike<number>;
  scale: number;
  exitFraction: number;
  rates: FuturesTaxRates;
  stats: PathRangeStats;
}): AfterTaxWindowResult | null {
  const { calendar, startDay, endDay, raw, scale, exitFraction, rates, stats } = params;
  if (endDay <= startDay) return null;
  const { schedule, eventDays } = buildWindowTaxSchedule({
    calendar,
    startDay,
    endDay,
    valueAt: (day) => raw[day] * scale,
    exitFraction,
  });
  const run = runLetfTaxLedger(schedule, rates);
  if (!run) return null;
  return {
    finalValue: run.finalValue,
    cagr: run.cagr,
    maxDrawdownPct: afterTaxMaxDrawdownPct(run, eventDays, startDay, endDay, scale, stats),
  };
}

/** Range stats by walking the span: for a path taxed once, where a range tree would not pay for itself. */
export function walkPathRangeStats(values: ArrayLike<number>): PathRangeStats {
  return (startDay, endDay) => {
    let min = Infinity;
    let max = -Infinity;
    let peak = -Infinity;
    let maxDrawdown = 0;
    for (let day = startDay; day <= endDay; day++) {
      const value = values[day];
      if (value < min) min = value;
      if (value > max) max = value;
      if (value > peak) peak = value;
      if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - value) / peak);
    }
    return { pct: maxDrawdown * 100, min, max };
  };
}

/**
 * A whole path taxed once (a history-wrap window stitched from two series). `values`
 * are dollars from the opening close; `heldRiskOn[day]` is the regime held that session.
 */
export function afterTaxPathResult(params: {
  dates: readonly string[];
  values: readonly number[];
  heldRiskOn: readonly boolean[];
  exitFraction: number;
  rates: FuturesTaxRates;
}): AfterTaxWindowResult | null {
  const { dates, values, heldRiskOn, exitFraction, rates } = params;
  if (dates.length < 2 || values.length !== dates.length || heldRiskOn.length !== dates.length) return null;
  return afterTaxWindowResult({
    calendar: buildTaxCalendar(dates, (day) => heldRiskOn[day]),
    startDay: 0,
    endDay: dates.length - 1,
    raw: values,
    scale: 1,
    exitFraction,
    rates,
    stats: walkPathRangeStats(values),
  });
}

/**
 * A position bought at `startDate` and sold at `endDate` with nothing in between
 * (the 1x index benchmark, SGOV): the gain is taxed once, when sold. Long-term when
 * held over a year, unless it is ordinary income (Treasury bill interest). A loss
 * leaves nothing to tax.
 */
export function buyAndHoldAfterTaxValue(params: {
  initialValue: number;
  finalValue: number;
  startDate: string;
  endDate: string;
  rates: FuturesTaxRates;
  ordinaryIncome?: boolean;
}): number {
  const { initialValue, finalValue, startDate, endDate, rates, ordinaryIncome = false } = params;
  const gain = finalValue - initialValue;
  if (!(gain > 0) || areLetfTaxRatesZero(rates)) return finalValue;
  const { shortTerm, longTerm } = capitalGainsRates(rates);
  const rate = !ordinaryIncome && isLongTermHolding(startDate, endDate) ? longTerm : shortTerm;
  return finalValue - gain * rate;
}

/** Whether these rates tax anything; at 0% every after-tax figure equals its pretax one. */
export function taxesApply(rates: FuturesTaxRates | undefined): rates is FuturesTaxRates {
  return rates !== undefined && !areLetfTaxRatesZero(rates);
}

/**
 * A rolling window's result with tax applied: final value, CAGR, total return and
 * max drawdown become after-tax (so every summary, percentile and chart built on
 * them is after-tax), the 1x benchmark is taxed as a buy-and-hold, and the pretax
 * CAGR is kept for the one column that shows it. A path the ledger cannot price was
 * wiped out, which is a total loss after tax as before it.
 */
export function withAfterTaxWindow(
  point: RollingSimulationPoint,
  afterTax: AfterTaxWindowResult | null,
  rates: FuturesTaxRates
): RollingSimulationPoint {
  const taxed = afterTax ?? { finalValue: 0, cagr: -100, maxDrawdownPct: 100 };
  return {
    ...point,
    finalValue: taxed.finalValue,
    cagr: taxed.cagr,
    totalReturnPct: ((taxed.finalValue - CONSTANT_INITIAL_INVESTMENT) / CONSTANT_INITIAL_INVESTMENT) * 100,
    maxDrawdownPct: taxed.maxDrawdownPct,
    nonLeveragedFinalValue: buyAndHoldAfterTaxValue({
      initialValue: CONSTANT_INITIAL_INVESTMENT,
      finalValue: point.nonLeveragedFinalValue,
      startDate: point.startDate,
      endDate: point.endDate,
      rates,
    }),
    preTaxCagr: point.cagr,
  };
}

/** The fund's tax ledger over fund days `[firstDay, firstDay + dayCount)`, when only its outcome is needed. */
export function runLetfFundTaxLedger(params: {
  sleeves: readonly [LetfFundPathSleeve, LetfFundPathSleeve];
  firstDay: number;
  dayCount: number;
  dates: readonly string[];
  rates: FuturesTaxRates;
}): { schedule: LetfTaxSchedule; run: LetfTaxRun } | null {
  const { sleeves, firstDay, dayCount, dates, rates } = params;
  const fund = composeLetfFundPath(sleeves, firstDay, dayCount, dates);
  const schedule = letfFundTaxSchedule(sleeves, firstDay, firstDay + dayCount - 1, dates, fund.taxEvents ?? []);
  const run = runLetfTaxLedger(schedule, rates);
  return run ? { schedule, run } : null;
}

/**
 * The UPRO/TQQQ fund over fund days `[firstDay, firstDay + dayCount)`, taxed as one
 * account (a loss in one sleeve offsets a gain in the other): its after-tax final
 * value, CAGR and max drawdown. The fund walks its window daily anyway, so the
 * after-tax path is marked on every close from the units the ledger holds.
 */
export function afterTaxLetfFundWindow(params: {
  sleeves: readonly [LetfFundPathSleeve, LetfFundPathSleeve];
  firstDay: number;
  dayCount: number;
  dates: readonly string[];
  rates: FuturesTaxRates;
}): AfterTaxWindowResult | null {
  const { sleeves, firstDay, dayCount, dates } = params;
  const lastDay = firstDay + dayCount - 1;
  const taxed = runLetfFundTaxLedger(params);
  if (!taxed) return null;
  const { schedule, run } = taxed;

  const { events } = schedule;
  const executed = run.ruinedAt ?? run.unitsAfter.length;
  let units = schedule.startValues.map((value, s) => value / schedule.startPrices[s]);
  const cursor = sleeves.map((sleeve) => sleeve.dayIndex[firstDay]);
  let next = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (let day = firstDay; day < lastDay; day++) {
    sleeves.forEach((sleeve, s) => {
      if (sleeve.dayIndex[day] >= 0) cursor[s] = sleeve.dayIndex[day];
    });
    while (next < executed && events[next].date <= dates[day]) units = run.unitsAfter[next++];
    const value = units.reduce((sum, u, s) => sum + u * sleeves[s].dailyValues[cursor[s]], 0);
    if (value > peak) peak = value;
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - value) / peak);
  }
  // An account that could not pay its tax was emptied: a total loss.
  if (run.ruinedAt !== undefined) return { finalValue: 0, cagr: -100, maxDrawdownPct: 100 };
  if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - run.finalValue) / peak);
  return { finalValue: run.finalValue, cagr: run.cagr, maxDrawdownPct: Math.min(100, maxDrawdown * 100) };
}
