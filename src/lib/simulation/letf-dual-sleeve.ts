// A UPRO + TQQQ fund run as two sleeves, the backtest page's counterpart of the
// futures fund in futures-dual-sleeve.ts, under the same rule: the sleeves are
// never rebalanced against each other except on a day when both were risk-off and
// one is about to go risk-on, when the fund resets to 50/50.
//
// It is composed from the two SMA results the page already has rather than
// re-simulated. An LETF sleeve has only proportional costs, so its path scales
// exactly with its capital: between resets each half compounds by its own sleeve's
// daily growth, and a reset only rescales them.
//
// Unlike the futures fund, which hands baskets over in kind, this one settles the
// reset in cash. The re-entering sleeve sells its basket that morning anyway, so
// the only extra trade is the staying sleeve buying (or selling) the moved amount
// of its own basket, charged at that basket's spread. When both sleeves hold the
// same risk-off asset the move is free, exactly as in the futures fund.

import { CONSTANT_INITIAL_INVESTMENT, formatRiskOffLiquidationAbbrev, getRiskOffSpread } from "@/lib/constants";
import { createPresetEtfConfig, getComboSubPresets, DEFAULT_COMBO_PRESET } from "@/lib/simulation/presets";
import { calcCagr, calcPathMetrics } from "@/lib/simulation/metrics";
import { findEtfResult } from "@/lib/simulation/result-lookup";
import { listSignalRules, type SignalRule } from "@/lib/simulation/signal-rules";
import type { BacktestResult, EtfResult, LetfTaxEvent, LetfTaxSchedule, RiskOffAsset } from "@/lib/simulation/types";
import { trimEtfResultToStartDate } from "@/lib/simulation/trim-etf-result";
import { taxDueDatesBetween } from "@/lib/simulation/safe-harbor";

export const LETF_FUND_RESULT_ID = "dual-sleeve-letf-sma";
const EXTRA_FUND_ID_PREFIX = `${LETF_FUND_RESULT_ID}:`;

export function isLetfComboFundResultId(id: string): boolean {
  return id === LETF_FUND_RESULT_ID || id.startsWith(EXTRA_FUND_ID_PREFIX);
}

export type LetfFundSleeve = { result: EtfResult; riskOffAsset: string };

/**
 * Regime held on each day (true = risk-on) under next-day-open execution: a signal
 * at one close is acted on at the next session. Day 0 holds what its close
 * established, which is what the engine's day-0 position is sized as.
 */
export function heldRiskOnByDay(
  result: Pick<EtfResult, "dates" | "smaSignals" | "smaStartInvested">
): boolean[] {
  let state = result.smaStartInvested ?? true;
  let next = 0;
  return result.dates.map((_, i) => {
    const cutoff = result.dates[Math.max(0, i - 1)];
    // Re-applying a warm-up signal is harmless: each one sets the state outright.
    while (next < result.smaSignals.length && result.smaSignals[next].date <= cutoff) {
      state = result.smaSignals[next].type === "buy";
      next += 1;
    }
    return state;
  });
}

/** Ratio the sleeve's own result applies to its last value for the closing trade. */
export function exitFraction(result: EtfResult): number {
  const last = result.dailyValues[result.dailyValues.length - 1] ?? 0;
  return last > 0 ? Math.min(1, Math.max(0, result.finalValue / last)) : 1;
}

/**
 * The tax event at the close of day `k`, when that close ends a calendar year (or
 * the run) or is the first session on or after an estimated-tax due date.
 */
export function letfTaxCloseEvent(
  dates: readonly string[],
  k: number,
  firstDay: number,
  lastDay: number,
  prices: number[]
): LetfTaxEvent | undefined {
  const yearEnd = k === lastDay || dates[k + 1].slice(0, 4) !== dates[k].slice(0, 4);
  const taxDue = k > firstDay ? taxDueDatesBetween(dates[k - 1], dates[k]) : [];
  if (!yearEnd && taxDue.length === 0) return undefined;
  return { date: dates[k], prices, ...(yearEnd ? { yearEnd } : {}), ...(taxDue.length > 0 ? { taxDue } : {}) };
}

