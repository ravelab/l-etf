import {
  CONSTANT_INITIAL_INVESTMENT,
  getRiskOffSpread,
  getSymbolSpread,
  getTransitionSpreadCostForConfig,
} from "../constants";
import { calcCagr, calcPathMetrics, EMPTY_PATH_METRICS } from "./metrics";
import type { EtfConfig, EtfResult } from "./types";
import {
  finalizeTradingCosts,
  investedAtWindowStart,
  renormalizeSeriesFromIndex,
  resolveEdgeRiskOffStates,
  selectEdgeSpreads,
  transitionCostInWindow,
} from "./window-calculations";

/**
 * Trim one simulated result to start at `seriesStartDate`, as if it were entered
 * there: the entry spread is paid on that day, the exit spread on the last, and
 * trading costs count only the signals inside the trimmed window.
 *
 * This is the ONE path that cuts a simulated result down to a display window:
 * `simulateWithWarmUp` uses it to drop SMA warm-up, `runParallelBacktest` to
 * start each config at its own display date, and the UPRO/TQQQ fund to start
 * both sleeves on the later index's start.
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
  const smaStartInvested = investedAtWindowStart(etfResult.smaStartInvested, etfResult.smaSignals, firstDate);

  if (dates.length < 2 || slicedDailyValues.length < 2) {
    return {
      ...etfResult,
      dates,
      dailyValues: slicedDailyValues,
      finalValue: slicedDailyValues[slicedDailyValues.length - 1] ?? 0,
      cagr: 0,
      ...EMPTY_PATH_METRICS,
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

  const perTransitionSpread = config.smaEnabled
    ? getTransitionSpreadCostForConfig(config, false)
    : 0;
  const { finalValue, totalTradingCostPct } = finalizeTradingCosts({
    rawFinalValue: dailyValues[dailyValues.length - 1] ?? 0,
    entrySpread,
    exitSpread,
    internalDollarCost: transitionCostInWindow(dates, dailyValues, slicedSmaSignals, perTransitionSpread),
  });

  return {
    ...etfResult,
    dates,
    dailyValues,
    finalValue,
    cagr: calcCagr(CONSTANT_INITIAL_INVESTMENT, finalValue, dates[0], dates[dates.length - 1]),
    ...calcPathMetrics(dailyValues, dates),
    smaPrices: slicedSmaPrices,
    smaSignals: slicedSmaSignals,
    smaStartInvested,
    totalTradingCostPct,
  };
}
