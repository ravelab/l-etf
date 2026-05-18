import type {
  PricePoint,
  EtfConfig,
  EtfResult,
  SmaComparisonRow,
} from "./types";
import {
  calcCagr,
  calcMaxDrawdownInRange,
  calcSharpeRatio,
  calcMonthlyExtremes,
} from "./metrics";
import type { DrawdownMetrics } from "./metrics";
import {
  CONSTANT_INITIAL_INVESTMENT,
} from "../constants";
import { summarizeSmaRow, type RollingWindow, type RollingSimulationPoint } from "./rolling";
import {
  computeOptionalNonLeveragedMetrics,
  computeRenormalizedPathMetrics,
  finalizeTradingCosts,
  getRangeTradeCount,
  getRangeTradeValueSum,
  selectEdgeSpreads,
} from "./window-calculations";

interface PrecomputedConfigDailyValues {
  configId: string;
  indexKey: EtfConfig["smaIndex"];
  dailyValues: number[];
  smaSignals?: Array<{ date: string; type: 'buy' | 'sell'; price: number }>;
  smaPrices?: number[];
  timestamps: number[];
  riskOffStateByIndex?: Int8Array;
  nonLeveragedValues?: number[];
  perTransitionSpreadFraction?: number;
  tradeDayIndices?: number[];
  tradeCountPrefix?: Uint32Array;
  tradeValuePrefix?: Float64Array;
  riskOnSpread?: number;
  riskOffSpread?: number;
  riskOnSpreadRegular?: number;
  riskOffSpreadRegular?: number;
}

interface WorkerData {
  mode: string;
  mode_type: 'sweep' | 'variants' | 'variant-summaries' | 'backtest' | 'simulation-buckets';
  precomputedDailyValues: PrecomputedConfigDailyValues[];
  windows: RollingWindow[];
  prices: PricePoint[];
  monthlyCpi?: Array<{ date: string; value: number }>;
  configs: EtfConfig[];
  labels?: string[];
  pricesByIndex?: Record<string, PricePoint[]>;
}

type Simulation = RollingSimulationPoint;

function calcCagrMs(
  startValue: number,
  endValue: number,
  startTime: number,
  endTime: number,
  startDate: string,
  endDate: string
): number {
  return calcCagr(startValue, endValue, startTime, endTime, startDate, endDate);
}

function calcMaxDrawdownInRangeInternal(
  values: number[],
  dates: string[],
  startIdx: number,
  endIdx: number
): DrawdownMetrics {
  return calcMaxDrawdownInRange(values, dates, startIdx, endIdx);
}

function summarizeSmaRowInternal(
  paramValue: number,
  simulations: Simulation[],
  monthlyCpi?: Array<{ date: string; value: number }>
): SmaComparisonRow {
  return summarizeSmaRow(paramValue, simulations, monthlyCpi);
}

type DrawdownNode = {
  min: number;
  max: number;
  maxDrawdownPct: number;
};

function mergeDrawdownNodes(left: DrawdownNode, right: DrawdownNode): DrawdownNode {
  const crossDrawdownPct = left.max > 0 ? (left.max - right.min) / left.max : 0;
  return {
    min: Math.min(left.min, right.min),
    max: Math.max(left.max, right.max),
    maxDrawdownPct: Math.max(left.maxDrawdownPct, right.maxDrawdownPct, crossDrawdownPct),
  };
}

function buildDrawdownRangeQuery(values: number[]): (startIdx: number, endIdx: number) => { pct: number; dollar: number; longestDays: number } {
  let size = 1;
  while (size < values.length) size *= 2;
  const tree: DrawdownNode[] = Array.from({ length: size * 2 }, () => ({
    min: Infinity,
    max: -Infinity,
    maxDrawdownPct: 0,
  }));

  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    tree[size + i] = { min: value, max: value, maxDrawdownPct: 0 };
  }
  for (let i = size - 1; i > 0; i--) {
    tree[i] = mergeDrawdownNodes(tree[i * 2], tree[i * 2 + 1]);
  }

  return (startIdx: number, endIdx: number) => {
    if (endIdx - startIdx < 1) return { pct: 0, dollar: 0, longestDays: 0 };
    let left = startIdx + size;
    let right = endIdx + size;
    let leftNode: DrawdownNode | null = null;
    let rightNode: DrawdownNode | null = null;

    while (left <= right) {
      if (left % 2 === 1) {
        leftNode = leftNode ? mergeDrawdownNodes(leftNode, tree[left]) : tree[left];
        left += 1;
      }
      if (right % 2 === 0) {
        rightNode = rightNode ? mergeDrawdownNodes(tree[right], rightNode) : tree[right];
        right -= 1;
      }
      left = Math.floor(left / 2);
      right = Math.floor(right / 2);
    }

    const node = leftNode && rightNode
      ? mergeDrawdownNodes(leftNode, rightNode)
      : leftNode ?? rightNode;
    if (!node) return { pct: 0, dollar: 0, longestDays: 0 };
    return { pct: node.maxDrawdownPct * 100, dollar: 0, longestDays: 0 };
  };
}