/** One sleeve as {@link composeLetfFundPath} walks it, on the fund's calendar. */
export type LetfFundPathSleeve = {
  /** The sleeve's own day index on each fund day, or -1 when it did not trade that day. */
  dayIndex: ArrayLike<number>;
  dailyValues: ArrayLike<number>;
  /** Regime held on each of the sleeve's own days (see {@link heldRiskOnByDay}). */
  heldRiskOn: ArrayLike<boolean>;
  /** Dollars the sleeve opens with on the first fund day, net of its entry spread. */
  startValue: number;
  riskOffAsset: string;
  /** Share of its last value the sleeve keeps after its closing trade. */
  exitFraction: number;
  totalTradingCostPct: number;
};

/** Each sleeve's dollars and own day index on every fund day of a composed path. */
export type LetfFundSleeveTrack = { values: number[]; dayIndex: number[] };

/**
 * The fund's path over fund days `[firstDay, firstDay + dayCount)`. Both sleeves
 * must have traded on `firstDay`. Given the fund calendar as `taxDates`, it also
 * records the trades and year-ends a tax estimate needs; the rolling-window caller
 * passes none and pays nothing for it. `trackSleeves` also returns each sleeve's
 * dollars per fund day, which the holdings chart splits by ticker.
 */
export function composeLetfFundPath(
  sleeves: readonly [LetfFundPathSleeve, LetfFundPathSleeve],
  firstDay: number,
  dayCount: number,
  taxDates?: readonly string[],
  trackSleeves = false
): {
  dailyValues: number[];
  finalValue: number;
  totalTradingCostPct: number;
  taxEvents?: LetfTaxEvent[];
  sleeveTracks?: [LetfFundSleeveTrack, LetfFundSleeveTrack];
} {
  const sameBasket = sleeves[0].riskOffAsset === sleeves[1].riskOffAsset;
  let value = sleeves.map((sleeve) => sleeve.startValue);
  const cursor = sleeves.map((sleeve) => sleeve.dayIndex[firstDay]);
  const dailyValues = [value[0] + value[1]];
  let resetCost = 0;
  const lastDay = firstDay + dayCount - 1;
  const taxEvents: LetfTaxEvent[] | undefined = taxDates ? [] : undefined;
  const tracks: [LetfFundSleeveTrack, LetfFundSleeveTrack] | undefined = trackSleeves
    ? [{ values: [value[0]], dayIndex: [cursor[0]] }, { values: [value[1]], dayIndex: [cursor[1]] }]
    : undefined;
  const pricesNow = () => sleeves.map((sleeve, s) => sleeve.dailyValues[cursor[s]]);
  const recordClose = (k: number) => {
    if (taxEvents) {
      const closeEvent = letfTaxCloseEvent(taxDates!, k, firstDay, lastDay, pricesNow());
      if (closeEvent) taxEvents.push(closeEvent);
    }
  };
  recordClose(firstDay);

  for (let k = firstDay + 1; k < firstDay + dayCount; k++) {
    const nextIdx = sleeves.map((sleeve) => sleeve.dayIndex[k]);
    const bothWereRiskOff = sleeves.every((sleeve, s) => !sleeve.heldRiskOn[cursor[s]]);
    const turning = nextIdx.map((i, s) => i >= 0 && sleeves[s].heldRiskOn[i]);
    let reset: LetfTaxEvent["reset"];
    if (bothWereRiskOff && turning.some(Boolean)) {
      const fund = value[0] + value[1];
      const staying = turning.findIndex((t) => !t);
      const cost = !sameBasket && staying >= 0
        ? Math.abs(value[staying] - fund / 2) * getRiskOffSpread(sleeves[staying].riskOffAsset, false)
        : 0;
      resetCost += cost;
      value = [(fund - cost) / 2, (fund - cost) / 2];
      reset = { staying, costFraction: fund > 0 ? cost / fund : 0 };
    }
    if (taxEvents) {
      const switched = nextIdx.map((i, s) => i >= 0 && sleeves[s].heldRiskOn[i] !== sleeves[s].heldRiskOn[cursor[s]]);
      if (reset || switched.some(Boolean)) {
        taxEvents.push({
          date: taxDates![k],
          prices: pricesNow(),
          ...(switched.some(Boolean) ? { switched } : {}),
          ...(reset ? { reset } : {}),
        });
      }
    }
    value = value.map((v, s) => {
      const i = nextIdx[s];
      if (i < 0) return v;
      const prev = sleeves[s].dailyValues[cursor[s]];
      const growth = prev > 0 ? sleeves[s].dailyValues[i] / prev : 0;
      cursor[s] = i;
      return v * growth;
    });
    dailyValues.push(value[0] + value[1]);
    tracks?.forEach((track, s) => {
      track.values.push(value[s]);
      track.dayIndex.push(cursor[s]);
    });
    recordClose(k);
  }

  const finalValue = value.reduce((sum, v, s) => sum + v * sleeves[s].exitFraction, 0);
  // Each sleeve's costs scale with the share of the fund it ended with; approximate
  // across resets, exact (to rounding) when none fires.
  const sleeveCosts = sleeves.reduce(
    (sum, sleeve, s) => sum + (sleeve.totalTradingCostPct / 100) * value[s] * sleeve.exitFraction,
    0
  );
  return {
    dailyValues,
    finalValue,
    totalTradingCostPct: finalValue > 0 ? ((sleeveCosts + resetCost) / finalValue) * 100 : 0,
    ...(taxEvents ? { taxEvents } : {}),
    ...(tracks ? { sleeveTracks: tracks } : {}),
  };
}

