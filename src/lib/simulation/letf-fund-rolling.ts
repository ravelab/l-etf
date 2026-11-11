// The UPRO/TQQQ fund (letf-dual-sleeve.ts) over every rolling window, for the
// Strategies page. Each window opens the fund at 50/50, so it cannot be sliced out
// of one long fund path the way a single sleeve is: until the first reset, a
// window's weights depend on where it started. Instead each sleeve is simulated
// once over the whole history, exactly as the per-index rows are, and every window
// renormalizes the two sleeve paths and composes them afresh.

import { CONSTANT_INITIAL_INVESTMENT } from "@/lib/constants";
import { throwIfAborted } from "@/lib/abort";
import { composeLetfFundPath, heldRiskOnByDay, type LetfFundPathSleeve } from "./letf-dual-sleeve";
import { calcCagr } from "./metrics";
import { precomputeAllConfigDailyValues } from "./parallel";
import { buildRollingWindows, type RollingSimulationPoint, type RollingWindow } from "./rolling";
import type { EtfConfig, PricePoint, RatePoint } from "./types";
import { finalizeTradingCosts, riskOffPercent, selectEdgeSpreads } from "./window-calculations";
import { buildWrappedTailCache } from "./wrapped-window";

type RiskOffSeries = Partial<Record<EtfConfig["riskOffAsset"], number[]>>;

export type LetfFundRollingSleeveInput = {
  prices: PricePoint[];
  /** The sleeve's SMA config; its `riskOffAsset` is the basket the reset rule compares. */
  config: EtfConfig;
  riskOffValuesByAsset?: RiskOffSeries;
  riskOffOpenValuesByAsset?: RiskOffSeries;
};

/** A sleeve's whole-history path, extended past the data by the history-wrap tail. */
type SleeveSeries = {
  windows: RollingWindow[];
  dates: string[];
  dailyValues: number[];
  nonLeveragedValues: number[];
  heldRiskOn: boolean[];
  /** Regime after each day's own close, as the engine reads entry/exit spreads. */
  riskOffAtClose: boolean[];
  riskOffDayPrefix: Uint32Array;
  tradeCountPrefix: Uint32Array;
  tradeValuePrefix: Float64Array;
  perTransitionSpreadFraction: number;
  riskOnSpreadRegular: number;
  riskOffSpreadRegular: number;
  riskOffAsset: string;
};

function buildSleeveSeries(
  sleeve: LetfFundRollingSleeveInput,
  rates: RatePoint[],
  windowLength: number,
  startDate: string,
  endDate: string,
  historyWrap: boolean | undefined
): SleeveSeries | null {
  const { prices, config } = sleeve;
  const windows = buildRollingWindows({
    prices,
    windowLength,
    startDateConstraint: startDate,
    endDateConstraint: endDate,
    historyWrap,
  });
  if (windows.length === 0) return null;
  const [precomputed] = precomputeAllConfigDailyValues(
    prices,
    rates,
    [config],
    sleeve.riskOffValuesByAsset,
    sleeve.riskOffOpenValuesByAsset
  );
  if (!precomputed) return null;

  const realEnd = Math.max(...windows.map((window) => window.endIdx));
  const dates = prices.slice(0, realEnd + 1).map((price) => price.date);
  const dailyValues = precomputed.dailyValues.slice(0, realEnd + 1);
  const nonLeveragedValues = (precomputed.nonLeveragedValues ?? []).slice(0, realEnd + 1);
  const joinDate = dates[realEnd];
  const signals = (precomputed.smaSignals ?? []).filter((signal) => signal.date <= joinDate);

  const tail = buildWrappedTailCache(
    precomputed,
    windows,
    prices,
    config,
    rates,
    sleeve.riskOffValuesByAsset,
    sleeve.riskOffOpenValuesByAsset
  );
  if (tail) {
    const scale = dailyValues[realEnd] / tail.normalizedTailValues[0];
    const nonLeveragedScale = nonLeveragedValues[realEnd] / tail.normalizedTailNonLeveragedValues[0];
    for (let j = 1; j < tail.normalizedTailValues.length; j++) {
      dates.push(tail.tailDates[tail.tailJoinOffset + j]);
      dailyValues.push(tail.normalizedTailValues[j] * scale);
      nonLeveragedValues.push(tail.normalizedTailNonLeveragedValues[j] * nonLeveragedScale);
    }
    signals.push(...tail.smaSignals.filter((signal) => signal.date > joinDate));
  }

  const n = dates.length;
  const indexByDate = new Map(dates.map((date, i) => [date, i]));
  const riskOffAtClose = new Array<boolean>(n);
  const riskOffDayPrefix = new Uint32Array(n + 1);
  const tradeCountPrefix = new Uint32Array(n + 1);
  const tradeValuePrefix = new Float64Array(n + 1);
  const tradeDays = new Set<number>();
  for (const signal of signals) {
    const idx = indexByDate.get(signal.date);
    if (idx !== undefined) tradeDays.add(idx);
  }
  let cursor = 0;
  let riskOff = false;
  for (let i = 0; i < n; i++) {
    while (cursor < signals.length && signals[cursor].date <= dates[i]) {
      riskOff = signals[cursor].type === "sell";
      cursor++;
    }
    riskOffAtClose[i] = riskOff;
    riskOffDayPrefix[i + 1] = riskOffDayPrefix[i] + (riskOff ? 1 : 0);
    const traded = tradeDays.has(i);
    tradeCountPrefix[i + 1] = tradeCountPrefix[i] + (traded ? 1 : 0);
    tradeValuePrefix[i + 1] = tradeValuePrefix[i] + (traded ? dailyValues[i] : 0);
  }

  return {
    windows,
    dates,
    dailyValues,
    nonLeveragedValues,
    heldRiskOn: heldRiskOnByDay({ dates, smaSignals: signals }),
    riskOffAtClose,
    riskOffDayPrefix,
    tradeCountPrefix,
    tradeValuePrefix,
    perTransitionSpreadFraction: precomputed.perTransitionSpreadFraction ?? 0,
    riskOnSpreadRegular: precomputed.riskOnSpreadRegular ?? 0,
    riskOffSpreadRegular: precomputed.riskOffSpreadRegular ?? 0,
    riskOffAsset: config.riskOffAsset,
  };
}

