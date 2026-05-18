import type { EtfConfig, PricePoint, RatePoint } from "./types";
import { buildRollingWindows } from "./rolling";
import { precomputeAllConfigDailyValues, buildSimulationBuckets } from "./parallel";
import { buildSgovFinalValuesByWindow } from "../sgov-benchmark";
import { CONSTANT_HISTORY_WRAP_ENABLED, CONSTANT_INITIAL_INVESTMENT, LABEL_INDEX_NASDAQ100_TR, LABEL_INDEX_SP500_TR } from "../constants";
import { annualizedInflationForRange } from "../inflation";
import { calcCagr } from "./metrics";

export type WinRateSummaryRow = {
  label: string;
  p10: number;
  avg: number;
  p50: number;
  p90: number;
  beatsSma: number | null;
  beatsNonSma: number | null;
  beatsIndex: number | null;
  beatsSgov: number | null;
  avgTradingCostPct?: number;
};

export type WinRatesByWindow = {
  label: string;
  earliestStartDate?: string;
  years: number[];
  beatsNonSma: number[];
  beatsIndex: number[];
  beatsSgov: number[];
  summaryRows: WinRateSummaryRow[];
  historyWrapApplied: boolean;
};

function percentile(sorted: number[], p: number): number {
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo] ?? 0;
  const w = idx - lo;
  return (sorted[lo] ?? 0) * (1 - w) + (sorted[hi] ?? 0) * w;
}

function summarizeValues(values: number[]) {
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) {
    return { p10: 0, avg: 0, p50: 0, p90: 0 };
  }
  const avg = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  return {
    p10: percentile(sorted, 0.1),
    avg,
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
  };
}

/**
 * Compute SMA win rates across multiple holding-period lengths (0.25, 0.5, 1, then every year through 30).
 *
 * Precomputes daily portfolio values once, then sweeps rolling windows for
 * each year length, counting how often the SMA strategy beats non-SMA,
 * the underlying index, and SGOV.
 *
 * Async to yield to the browser between years so the UI stays responsive.
 */