/** The tax schedule of a fund composed over `[firstDay, lastDay]` with `taxDates`. */
export function letfFundTaxSchedule(
  sleeves: readonly [LetfFundPathSleeve, LetfFundPathSleeve],
  firstDay: number,
  lastDay: number,
  dates: readonly string[],
  events: LetfTaxEvent[]
): LetfTaxSchedule {
  const pair = (of: (sleeve: LetfFundPathSleeve) => number) => [of(sleeves[0]), of(sleeves[1])];
  return {
    // Same base the sleeves use: the pre-spread starting amount, so entry costs count.
    initialInvestment: CONSTANT_INITIAL_INVESTMENT,
    startDate: dates[firstDay],
    endDate: dates[lastDay],
    startValues: pair((sleeve) => sleeve.startValue),
    startPrices: pair((sleeve) => sleeve.dailyValues[sleeve.dayIndex[firstDay]]),
    exitFractions: pair((sleeve) => sleeve.exitFraction),
    events,
  };
}

/** Both sleeves on the fund's calendar: the union of their trading days. */
export function toLetfFundPathSleeves(
  primary: LetfFundSleeve,
  secondary: LetfFundSleeve
): { dates: string[]; sleeves: [LetfFundPathSleeve, LetfFundPathSleeve] } {
  const dates = [...new Set([...primary.result.dates, ...secondary.result.dates])].sort();
  const toPath = ({ result, riskOffAsset }: LetfFundSleeve): LetfFundPathSleeve => {
    const indexByDate = new Map(result.dates.map((date, i) => [date, i]));
    return {
      dayIndex: dates.map((date) => indexByDate.get(date) ?? -1),
      dailyValues: result.dailyValues,
      heldRiskOn: heldRiskOnByDay(result),
      startValue: result.dailyValues[0] / 2,
      riskOffAsset,
      exitFraction: exitFraction(result),
      totalTradingCostPct: result.totalTradingCostPct,
    };
  };
  return { dates, sleeves: [toPath(primary), toPath(secondary)] };
}