function isRiskOffAt(precomputed: PrecomputedConfigDailyValues, index: number): boolean {
  return precomputed.riskOffStateByIndex?.[index] === 1;
}

function buildWindowSimulation(
  precomputed: PrecomputedConfigDailyValues,
  window: RollingWindow,
  drawdownInRange: (startIdx: number, endIdx: number) => { pct: number; dollar: number; longestDays: number }
): Simulation | null {
  const startIdx = window.startIdx;
  const endIdx = window.endIdx;
  const metrics = computeRenormalizedPathMetrics(precomputed.dailyValues, startIdx, endIdx);
  if (!metrics || !isFinite(metrics.finalValue)) return null;

  const { entrySpread, exitSpread } = selectEdgeSpreads(
    precomputed,
    isRiskOffAt(precomputed, startIdx),
    isRiskOffAt(precomputed, endIdx)
  );
  const spreadFrac = precomputed.perTransitionSpreadFraction ?? 0;
  const internalDollarCost = spreadFrac > 0
    ? metrics.factor * spreadFrac * getRangeTradeValueSum(precomputed, startIdx, endIdx)
    : 0;
  const tradingCosts = finalizeTradingCosts({
    rawFinalValue: metrics.finalValue,
    entrySpread,
    exitSpread,
    internalDollarCost,
  });
  const dd = drawdownInRange(startIdx, endIdx);
  const cagr = calcCagrMs(
    CONSTANT_INITIAL_INVESTMENT,
    tradingCosts.finalValue,
    precomputed.timestamps[startIdx],
    precomputed.timestamps[endIdx],
    window.startDate,
    window.endDate
  );
  const nonLeveragedMetrics = computeOptionalNonLeveragedMetrics(precomputed.nonLeveragedValues, startIdx, endIdx);

  return {
    startDate: window.startDate,
    endDate: window.endDate,
    finalValue: tradingCosts.finalValue,
    nonLeveragedFinalValue: nonLeveragedMetrics.finalValue,
    maxDrawdownPct: dd.pct,
    nonLeveragedMaxDrawdownPct: nonLeveragedMetrics.maxDrawdownPct * 100,
    cagr,
    totalReturnPct: ((tradingCosts.finalValue - CONSTANT_INITIAL_INVESTMENT) / CONSTANT_INITIAL_INVESTMENT) * 100,
    tradeCount: getRangeTradeCount(precomputed, startIdx, endIdx),
    totalTradingCostPct: tradingCosts.totalTradingCostPct,
    usedHistoryWrap: false,
  };
}

