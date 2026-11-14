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
import { calcCagr, calcMaxDrawdown, calcMonthlyExtremes, calcSortinoRatio } from "@/lib/simulation/metrics";
import { findEtfResult } from "@/lib/simulation/result-lookup";
import type { BacktestResult, EtfResult, RiskOffAsset } from "@/lib/simulation/types";
import { trimEtfResultToStartDate } from "@/lib/simulation/trim-etf-result";

export const LETF_FUND_RESULT_ID = "dual-sleeve-letf-sma";

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
function exitFraction(result: EtfResult): number {
  const last = result.dailyValues[result.dailyValues.length - 1] ?? 0;
  return last > 0 ? Math.min(1, Math.max(0, result.finalValue / last)) : 1;
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

/**
 * The fund's path over fund days `[firstDay, firstDay + dayCount)`. Both sleeves
 * must have traded on `firstDay`.
 */
export function composeLetfFundPath(
  sleeves: readonly [LetfFundPathSleeve, LetfFundPathSleeve],
  firstDay: number,
  dayCount: number
): { dailyValues: number[]; finalValue: number; totalTradingCostPct: number } {
  const sameBasket = sleeves[0].riskOffAsset === sleeves[1].riskOffAsset;
  let value = sleeves.map((sleeve) => sleeve.startValue);
  const cursor = sleeves.map((sleeve) => sleeve.dayIndex[firstDay]);
  const dailyValues = [value[0] + value[1]];
  let resetCost = 0;

  for (let k = firstDay + 1; k < firstDay + dayCount; k++) {
    const nextIdx = sleeves.map((sleeve) => sleeve.dayIndex[k]);
    const bothWereRiskOff = sleeves.every((sleeve, s) => !sleeve.heldRiskOn[cursor[s]]);
    const turning = nextIdx.map((i, s) => i >= 0 && sleeves[s].heldRiskOn[i]);
    if (bothWereRiskOff && turning.some(Boolean)) {
      const fund = value[0] + value[1];
      const staying = turning.findIndex((t) => !t);
      const cost = !sameBasket && staying >= 0
        ? Math.abs(value[staying] - fund / 2) * getRiskOffSpread(sleeves[staying].riskOffAsset, false)
        : 0;
      resetCost += cost;
      value = [(fund - cost) / 2, (fund - cost) / 2];
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
  };
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

  const dates = [...new Set(sleeves.flatMap(({ result }) => result.dates))].sort();
  const [primary, secondary] = sleeves.map(({ result, riskOffAsset }): LetfFundPathSleeve => {
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
  });
  const { dailyValues, finalValue, totalTradingCostPct } = composeLetfFundPath([primary, secondary], 0, dates.length);
  const drawdown = calcMaxDrawdown(dailyValues, dates);
  const months = calcMonthlyExtremes(dailyValues, dates);

  return {
    id: params.id,
    name: params.name,
    sourceIndex: params.primary.result.sourceIndex,
    dates,
    dailyValues,
    finalValue,
    // Same base the sleeves use: the pre-spread starting amount, so entry costs count.
    cagr: calcCagr(CONSTANT_INITIAL_INVESTMENT, finalValue, dates[0], dates[dates.length - 1]),
    sortinoRatio: calcSortinoRatio(dailyValues),
    maxDrawdownPct: drawdown.pct,
    maxDrawdownDollar: drawdown.dollar,
    maxDrawdownDates: drawdown.maxDrawdownDates,
    longestDrawdownDays: drawdown.longestDays,
    longestDrawdownDates: drawdown.longestDrawdownDates,
    bestMonth: months.bestMonth,
    bestMonthDates: months.bestMonthDates,
    worstMonth: months.worstMonth,
    worstMonthDates: months.worstMonthDates,
    // Two SMAs drive it, so there is no single SMA line or signal list to chart.
    smaSignals: [],
    smaPrices: [],
    totalTradingCostPct,
  };
}

/**
 * The backtest page's result with the fund appended, when the run was the
 * UPRO+TQQQ preset with SMA on (both `-sma` sleeves present). Everything else is
 * returned untouched. Derived on display, so a fresh run, a cached one and the
 * canned snapshot all get it without storing it.
 */
export function withLetfComboFund(
  result: BacktestResult | null,
  run: { letf: string; spxRiskOffAsset: string; ndxRiskOffAsset: string } | null
): BacktestResult | null {
  if (!result || run?.letf !== DEFAULT_COMBO_PRESET) return result;
  if (result.etfResults.some((etf) => etf.id === LETF_FUND_RESULT_ID)) return result;
  // The combo's sub-presets are configs etf1 and etf2, in this order.
  const subPresets = getComboSubPresets(DEFAULT_COMBO_PRESET);
  const sleeveRiskOffAssets = [run.spxRiskOffAsset, run.ndxRiskOffAsset] as RiskOffAsset[];
  const [spxSleeve, ndxSleeve] = subPresets.map((preset, k) => {
    const etf = findEtfResult(result, `etf${k + 1}-sma`);
    return etf && etf.name.startsWith(`${preset.name} (SMA`) ? etf : undefined;
  });
  if (!spxSleeve || !ndxSleeve) return result;
  // "SPX/NDX start" opens UPRO in 1988 and TQQQ in 1985. The fund needs both, so it
  // opens on the later start, the earlier sleeve entering there as a fresh position.
  const fundStartDate = spxSleeve.dates[0] > ndxSleeve.dates[0] ? spxSleeve.dates[0] : ndxSleeve.dates[0];
  const [primary, secondary] = [spxSleeve, ndxSleeve].map((etf, k) => (
    etf.dates[0] === fundStartDate
      ? etf
      : trimEtfResultToStartDate(etf, fundStartDate, createPresetEtfConfig(`etf${k + 1}`, subPresets[k], {
          riskOffAsset: sleeveRiskOffAssets[k],
        }))
  ));
  const volRsi = primary.name.includes("(SMA Vol RSI") ? " Vol RSI" : "";
  const riskOff = [run.spxRiskOffAsset, run.ndxRiskOffAsset].map(formatRiskOffLiquidationAbbrev).join(" / ");
  const fund = composeLetfDualSleeveFund({
    id: LETF_FUND_RESULT_ID,
    // The results table and chart shorten this to "TQQQ/UPRO SMA Vol RSI".
    name: `TQQQ/UPRO (SMA${volRsi}, ${riskOff})`,
    primary: { result: primary, riskOffAsset: run.spxRiskOffAsset },
    secondary: { result: secondary, riskOffAsset: run.ndxRiskOffAsset },
  });
  return fund ? { ...result, etfResults: [...result.etfResults, fund] } : result;
}