export async function computeWinRatesByWindowLength(opts: {
  label: string;
  prices: PricePoint[];
  rates: RatePoint[];
  smaConfig: EtfConfig;
  noSmaConfig: EtfConfig;
  startDate: string;
  endDate: string;
  historyWrap?: boolean;
  riskOffValuesByAsset: Partial<Record<EtfConfig["riskOffAsset"], number[]>>;
  sgovPoints: PricePoint[];
  monthlyCpi?: Array<{ date: string; value: number }>;
  onProgress?: (year: number, totalYears: number) => void;
}): Promise<WinRatesByWindow> {
  const {
    label, prices, rates, smaConfig, noSmaConfig,
    startDate, endDate,
    riskOffValuesByAsset, sgovPoints, monthlyCpi, onProgress,
  } = opts;
  const historyWrap = opts.historyWrap ?? CONSTANT_HISTORY_WRAP_ENABLED;

  const configs = [smaConfig, noSmaConfig];

  // Precompute daily portfolio values once for both configs
  const precomputed = precomputeAllConfigDailyValues(
    prices, rates, configs, riskOffValuesByAsset,
  );

  const years: number[] = [];
  const beatsNonSma: number[] = [];
  const beatsIndex: number[] = [];
  const beatsSgov: number[] = [];
  const smaRealCagrs: number[] = [];
  const noSmaRealCagrs: number[] = [];
  const indexRealCagrs: number[] = [];
  const smaTradeCosts: number[] = [];
  const noSmaTradeCosts: number[] = [];
  const indexTradeCosts: number[] = [];
  let totalSmaVsNoSma = 0;
  let winsSmaVsNoSma = 0;
  let totalSmaVsIndex = 0;
  let winsSmaVsIndex = 0;
  let totalSmaVsSgov = 0;
  let winsSmaVsSgov = 0;
  let totalNoSmaVsIndex = 0;
  let winsNoSmaVsIndex = 0;
  let totalNoSmaVsSgov = 0;
  let winsNoSmaVsSgov = 0;
  let winsNoSmaVsSma = 0;
  let totalIndexVsNoSma = 0;
  let winsIndexVsNoSma = 0;
  let totalIndexVsSgov = 0;
  let winsIndexVsSgov = 0;
  let winsIndexVsSma = 0;
  let earliestStartDate: string | undefined;
  let historyWrapApplied = false;

  const stepYears = [
    0.25,
    0.5,
    ...Array.from({ length: 30 }, (_, index) => index + 1),
  ];

  for (const year of stepYears) {
    onProgress?.(year, stepYears[stepYears.length - 1] ?? 30);

    // Yield to browser so UI stays responsive
    await new Promise((resolve) => setTimeout(resolve, 0));

    const windows = buildRollingWindows({
      prices,
      windowLength: year,
      startDateConstraint: startDate,
      endDateConstraint: endDate,
      historyWrap,
    });

    if (windows.length === 0) {
      years.push(year);
      beatsNonSma.push(0);
      beatsIndex.push(0);
      beatsSgov.push(0);
      continue;
    }

    const buckets = buildSimulationBuckets(precomputed, windows, prices, {
      rates,
      configs,
      riskOffValuesByAsset,
    });

    // Find SMA and non-SMA buckets by config ID
    const smaBucket = buckets.find((b) => b.configId === smaConfig.id);
    const noSmaBucket = buckets.find((b) => b.configId === noSmaConfig.id);

    if (!smaBucket || !noSmaBucket) {
      years.push(year);
      beatsNonSma.push(0);
      beatsIndex.push(0);
      beatsSgov.push(0);
      continue;
    }

    // Build SGOV final values for these windows
    const sgovByWindow = buildSgovFinalValuesByWindow(
      windows.map((w) => ({ startDate: w.startDate, endDate: w.endDate })),
      sgovPoints,
      CONSTANT_INITIAL_INVESTMENT,
    );

    let winsVsNoSma = 0;
    let winsVsIndex = 0;
    let winsVsSgov = 0;
    let totalVsNoSma = 0;
    let totalVsIndex = 0;
    let totalVsSgov = 0;

    for (let i = 0; i < smaBucket.simulations.length; i++) {
      const smaRun = smaBucket.simulations[i];
      const noSmaRun = noSmaBucket.simulations[i];
      if (smaRun && (!earliestStartDate || smaRun.startDate < earliestStartDate)) {
        earliestStartDate = smaRun.startDate;
      }
      if (smaRun?.usedHistoryWrap || noSmaRun?.usedHistoryWrap) {
        historyWrapApplied = true;
      }
      const inflationPct = monthlyCpi && monthlyCpi.length >= 2
        ? annualizedInflationForRange(monthlyCpi, smaRun.startDate, smaRun.endDate) * 100
        : 0;
      const indexCagr = calcCagr(
        CONSTANT_INITIAL_INVESTMENT,
        smaRun.nonLeveragedFinalValue,
        smaRun.startDate,
        smaRun.endDate
      );

      smaRealCagrs.push(smaRun.cagr - inflationPct);
      smaTradeCosts.push(smaRun.totalTradingCostPct);
      if (noSmaRun) {
        noSmaRealCagrs.push(noSmaRun.cagr - inflationPct);
        noSmaTradeCosts.push(noSmaRun.totalTradingCostPct);
      }
      indexRealCagrs.push(indexCagr - inflationPct);
      
      const indexSpread = (smaConfig.smaIndex === "nasdaq100" ? 0.0001 : 0.0001); // 1bp
      const indexEntryDollar = CONSTANT_INITIAL_INVESTMENT * indexSpread;
      const indexExitDollar = smaRun.nonLeveragedFinalValue * indexSpread;
      const indexTotalDollar = indexEntryDollar + indexExitDollar;
      const indexFinalValue = Math.max(0, smaRun.nonLeveragedFinalValue - indexExitDollar);
      indexTradeCosts.push(indexFinalValue > 0 ? (indexTotalDollar / indexFinalValue) * 100 : 0);

      // SMA vs Non-SMA
      if (noSmaRun) {
        totalVsNoSma++;
        totalSmaVsNoSma++;
        if (smaRun.finalValue > noSmaRun.finalValue) {
          winsVsNoSma++;
          winsSmaVsNoSma++;
        } else if (smaRun.finalValue === noSmaRun.finalValue) {
          winsVsNoSma += 0.5;
          winsSmaVsNoSma += 0.5;
          winsNoSmaVsSma += 0.5;
        } else {
          winsNoSmaVsSma++;
        }
      }

      // SMA vs Index (unleveraged)
      totalVsIndex++;
      totalSmaVsIndex++;
      if (smaRun.finalValue > smaRun.nonLeveragedFinalValue) {
        winsVsIndex++;
        winsSmaVsIndex++;
      } else if (smaRun.finalValue === smaRun.nonLeveragedFinalValue) {
        winsVsIndex += 0.5;
        winsSmaVsIndex += 0.5;
        winsIndexVsSma += 0.5;
      } else {
        winsIndexVsSma++;
      }

      // SMA vs SGOV
      const sgovKey = `${smaRun.startDate}|${smaRun.endDate}`;
      const sgovValue = sgovByWindow.get(sgovKey);
      if (sgovValue != null) {
        totalVsSgov++;
        totalSmaVsSgov++;
        totalIndexVsSgov++;
        if (smaRun.finalValue > sgovValue) {
          winsVsSgov++;
          winsSmaVsSgov++;
        } else if (smaRun.finalValue === sgovValue) {
          winsVsSgov += 0.5;
          winsSmaVsSgov += 0.5;
        }
        if (noSmaRun) {
          totalNoSmaVsSgov++;
          if (noSmaRun.finalValue > sgovValue) winsNoSmaVsSgov++;
          else if (noSmaRun.finalValue === sgovValue) winsNoSmaVsSgov += 0.5;
        }
        if (smaRun.nonLeveragedFinalValue > sgovValue) winsIndexVsSgov++;
        else if (smaRun.nonLeveragedFinalValue === sgovValue) winsIndexVsSgov += 0.5;
      }

      if (noSmaRun) {
        totalNoSmaVsIndex++;
        totalIndexVsNoSma++;
        if (noSmaRun.finalValue > smaRun.nonLeveragedFinalValue) winsNoSmaVsIndex++;
        else if (noSmaRun.finalValue === smaRun.nonLeveragedFinalValue) winsNoSmaVsIndex += 0.5;

        if (smaRun.nonLeveragedFinalValue > noSmaRun.finalValue) winsIndexVsNoSma++;
        else if (smaRun.nonLeveragedFinalValue === noSmaRun.finalValue) winsIndexVsNoSma += 0.5;
      }
    }

    years.push(year);
    beatsNonSma.push(totalVsNoSma > 0 ? (winsVsNoSma / totalVsNoSma) * 100 : 0);
    beatsIndex.push(totalVsIndex > 0 ? (winsVsIndex / totalVsIndex) * 100 : 0);
    beatsSgov.push(totalVsSgov > 0 ? (winsVsSgov / totalVsSgov) * 100 : 0);
  }

  const indexLabel = smaConfig.smaIndex === "sp500" ? LABEL_INDEX_SP500_TR : LABEL_INDEX_NASDAQ100_TR;

  const avgTradeCost = (costs: number[]) => {
    const finite = costs.filter(Number.isFinite);
    return finite.length > 0 ? finite.reduce((s, c) => s + c, 0) / finite.length : 0;
  };

  return {
    label,
    earliestStartDate,
    years,
    beatsNonSma,
    beatsIndex,
    beatsSgov,
    historyWrapApplied,
    summaryRows: [
      {
        label: "SMA",
        ...summarizeValues(smaRealCagrs),
        beatsSma: null,
        beatsNonSma: totalSmaVsNoSma > 0 ? (winsSmaVsNoSma / totalSmaVsNoSma) * 100 : null,
        beatsIndex: totalSmaVsIndex > 0 ? (winsSmaVsIndex / totalSmaVsIndex) * 100 : null,
        beatsSgov: totalSmaVsSgov > 0 ? (winsSmaVsSgov / totalSmaVsSgov) * 100 : null,
        avgTradingCostPct: avgTradeCost(smaTradeCosts),
      },
      {
        label: "No SMA",
        ...summarizeValues(noSmaRealCagrs),
        beatsSma: totalSmaVsNoSma > 0 ? (winsNoSmaVsSma / totalSmaVsNoSma) * 100 : null,
        beatsNonSma: null,
        beatsIndex: totalNoSmaVsIndex > 0 ? (winsNoSmaVsIndex / totalNoSmaVsIndex) * 100 : null,
        beatsSgov: totalNoSmaVsSgov > 0 ? (winsNoSmaVsSgov / totalNoSmaVsSgov) * 100 : null,
        avgTradingCostPct: avgTradeCost(noSmaTradeCosts),
      },
      {
        label: indexLabel,
        ...summarizeValues(indexRealCagrs),
        beatsSma: totalSmaVsIndex > 0 ? (winsIndexVsSma / totalSmaVsIndex) * 100 : null,
        beatsNonSma: totalIndexVsNoSma > 0 ? (winsIndexVsNoSma / totalIndexVsNoSma) * 100 : null,
        beatsIndex: null,
        beatsSgov: totalIndexVsSgov > 0 ? (winsIndexVsSgov / totalIndexVsSgov) * 100 : null,
        avgTradingCostPct: avgTradeCost(indexTradeCosts),
      },
    ],
  };
}