/**
 * The fund's daily values on the union of the sleeves' calendars, or null when the
 * sleeves do not start together (a 50/50 fund needs both from day one).
 */
export function composeLetfDualSleeveFund(params: {
  id: string;
  name: string;
  primary: LetfFundSleeve;
  secondary: LetfFundSleeve;
}): EtfResult | null {
  const sleeves = [params.primary, params.secondary];
  if (sleeves.some(({ result }) => result.dates.length < 2 || !(result.dailyValues[0] > 0))) return null;
  if (sleeves[0].result.dates[0] !== sleeves[1].result.dates[0]) return null;

  const { dates, sleeves: [primary, secondary] } = toLetfFundPathSleeves(params.primary, params.secondary);
  const { dailyValues, finalValue, totalTradingCostPct, taxEvents } = composeLetfFundPath(
    [primary, secondary], 0, dates.length, dates
  );
  return {
    id: params.id,
    name: params.name,
    sourceIndex: params.primary.result.sourceIndex,
    dates,
    dailyValues,
    finalValue,
    // Same base the sleeves use: the pre-spread starting amount, so entry costs count.
    cagr: calcCagr(CONSTANT_INITIAL_INVESTMENT, finalValue, dates[0], dates[dates.length - 1]),
    ...calcPathMetrics(dailyValues, dates),
    // Two SMAs drive it, so there is no single SMA line or signal list to chart.
    smaSignals: [],
    smaPrices: [],
    totalTradingCostPct,
    taxSchedule: letfFundTaxSchedule([primary, secondary], 0, dates.length - 1, dates, taxEvents ?? []),
  };
}

/**
 * The UPRO/TQQQ fund built from its two SMA sleeves (UPRO on SPX, TQQQ on NDX), or
 * null when they cannot form one. The backtest and futures pages both show it as
 * "TQQQ/UPRO SMA", so both build it here.
 */
export type LetfComboSleeves = {
  /** UPRO on SPX, then TQQQ on NDX, both opening on the fund's start date. */
  sleeves: [LetfFundSleeve, LetfFundSleeve];
  /** The LETF each sleeve holds while risk-on, in sleeve order. */
  letfNames: [string, string];
};

/**
 * The fund's two sleeves, both opening on the later of their starts: "SPX/NDX
 * start" opens UPRO in 1988 and TQQQ in 1985, and a 50/50 fund needs both, so the
 * earlier sleeve enters there as a fresh position.
 */
export function alignLetfComboSleeves(params: {
  spxSleeve: EtfResult;
  ndxSleeve: EtfResult;
  spxRiskOffAsset: string;
  ndxRiskOffAsset: string;
}): LetfComboSleeves {
  const { spxSleeve, ndxSleeve, spxRiskOffAsset, ndxRiskOffAsset } = params;
  const subPresets = getComboSubPresets(DEFAULT_COMBO_PRESET);
  const sleeveRiskOffAssets = [spxRiskOffAsset, ndxRiskOffAsset] as RiskOffAsset[];
  const fundStartDate = spxSleeve.dates[0] > ndxSleeve.dates[0] ? spxSleeve.dates[0] : ndxSleeve.dates[0];
  const [primary, secondary] = [spxSleeve, ndxSleeve].map((etf, k) => (
    etf.dates[0] === fundStartDate
      ? etf
      : trimEtfResultToStartDate(etf, fundStartDate, createPresetEtfConfig(`etf${k + 1}`, subPresets[k], {
          riskOffAsset: sleeveRiskOffAssets[k],
        }))
  ));
  return {
    sleeves: [
      { result: primary, riskOffAsset: spxRiskOffAsset },
      { result: secondary, riskOffAsset: ndxRiskOffAsset },
    ],
    letfNames: [subPresets[0].name, subPresets[1].name],
  };
}