function handleExtractWindows(data: WorkerData): void {
  const {
    precomputedDailyValues,
    windows,
    prices,
    monthlyCpi,
    mode_type,
    configs,
    labels
  } = data;

  const getIndexDates = (indexKey: string) =>
    (data.pricesByIndex?.[indexKey] ?? prices).map((p: { date: string }) => p.date);
  
  if (mode_type === 'sweep' || mode_type === 'simulation-buckets' || (!mode_type && data.mode === 'extract-windows')) {
    const simulationBuckets = [];
    for (const precomputed of precomputedDailyValues) {
      const simulations: Simulation[] = [];
      const dailyValues = precomputed.dailyValues;
      const drawdownInRange = buildDrawdownRangeQuery(dailyValues);

      for (const window of windows) {
        const simulation = buildWindowSimulation(precomputed, window, drawdownInRange);
        if (simulation) simulations.push(simulation);
      }

      if (simulations.length > 0) {
        simulationBuckets.push({
          configId: precomputed.configId,
          simulations,
        });
      }
    }
    if (mode_type === 'simulation-buckets') {
      self.postMessage({ type: 'result', result: simulationBuckets });
      return;
    }

    const rows = [];
    for (const bucket of simulationBuckets) {
      if (bucket.simulations.length > 0) {
        const paramValue = parseFloat(bucket.configId.split('-')[1] || '0');
        rows.push(summarizeSmaRowInternal(paramValue, bucket.simulations, monthlyCpi));
      }
    }
    self.postMessage({ type: 'result', result: rows });
  } else if (mode_type === 'backtest') {
    const etfResults: EtfResult[] = configs.map(config => {
      const precomputed = precomputedDailyValues.find(p => p.configId === config.id)!;
      const startIdx = windows[0].startIdx;
      const endIdx = windows[0].endIdx;
      
      const configDates = getIndexDates(config.smaIndex);
      const configTimestamps = precomputed.timestamps;

      const factor = CONSTANT_INITIAL_INVESTMENT / precomputed.dailyValues[startIdx];
      const renormalizedDaily = precomputed.dailyValues.slice(startIdx, endIdx + 1).map(v => v * factor);
      
      const rawFinalValue = renormalizedDaily[renormalizedDaily.length - 1];
      const isSma = precomputed.smaSignals !== undefined && precomputed.smaSignals.length > 0;
      const endInRiskOff = isSma && isRiskOffAt(precomputed, endIdx);
      const { exitSpread } = selectEdgeSpreads(precomputed, false, endInRiskOff);
      const exitDollarCost = rawFinalValue * exitSpread;
      const finalValue = Math.max(0, rawFinalValue - exitDollarCost);

      const dd = calcMaxDrawdownInRangeInternal(precomputed.dailyValues, configDates, startIdx, endIdx);
      const cagr = calcCagrMs(CONSTANT_INITIAL_INVESTMENT, finalValue, configTimestamps[startIdx], configTimestamps[endIdx], windows[0].startDate, windows[0].endDate);
      const sharpeRatio = calcSharpeRatio(renormalizedDaily);
      const monthlyExtremes = calcMonthlyExtremes(renormalizedDaily, configDates.slice(startIdx, endIdx + 1));

      return {
        id: config.id,
        name: config.name,
        sourceIndex: config.smaIndex,
        dates: configDates.slice(startIdx, endIdx + 1),
        dailyValues: renormalizedDaily,
        finalValue,
        cagr,
        sharpeRatio,
        maxDrawdownPct: dd.pct,
        maxDrawdownDollar: dd.dollar,
        maxDrawdownDates: dd.maxDrawdownDates,
        longestDrawdownDays: dd.longestDays,
        longestDrawdownDates: dd.longestDrawdownDates,
        bestMonth: monthlyExtremes.bestMonth,
        bestMonthDates: monthlyExtremes.bestMonthDates,
        worstMonth: monthlyExtremes.worstMonth,
        worstMonthDates: monthlyExtremes.worstMonthDates,
        smaSignals: precomputed.smaSignals?.filter(s => s.date >= configDates[startIdx] && s.date <= configDates[endIdx]) || [],
        smaPrices: precomputed.smaPrices?.slice(startIdx, endIdx + 1) || [],
        totalTradingCostPct: (() => {
          if (finalValue <= 0) return 0;
          const sf = precomputed.perTransitionSpreadFraction ?? 0;
          const { entrySpread } = selectEdgeSpreads(precomputed, isSma && isRiskOffAt(precomputed, startIdx), endInRiskOff);
          
          const internalCost = sf > 0 ? factor * sf * getRangeTradeValueSum(precomputed, startIdx, endIdx) : 0;
          return finalizeTradingCosts({
            rawFinalValue,
            entrySpread,
            exitSpread,
            internalDollarCost: internalCost,
          }).totalTradingCostPct;
        })(),
      };
    });
    self.postMessage({ type: 'result', result: etfResults });
  } else if (mode_type === 'variants' || mode_type === 'variant-summaries') {
    const variantResults = [];
    for (let i = 0; i < configs.length; i++) {
      const config = configs[i];
      const label = labels ? labels[i] : config.id;
      const precomputed = precomputedDailyValues.find((p) => p.configId === config.id);
      if (!precomputed) continue;

      const simulations: Simulation[] = [];
      const dailyValues = precomputed.dailyValues;
      const drawdownInRange = buildDrawdownRangeQuery(dailyValues);

      for (const window of windows) {
        const simulation = buildWindowSimulation(precomputed, window, drawdownInRange);
        if (simulation) simulations.push(simulation);
      }
      if (mode_type === 'variant-summaries') {
        variantResults.push({ label, summary: summarizeSmaRowInternal(0, simulations, monthlyCpi) });
      } else {
        variantResults.push({ label, simulations });
      }
    }
    self.postMessage({ type: 'result', result: variantResults });
  }
}

self.onmessage = (e: MessageEvent<WorkerData>) => {
  try {
    const data = e.data;
    if (data.mode === "extract-windows") {
      handleExtractWindows(data);
    } else {
      console.warn(`[worker] Unknown mode: ${data.mode}`);
    }
  } catch (err) {
    console.error('[worker] ERROR:', err);
    self.postMessage({
      type: "error",
      message: err instanceof Error ? err.message : "Worker error",
    });
  }
};