function lastIndexLte(dates: string[], date: string): number {
  let lo = 0;
  let hi = dates.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] <= date) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** The sleeve's span of a window, renormalized as the engine's own window extraction does. */
function sleeveWindow(series: SleeveSeries, window: RollingWindow) {
  const startIdx = window.startIdx;
  const endIdx = window.usesSyntheticTail ? lastIndexLte(series.dates, window.endDate) : window.endIdx;
  if (endIdx <= startIdx) return null;
  // Without a tail the sleeve stops at the data's end, short of a wrapped window.
  if (window.usesSyntheticTail && endIdx <= window.endIdx) return null;
  const firstValue = series.dailyValues[startIdx];
  if (!(firstValue > 0)) return null;

  const { entrySpread, exitSpread } = selectEdgeSpreads(
    series,
    series.riskOffAtClose[startIdx],
    series.riskOffAtClose[endIdx]
  );
  const startValue = CONSTANT_INITIAL_INVESTMENT * (1 - entrySpread);
  const factor = startValue / firstValue;
  const rawFinalValue = series.dailyValues[endIdx] * factor;
  if (!Number.isFinite(rawFinalValue)) return null;
  const internalDollarCost = series.perTransitionSpreadFraction > 0
    ? factor * series.perTransitionSpreadFraction * (series.tradeValuePrefix[endIdx + 1] - series.tradeValuePrefix[startIdx])
    : 0;
  const costs = finalizeTradingCosts({ rawFinalValue, entrySpread, exitSpread, internalDollarCost });
  return {
    startIdx,
    endIdx,
    startValue,
    exitFraction: rawFinalValue > 0 ? Math.min(1, Math.max(0, costs.finalValue / rawFinalValue)) : 1,
    totalTradingCostPct: costs.totalTradingCostPct,
    tradeCount: series.tradeCountPrefix[endIdx + 1] - series.tradeCountPrefix[startIdx],
    riskOffDays: series.riskOffDayPrefix[endIdx] - series.riskOffDayPrefix[startIdx],
  };
}

/**
 * The fund's result on every rolling window both sleeves produce, joined on the
 * window's dates. Windows start no earlier than both indexes' data, so each
 * sleeve's history-wrap tail replays the same stretch of history.
 */
