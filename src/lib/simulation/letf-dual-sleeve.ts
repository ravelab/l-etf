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
import { getComboSubPresets, DEFAULT_COMBO_PRESET } from "@/lib/simulation/presets";
import { calcCagr, calcMaxDrawdown, calcMonthlyExtremes, calcSortinoRatio } from "@/lib/simulation/metrics";
import { findEtfResult } from "@/lib/simulation/result-lookup";
import type { BacktestResult, EtfResult } from "@/lib/simulation/types";

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

  const held = sleeves.map(({ result }) => heldRiskOnByDay(result));
  const dayIndexByDate = sleeves.map(({ result }) => new Map(result.dates.map((date, i) => [date, i])));
  const dates = [...new Set(sleeves.flatMap(({ result }) => result.dates))].sort();
  const sameBasket = sleeves[0].riskOffAsset === sleeves[1].riskOffAsset;

  // Each sleeve opens with half the fund, already net of its own entry spread.
  let value = sleeves.map(({ result }) => result.dailyValues[0] / 2);
  const cursor = sleeves.map(() => 0);
  const dailyValues = [value[0] + value[1]];
  let resetCost = 0;

  for (let k = 1; k < dates.length; k++) {
    const nextIdx = dayIndexByDate.map((byDate) => byDate.get(dates[k]));
    const bothWereRiskOff = held.every((h, s) => !h[cursor[s]]);
    const turning = nextIdx.map((i, s) => i !== undefined && held[s][i]);
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
      if (i === undefined) return v;
      const prev = sleeves[s].result.dailyValues[cursor[s]];
      const growth = prev > 0 ? sleeves[s].result.dailyValues[i] / prev : 0;
      cursor[s] = i;
      return v * growth;
    });
    dailyValues.push(value[0] + value[1]);
  }

  const finalValue = value.reduce((sum, v, s) => sum + v * exitFraction(sleeves[s].result), 0);
  // Each sleeve's costs scale with the share of the fund it ended with; approximate
  // across resets, exact (to rounding) when none fires.
  const sleeveCosts = sleeves.reduce(
    (sum, { result }, s) => sum + (result.totalTradingCostPct / 100) * value[s] * exitFraction(result),
    0
  );
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
    totalTradingCostPct: finalValue > 0 ? ((sleeveCosts + resetCost) / finalValue) * 100 : 0,
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
  const [primary, secondary] = getComboSubPresets(DEFAULT_COMBO_PRESET).map((preset, k) => {
    const etf = findEtfResult(result, `etf${k + 1}-sma`);
    return etf && etf.name.startsWith(`${preset.name} (SMA`) ? etf : undefined;
  });
  if (!primary || !secondary) return result;
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
