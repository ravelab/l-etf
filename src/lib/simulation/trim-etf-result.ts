import {
  CONSTANT_INITIAL_INVESTMENT,
  getRiskOffSpread,
  getSymbolSpread,
  getTransitionSpreadCostForConfig,
} from "../constants";
import { calcCagr, calcMaxDrawdownInRange, calcMonthlyExtremes, calcSortinoRatio } from "./metrics";
import type { EtfConfig, EtfResult } from "./types";
import { renormalizeSeriesFromIndex, resolveEdgeRiskOffStates, selectEdgeSpreads } from "./window-calculations";

/**
 * Trim one simulated result to start at `seriesStartDate`, as if it were entered
 * there: the entry spread is paid on that day, the exit spread on the last, and
 * trading costs count only the signals inside the trimmed window.
 *
 * `runParallelBacktest` uses it to start each config at its own display date, and
 * the UPRO/TQQQ fund uses it to start both sleeves on the later index's start.
 */
export function trimEtfResultToStartDate(etfResult: EtfResult, seriesStartDate: string, config: EtfConfig): EtfResult {
  const rawStartIdx = etfResult.dates.findIndex((date) => date >= seriesStartDate);
  const startIdx = rawStartIdx < 0 ? 0 : rawStartIdx;

  const dates = startIdx > 0 ? etfResult.dates.slice(startIdx) : etfResult.dates;
  const slicedDailyValues = startIdx > 0 ? etfResult.dailyValues.slice(startIdx) : etfResult.dailyValues;
  const slicedSmaPrices = startIdx > 0 ? etfResult.smaPrices.slice(startIdx) : etfResult.smaPrices;
  const slicedSmaSignals = startIdx > 0
    ? etfResult.smaSignals.filter((signal) => signal.date >= dates[0])
    : etfResult.smaSignals;

  const firstDate = dates[0];
  const lastDate = dates[dates.length - 1];
  // etfResult.smaSignals were already filtered to the incoming window, so a
  // regime carried in from warm-up has no signal at or before the cutoff —
  // fall back to the window's start state instead of assuming risk-on.
  const carriedInRiskOff = etfResult.smaStartInvested === false;
  const { startInRiskOff, endInRiskOff } = resolveEdgeRiskOffStates(
    etfResult.smaSignals,
    firstDate,
    lastDate,
    carriedInRiskOff
  );
  const { entrySpread, exitSpread } = selectEdgeSpreads(
    {
      riskOnSpreadRegular: getSymbolSpread(config.name, false),
      riskOffSpreadRegular: getRiskOffSpread(config.riskOffAsset, false),
    },
    startInRiskOff,
    endInRiskOff
  );
  const perTransitionSpread = config.smaEnabled
    ? getTransitionSpreadCostForConfig(config, false)
    : 0;

  // Regime on the trimmed window's first day: the last signal before it wins;
  // with none, the incoming window's start state carries through.
  let smaStartInvested = etfResult.smaStartInvested;
  if (smaStartInvested !== undefined) {
    for (const s of etfResult.smaSignals) {
      if (s.date >= firstDate) break;
      smaStartInvested = s.type === "buy";
    }
  }

  if (dates.length < 2 || slicedDailyValues.length < 2) {
    const fallbackFinal = slicedDailyValues[slicedDailyValues.length - 1] ?? 0;
    return {
      ...etfResult,
      dates,
      dailyValues: slicedDailyValues,
      finalValue: fallbackFinal,
      cagr: 0,
      sortinoRatio: 0,
      maxDrawdownPct: 0,
      maxDrawdownDollar: 0,
      longestDrawdownDays: 0,
      bestMonth: 0,
      worstMonth: 0,
      smaPrices: slicedSmaPrices,
      smaSignals: slicedSmaSignals,
      smaStartInvested,
      totalTradingCostPct: 0,
    };
  }

  // When the display window starts after the simulation start, treat the window start
  // as a fresh "buy" that pays the entry spread (same as simulateSingleEtf).
  const dailyValues = startIdx > 0
    ? renormalizeSeriesFromIndex(etfResult.dailyValues, startIdx, entrySpread)
    : slicedDailyValues;

  const rawFinalValue = dailyValues[dailyValues.length - 1] ?? 0;
  const exitDollarCost = rawFinalValue * exitSpread;
  const finalValue = Math.max(0, rawFinalValue - exitDollarCost);

  let inWindowCost = 0;
  if (perTransitionSpread > 0 && slicedSmaSignals.length > 0) {
    const dateToIdx = new Map<string, number>();
    for (let i = 0; i < dates.length; i++) dateToIdx.set(dates[i], i);
    for (const signal of slicedSmaSignals) {
      const idx = dateToIdx.get(signal.date);
      if (idx === undefined) continue;
      inWindowCost += dailyValues[idx] * perTransitionSpread;
    }
  }

  const entryCost = CONSTANT_INITIAL_INVESTMENT * entrySpread;
  const totalCost = entryCost + inWindowCost + exitDollarCost;
  const totalTradingCostPct = finalValue > 0 ? (totalCost / finalValue) * 100 : 0;

  const drawdown = calcMaxDrawdownInRange(dailyValues, dates, 0, dailyValues.length - 1);
  const monthlyExtremes = calcMonthlyExtremes(dailyValues, dates);
  const sortinoRatio = calcSortinoRatio(dailyValues);
  const cagr = calcCagr(CONSTANT_INITIAL_INVESTMENT, finalValue, dates[0], dates[dates.length - 1]);

  return {
    ...etfResult,
    dates,
    dailyValues,
    finalValue,
    cagr,
    sortinoRatio,
    maxDrawdownPct: drawdown.pct,
    maxDrawdownDollar: drawdown.dollar,
    maxDrawdownDates: drawdown.maxDrawdownDates,
    longestDrawdownDays: drawdown.longestDays,
    longestDrawdownDates: drawdown.longestDrawdownDates,
    bestMonth: monthlyExtremes.bestMonth,
    bestMonthDates: monthlyExtremes.bestMonthDates,
    worstMonth: monthlyExtremes.worstMonth,
    worstMonthDates: monthlyExtremes.worstMonthDates,
    smaPrices: slicedSmaPrices,
    smaSignals: slicedSmaSignals,
    smaStartInvested,
    totalTradingCostPct,
  };
}