export async function runLetfFundRollingWindows(params: {
  spx: LetfFundRollingSleeveInput;
  ndx: LetfFundRollingSleeveInput;
  rates: RatePoint[];
  windowLength: number;
  startDate: string;
  endDate: string;
  historyWrap?: boolean;
  signal?: AbortSignal;
}): Promise<RollingSimulationPoint[]> {
  const firstDates = [params.startDate, params.spx.prices[0]?.date ?? "", params.ndx.prices[0]?.date ?? ""];
  const startDate = firstDates.reduce((latest, date) => (date > latest ? date : latest));
  const build = (sleeve: LetfFundRollingSleeveInput) =>
    buildSleeveSeries(sleeve, params.rates, params.windowLength, startDate, params.endDate, params.historyWrap);
  const spx = build(params.spx);
  throwIfAborted(params.signal);
  const ndx = spx ? build(params.ndx) : null;
  throwIfAborted(params.signal);
  if (!spx || !ndx) return [];

  const fundDates = [...new Set([...spx.dates, ...ndx.dates])].sort();
  const dayIndexFor = (series: SleeveSeries) => {
    const indexByDate = new Map(series.dates.map((date, i) => [date, i]));
    return Int32Array.from(fundDates, (date) => indexByDate.get(date) ?? -1);
  };
  const spxDayIndex = dayIndexFor(spx);
  const ndxDayIndex = dayIndexFor(ndx);
  const fundIndexByDate = new Map(fundDates.map((date, i) => [date, i]));
  const ndxWindowByKey = new Map(ndx.windows.map((window) => [`${window.startDate}|${window.endDate}`, window]));

  const runs: RollingSimulationPoint[] = [];
  for (let w = 0; w < spx.windows.length; w++) {
    if (w % 64 === 63) {
      await Promise.resolve();
      throwIfAborted(params.signal);
    }
    const spxWindow = spx.windows[w];
    const ndxWindow = ndxWindowByKey.get(`${spxWindow.startDate}|${spxWindow.endDate}`);
    if (!ndxWindow) continue;
    const a = sleeveWindow(spx, spxWindow);
    const b = sleeveWindow(ndx, ndxWindow);
    if (!a || !b) continue;

    const firstDay = fundIndexByDate.get(spxWindow.startDate);
    const lastDay = fundIndexByDate.get(
      spx.dates[a.endIdx] > ndx.dates[b.endIdx] ? spx.dates[a.endIdx] : ndx.dates[b.endIdx]
    );
    if (firstDay === undefined || lastDay === undefined || ndxDayIndex[firstDay] !== b.startIdx) continue;

    const pathSleeve = (series: SleeveSeries, dayIndex: Int32Array, span: NonNullable<ReturnType<typeof sleeveWindow>>): LetfFundPathSleeve => ({
      dayIndex,
      dailyValues: series.dailyValues,
      heldRiskOn: series.heldRiskOn,
      startValue: span.startValue / 2,
      riskOffAsset: series.riskOffAsset,
      exitFraction: span.exitFraction,
      totalTradingCostPct: span.totalTradingCostPct,
    });
    const fund = composeLetfFundPath(
      [pathSleeve(spx, spxDayIndex, a), pathSleeve(ndx, ndxDayIndex, b)],
      firstDay,
      lastDay - firstDay + 1
    );

    let peak = 0;
    let maxDrawdown = 0;
    for (const value of fund.dailyValues) {
      if (value > peak) peak = value;
      const drawdown = peak > 0 ? (peak - value) / peak : 0;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }

    // Unleveraged benchmark: half in each index, bought and held.
    let spxIdx = a.startIdx;
    let ndxIdx = b.startIdx;
    let nlPeak = 0;
    let nlMaxDrawdown = 0;
    let nlValue = CONSTANT_INITIAL_INVESTMENT;
    for (let k = firstDay; k <= lastDay; k++) {
      if (spxDayIndex[k] >= 0) spxIdx = spxDayIndex[k];
      if (ndxDayIndex[k] >= 0) ndxIdx = ndxDayIndex[k];
      nlValue = (CONSTANT_INITIAL_INVESTMENT / 2) * (
        spx.nonLeveragedValues[spxIdx] / spx.nonLeveragedValues[a.startIdx] +
        ndx.nonLeveragedValues[ndxIdx] / ndx.nonLeveragedValues[b.startIdx]
      );
      if (nlValue > nlPeak) nlPeak = nlValue;
      const drawdown = nlPeak > 0 ? (nlPeak - nlValue) / nlPeak : 0;
      if (drawdown > nlMaxDrawdown) nlMaxDrawdown = drawdown;
    }

    const finalValue = fund.finalValue;
    runs.push({
      startDate: spxWindow.startDate,
      endDate: spxWindow.endDate,
      finalValue,
      nonLeveragedFinalValue: nlValue,
      maxDrawdownPct: maxDrawdown * 100,
      nonLeveragedMaxDrawdownPct: nlMaxDrawdown * 100,
      cagr: calcCagr(CONSTANT_INITIAL_INVESTMENT, finalValue, spxWindow.startDate, spxWindow.endDate),
      totalReturnPct: ((finalValue - CONSTANT_INITIAL_INVESTMENT) / CONSTANT_INITIAL_INVESTMENT) * 100,
      tradeCount: a.tradeCount + b.tradeCount,
      totalTradingCostPct: fund.totalTradingCostPct,
      riskOffPct: riskOffPercent(a.riskOffDays + b.riskOffDays, (a.endIdx - a.startIdx) + (b.endIdx - b.startIdx)),
      usedHistoryWrap: spxWindow.usesSyntheticTail,
    });
  }
  return runs;
}