export function buildLetfComboFund(params: {
  spxSleeve: EtfResult;
  ndxSleeve: EtfResult;
  spxRiskOffAsset: string;
  ndxRiskOffAsset: string;
  rule?: Pick<SignalRule, "id" | "title">;
}): EtfResult | null {
  const { spxRiskOffAsset, ndxRiskOffAsset, rule } = params;
  const { sleeves: [primarySleeve, secondarySleeve] } = alignLetfComboSleeves(params);
  const primary = primarySleeve.result;
  const volRsi = primary.name.includes("(SMA Vol RSI") ? " Vol RSI" : "";
  const riskOff = [spxRiskOffAsset, ndxRiskOffAsset].map(formatRiskOffLiquidationAbbrev).join(" / ");
  return composeLetfDualSleeveFund({
    id: rule ? EXTRA_FUND_ID_PREFIX + rule.id : LETF_FUND_RESULT_ID,
    // The results table and chart shorten this to "TQQQ/UPRO SMA Vol RSI".
    name: rule ? `TQQQ/UPRO 50/50 · ${rule.title}` : `TQQQ/UPRO (SMA${volRsi}, ${riskOff})`,
    primary: primarySleeve,
    secondary: secondarySleeve,
  });
}

/**
 * The run settings needed to compose UPRO/TQQQ from its completed sleeves.
 */
export type LetfComboRun = { letf: string; spxRiskOffAsset: string; ndxRiskOffAsset: string };

/** Find the two completed sleeves of a fund, including their risk-off assets. */
export function findLetfComboSleeves(
  result: BacktestResult | null,
  run: LetfComboRun | null,
  fundId = LETF_FUND_RESULT_ID
): Parameters<typeof alignLetfComboSleeves>[0] | null {
  if (!result || run?.letf !== DEFAULT_COMBO_PRESET || !isLetfComboFundResultId(fundId)) return null;
  const ruleId = fundId === LETF_FUND_RESULT_ID ? undefined : fundId.slice(EXTRA_FUND_ID_PREFIX.length);
  const rule = ruleId ? listSignalRules().find((candidate) => candidate.id === ruleId) : undefined;
  if (ruleId && !rule) return null;

  // The combo's sub-presets are configs etf1 and etf2, in this order.
  const [spxSleeve, ndxSleeve] = getComboSubPresets(DEFAULT_COMBO_PRESET).map((preset, k) => {
    if (rule) {
      return result.etfResults.find((etf) => etf.signalRule === rule.id &&
        etf.sourceIndex === preset.index && etf.name.startsWith(`${preset.name} (`));
    }
    const etf = findEtfResult(result, `etf${k + 1}-sma`);
    return etf && etf.name.startsWith(`${preset.name} (SMA`) ? etf : undefined;
  });
  return spxSleeve && ndxSleeve ? {
    spxSleeve,
    ndxSleeve,
    spxRiskOffAsset: rule?.riskOffAsset ?? run.spxRiskOffAsset,
    ndxRiskOffAsset: rule?.riskOffAsset ?? run.ndxRiskOffAsset,
  } : null;
}

/** Compose the default fund and each selected extra with two completed sleeves. */
export function withLetfComboFund(
  result: BacktestResult | null,
  run: LetfComboRun | null
): BacktestResult | null {
  if (!result || result.etfResults.some((etf) => isLetfComboFundResultId(etf.id))) return result;
  const found = findLetfComboSleeves(result, run);
  if (!found) return result;
  const fund = buildLetfComboFund(found);
  const selected = new Set(result.etfResults.map((etf) => etf.signalRule));
  const extraFunds = listSignalRules().filter((rule) => selected.has(rule.id)).flatMap((rule) => {
    const sleeves = findLetfComboSleeves(result, run, EXTRA_FUND_ID_PREFIX + rule.id);
    const extraFund = sleeves && buildLetfComboFund({ ...sleeves, rule });
    return extraFund ? [extraFund] : [];
  });
  const funds = fund ? [fund, ...extraFunds] : extraFunds;
  return funds.length ? { ...result, etfResults: [...funds, ...result.etfResults] } : result;
}
