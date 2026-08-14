"use client";

import { Suspense, useCallback, useEffect, useMemo, useState, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ZoomableChart } from "@/components/ui/ZoomableChart";
import type { ChartOptions, TooltipItem } from "chart.js";
import { Card } from "@/components/ui/Card";
import { RealYearlyGrowthTable } from "@/components/tools/RealYearlyGrowthTable";
import { ForwardReturnVsSmaGapChart } from "@/components/tools/compare/ForwardReturnVsSmaGapChart";
import { createLegendHoverIsolation, getChartThemeColors } from "@/lib/chart-options";
import { SweepComparisonTable } from "@/components/tools/compare/SweepComparisonTable";
import { SharedToolInputs } from "@/components/tools/SharedToolInputs";
import { RunSpinnerOverlay } from "@/components/ui/RunSpinnerOverlay";
import {
  CONSTANT_INITIAL_INVESTMENT,
  INDEX_DATE_RANGES,
  LABEL_INDEX_NASDAQ100_TR,
  LABEL_INDEX_SP500_TR,
} from "@/lib/constants";
import { fetchJsonCached, fetchMarketData, loadRiskOffPriceSeries, MARKET_DATA_EARLIEST_START } from "@/lib/fetch-market-data";
import { useMonotonicRunProgress } from "@/lib/hooks/use-monotonic-run-progress";
import { buildPresetBacktestUrl } from "@/lib/url-builders";
import { ETF_PRESETS } from "@/lib/simulation/presets";
import { runParallelVariants } from "@/lib/simulation/parallel";
import { simulateWithWarmUp } from "@/lib/simulation/engine";
import { summarizeSmaRow } from "@/lib/simulation/rolling";
import { scoreRow } from "@/lib/simulation/score";
import { effectiveStartDateFromAlignedSeries } from "@/lib/simulation/effective-start";
import type {
  EtfConfig,
  PricePoint,
  SmaComparisonRow,
} from "@/lib/simulation/types";
import type { RollingSimulationPoint } from "@/lib/simulation/rolling";
import { useToolSnapshot } from "@/lib/hooks/use-tool-snapshot";
import { useRefreshEndDateOnInitialVisit } from "@/lib/hooks/use-refresh-end-date";
import { useTradeAfterHours } from "@/lib/hooks/use-trade-after-hours";
import { SimulationRunSummary } from "@/components/tools/SimulationRunSummary";
import { RealEndValuePercentileCard } from "@/components/tools/compare/RealEndValuePercentileCard";
import type { RunSummary } from "@/lib/run-summary";
import { buildRunSummary } from "@/lib/run-summary";
import { useRunSummary, useRunDisplay } from "@/lib/hooks/use-run-summary-inputs";
import { toast } from "sonner";
import { SectionTitleWithInflation } from "@/components/tools/SectionTitleWithInflation";
import { Toggle } from "@/components/ui/Toggle";
import { InfoPopoverButton } from "@/components/ui/InfoPopoverButton";
import { useHateDrawdown } from "@/components/tools/compare/HateDrawdownToggle";
import { useToolForm } from "@/lib/hooks/use-tool-form";
import { useSearchSyncRunGuard } from "@/lib/hooks/use-search-sync-run-guard";
import { buildToolsUrl, shouldQueueToolAutorun } from "@/lib/tools-route";
import { recordSuccessfulToolRun } from "@/lib/tool-run-history";
import { buildStrategyVariants, buildStrategyYearlyGrowthSeries, normalizeStrategyLabel, shouldIncludeStrategyChartLabel } from "@/lib/strategy-page-data";
import { buildRealEndValuePercentileSeries } from "@/lib/strategy-percentiles";
import { annualizedInflationForRange, displayedAnnualizedInflationPct, inflationPctForSweepSectionTitle } from "@/lib/inflation";
import { formatPercent } from "@/lib/format";
import { buildSgovFinalValuesByWindow } from "@/lib/sgov-benchmark";
// Note: summary computations for Real CAGR are derived directly from per-window `cagr` values.

const DISTRIBUTION_PEAK_PERCENT = 38;
const DISTRIBUTION_LABEL_ORDER = [
  "TQQQ SMA Next Open",
  "TQQQ SMA Close",
  "TQQQ SMA Next Close",
  "TQQQ",
  "QLD SMA Next Open",
  "QLD SMA Close",
  "QLD SMA Next Close",
  "QLD",
  "QQQ",
  "UPRO SMA Next Open",
  "UPRO SMA Close",
  "UPRO SMA Next Close",
  "UPRO",
  "SSO SMA Next Open",
  "SSO SMA Close",
  "SSO SMA Next Close",
  "SSO",
  "VOO",
] as const;

type StrategyResult = {
  label: string;
  runs: RollingSimulationPoint[];
};

type DistributionCategoryWinRates = {
  vsSma: number;
  vsNonSma: number;
  vsUnleveraged: number;
  vsSgov: number;
};

type DistributionSummaryRow = {
  label: string;
  p10: number;
  p50: number;
  avg: number;
  p90: number;
};

type RankedDistributionSummaryRow = DistributionSummaryRow & {
  categoryWinRates: DistributionCategoryWinRates;
};

type StrategyDistributionSeries = {
  x: number[];
  series: Array<{
    key: string;
    label: string;
    color: string;
    borderWidth: number;
    y: number[];
  }>;
};

type DistributionSnapshot = {
  chart: StrategyDistributionSeries;
  rows: RankedDistributionSummaryRow[];
};

type SnapshotStrategySummary = {
  rows: SmaComparisonRow[];
  labels: string[];
};

type YearlyGrowthSeries = {
  years: string[];
  series: Array<{ label: string; values: (number | null)[] }>;
  inflation?: Array<number | null>;
};

function isAfterHoursStrategy(label: string): boolean {
  const normalized = normalizeStrategyLabel(label);
  return normalized.endsWith("SMA Close") || normalized.endsWith("SMA Next Close");
}

function formatStrategyLabelForDisplay(label: string, tradeAfterHours: boolean): string {
  const normalized = normalizeStrategyLabel(label);
  if (tradeAfterHours) return normalized;
  // When Trade After-Hours is off, "SMA Next Open" is the only SMA execution mode in play.
  // Display it as plain "SMA" in tables/charts.
  return normalized
    .replace(" SMA Next Open", " SMA")
    .replace(" SMA Close", " SMA")
    .replace(" SMA Next Close", " SMA");
}

const LETF_PROFILE: Record<string, { multiplier: 2 | 3; index: "sp500" | "nasdaq100" }> = {
  UPRO: { multiplier: 3, index: "sp500" },
  SSO: { multiplier: 2, index: "sp500" },
  TQQQ: { multiplier: 3, index: "nasdaq100" },
  QLD: { multiplier: 2, index: "nasdaq100" },
};

const INDEX_LABEL: Record<"sp500" | "nasdaq100", string> = {
  sp500: "SPX",
  nasdaq100: "NDX",
};

const INDEX_NAME: Record<"sp500" | "nasdaq100", string> = {
  sp500: "S&P 500",
  nasdaq100: "Nasdaq-100",
};

const SMA_EXECUTION_DESCRIPTION: Record<"Next Open" | "Close" | "Next Close", string> = {
  "Next Open": "at the next market open",
  Close: "at the same-day market close",
  "Next Close": "at the next market close",
};

/**
 * Returns a popover description for a strategy row. Returns null when the label
 * isn't one of the recognized leveraged-ETF / index strategies.
 */
function describeStrategy(rawLabel: string): React.ReactNode | null {
  const normalized = normalizeStrategyLabel(rawLabel);

  if (normalized === LABEL_INDEX_SP500_TR) {
    return (
      <div className="space-y-2">
        <p className="font-semibold text-foreground">VOO: plain S&P 500 baseline</p>
        <p>Tracks the S&P 500 without leverage. It stays invested the whole time and is the simple benchmark for SPX strategies.</p>
      </div>
    );
  }
  if (normalized === LABEL_INDEX_NASDAQ100_TR) {
    return (
      <div className="space-y-2">
        <p className="font-semibold text-foreground">QQQ: plain Nasdaq-100 baseline</p>
        <p>Tracks the Nasdaq-100 without leverage. It stays invested the whole time and is the simple benchmark for NDX strategies.</p>
      </div>
    );
  }

  const smaMatch = normalized.match(/^(UPRO|SSO|TQQQ|QLD)(?: SMA(?: (Next Open|Close|Next Close))?)?$/);
  if (!smaMatch) return null;

  const ticker = smaMatch[1] as keyof typeof LETF_PROFILE;
  const isSma = normalized.includes(" SMA");
  const executionMode = (smaMatch[2] ?? null) as "Next Open" | "Close" | "Next Close" | null;
  const profile = LETF_PROFILE[ticker];
  const indexName = INDEX_LABEL[profile.index];
  const indexFullName = INDEX_NAME[profile.index];
  const fundDescription = `${ticker} targets ${profile.multiplier}x the daily move of the ${indexFullName} (${indexName}).`;

  if (!isSma) {
    return (
      <div className="space-y-2">
        <p className="font-semibold text-foreground">{ticker}: buy and hold</p>
        <p>{fundDescription} It stays in {ticker} the whole time, so losses can compound quickly in deep drawdowns.</p>
      </div>
    );
  }

  const smaParamLabel = profile.index === "sp500" ? "SPX SMA Period and Buffer" : "NDX SMA Period and Buffer";
  const indexShort = profile.index === "sp500" ? "SPX" : "NDX";
  const executionDetail = executionMode
    ? SMA_EXECUTION_DESCRIPTION[executionMode]
    : SMA_EXECUTION_DESCRIPTION["Next Open"];

  return (
    <div className="space-y-2">
      <p>
        {fundDescription} The strategy buys {ticker} when {indexShort} rises above the SMA plus the buffer. It buys the selected risk-off asset when {indexShort} falls below the SMA minus the same buffer.
      </p>
      <p>
        Uses {smaParamLabel}. Switches happen {executionDetail}
        {executionMode ? "." : " by default."}
      </p>
    </div>
  );
}

function distributionCategoryForLabel(label: string): "sma" | "nonSma" | "unleveraged" | null {
  if (
    label === "UPRO SMA Next Open" ||
    label === "TQQQ SMA Next Open" ||
    label === "SSO SMA Next Open" ||
    label === "QLD SMA Next Open"
  ) return "sma";
  if (label === "UPRO" || label === "TQQQ" || label === "SSO" || label === "QLD") return "nonSma";
  if (label === LABEL_INDEX_SP500_TR || label === LABEL_INDEX_NASDAQ100_TR) return "unleveraged";
  return null;
}

function strategyFamilyForLabel(label: string): "sp500" | "nasdaq100" | null {
  const normalized = normalizeStrategyLabel(label);
  if (
    normalized === "UPRO" ||
    normalized === "UPRO SMA Next Open" ||
    normalized === "UPRO SMA Close" ||
    normalized === "UPRO SMA Next Close" ||
    normalized === "SSO" ||
    normalized === "SSO SMA Next Open" ||
    normalized === "SSO SMA Close" ||
    normalized === "SSO SMA Next Close" ||
    normalized === LABEL_INDEX_SP500_TR
  ) return "sp500";
  if (
    normalized === "TQQQ" ||
    normalized === "TQQQ SMA Next Open" ||
    normalized === "TQQQ SMA Close" ||
    normalized === "TQQQ SMA Next Close" ||
    normalized === "QLD" ||
    normalized === "QLD SMA Next Open" ||
    normalized === "QLD SMA Close" ||
    normalized === "QLD SMA Next Close" ||
    normalized === LABEL_INDEX_NASDAQ100_TR
  ) return "nasdaq100";
  return null;
}

function minEarliestStartForStrategyFamily(
  rows: SmaComparisonRow[],
  labelByIdx: Map<number, string>,
  family: "sp500" | "nasdaq100",
): string | undefined {
  let min: string | undefined;
  for (const row of rows) {
    const label = labelByIdx.get(row.parameterValue);
    if (!label) continue;
    if (strategyFamilyForLabel(label) !== family) continue;
    const d = row.earliestStartDate;
    if (!d) continue;
    if (min === undefined || d < min) min = d;
  }
  return min;
}

function getDistributionComparisonLabels(label: string): {
  vsSma?: string;
  vsNonSma?: string;
  vsUnleveraged?: string;
} {
  switch (label) {
    case "TQQQ SMA Next Open":
      return { vsNonSma: "TQQQ", vsUnleveraged: LABEL_INDEX_NASDAQ100_TR };
    case "QLD SMA Next Open":
      return { vsNonSma: "QLD", vsUnleveraged: LABEL_INDEX_NASDAQ100_TR };
    case "TQQQ":
      return { vsSma: "TQQQ SMA Next Open", vsUnleveraged: LABEL_INDEX_NASDAQ100_TR };
    case "QLD":
      return { vsSma: "QLD SMA Next Open", vsUnleveraged: LABEL_INDEX_NASDAQ100_TR };
    case LABEL_INDEX_NASDAQ100_TR:
      return { vsSma: "TQQQ SMA Next Open", vsNonSma: "TQQQ" };
    case "UPRO SMA Next Open":
      return { vsNonSma: "UPRO", vsUnleveraged: LABEL_INDEX_SP500_TR };
    case "SSO SMA Next Open":
      return { vsNonSma: "SSO", vsUnleveraged: LABEL_INDEX_SP500_TR };
    case "UPRO":
      return { vsSma: "UPRO SMA Next Open", vsUnleveraged: LABEL_INDEX_SP500_TR };
    case "SSO":
      return { vsSma: "SSO SMA Next Open", vsUnleveraged: LABEL_INDEX_SP500_TR };
    case LABEL_INDEX_SP500_TR:
      return { vsSma: "UPRO SMA Next Open", vsNonSma: "UPRO" };
    default:
      return {};
  }
}

function compareValuesWithTie(left: number, right: number): number {
  if (left > right) return 1;
  if (left < right) return 0;
  return 0.5;
}

function getDistributionLabelOrder(label: string): number {
  const idx = DISTRIBUTION_LABEL_ORDER.indexOf(label as (typeof DISTRIBUTION_LABEL_ORDER)[number]);
  return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
}

function isFiniteStrategyRun(run: RollingSimulationPoint): boolean {
  return (
    Number.isFinite(run.finalValue) &&
    Number.isFinite(run.nonLeveragedFinalValue) &&
    Number.isFinite(run.maxDrawdownPct) &&
    Number.isFinite(run.nonLeveragedMaxDrawdownPct) &&
    Number.isFinite(run.cagr) &&
    Number.isFinite(run.tradeCount) &&
    Number.isFinite(run.totalTradingCostPct)
  );
}

function hasInvalidLiveStrategyResults(results: StrategyResult[]): boolean {
  return results.some((result) =>
    result.label.includes("SMA") &&
    (
      result.runs.length === 0 ||
      result.runs.some((run) => !isFiniteStrategyRun(run))
    )
  );
}

function getStrategyColor(label: string): string {
  const normalized = normalizeStrategyLabel(label);
  if (normalized === "UPRO") return "#16f3ce";
  if (normalized === "UPRO SMA Close") return "#3b82f6";
  if (normalized === "UPRO SMA") return "#1d4ed8";
  if (normalized === "UPRO SMA Next Open") return "#1d4ed8";
  if (normalized === "UPRO SMA Next Close") return "#1e3a8a";
  if (normalized === "SSO") return "#06b6d4";
  if (normalized === "SSO SMA Close") return "#10b981";
  if (normalized === "SSO SMA") return "#0f766e";
  if (normalized === "SSO SMA Next Open") return "#0f766e";
  if (normalized === "SSO SMA Next Close") return "#065f46";
  if (normalized === LABEL_INDEX_SP500_TR) return "#64748b";
  if (normalized === "TQQQ") return "#ef4444";
  if (normalized === "TQQQ SMA Close") return "#eab308";
  if (normalized === "TQQQ SMA") return "#a16207";
  if (normalized === "TQQQ SMA Next Open") return "#a16207";
  if (normalized === "TQQQ SMA Next Close") return "#92400e";
  if (normalized === "QLD") return "#f97316";
  if (normalized === "QLD SMA Close") return "#ec4899";
  if (normalized === "QLD SMA") return "#9d174d";
  if (normalized === "QLD SMA Next Open") return "#9d174d";
  if (normalized === "QLD SMA Next Close") return "#831843";
  if (normalized === LABEL_INDEX_NASDAQ100_TR) return "#a78bfa";
  return "#94a3b8";
}

function findBestLabelByValue<T extends { label: string }>(
  rows: T[],
  metric: (row: T) => number
): string | undefined {
  if (rows.length === 0) return undefined;
  let best = rows[0];
  for (let i = 1; i < rows.length; i++) {
    if (metric(rows[i]) > metric(best)) {
      best = rows[i];
    }
  }
  return best.label;
}

export default function CompareLETFsPage() {
  return (
    <Suspense fallback={null}>
      <CompareLETFsPageContent active />
    </Suspense>
  );
}

export function CompareLETFsPageContent({
  active = true,
  suppressAutoRun = false,
  allowInitialSearchAutoRun = true,
}: {
  active?: boolean;
  suppressAutoRun?: boolean;
  allowInitialSearchAutoRun?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { markNextSearchAsInternal, shouldAutoRunFromSearch } = useSearchSyncRunGuard();
  const form = useToolForm("compare-letfs", {
    annualizedInflation: 0,
    monthlyCpi: [] as Array<{ date: string; value: number }>,
    strategyResults: [] as StrategyResult[],
    snapshotSummary: null as SnapshotStrategySummary | null,
    distributionSnapshot: null as DistributionSnapshot | null,
    yearlyGrowthSeries: null as YearlyGrowthSeries | null,
    runSummaryInputs: null as RunSummary | null,
    tradeAfterHours: false,
  }, {
    persistKeys: ["strategyResults", "snapshotSummary", "distributionSnapshot", "yearlyGrowthSeries", "annualizedInflation", "monthlyCpi", "runSummaryInputs", "tradeAfterHours"],
  });

  const {
    letf,
    startDate, endDate, setEndDate,
    windowLength,
    smaSpPeriod, smaNqPeriod,
    smaSpUpperBuffer, smaSpLowerBuffer, smaNqUpperBuffer, smaNqLowerBuffer,
    riskOffAsset,
    handleFieldChange, getUrlParams, initial, save, restoredFromCache,
  } = form;

  const { tradeAfterHours, setTradeAfterHours } = useTradeAfterHours();
  const { hateDrawdown, toggle: hateDrawdownToggle } = useHateDrawdown();
  const [annualizedInflation, setAnnualizedInflation] = useState(initial.annualizedInflation);
  const [monthlyCpi, setMonthlyCpi] = useState<Array<{ date: string; value: number }>>(initial.monthlyCpi);
  const [forwardChartData, setForwardChartData] = useState<{
    spxPrices: PricePoint[];
    ndxPrices: PricePoint[];
    rates: import("@/lib/simulation/types").RatePoint[];
    monthlyCpi: Array<{ date: string; value: number }>;
    uproConfig: EtfConfig;
    tqqqConfig: EtfConfig;
    spxRiskOffValues: Partial<Record<EtfConfig["riskOffAsset"], number[]>>;
    spxRiskOffOpenValues: Partial<Record<EtfConfig["riskOffAsset"], number[]>>;
    ndxRiskOffValues: Partial<Record<EtfConfig["riskOffAsset"], number[]>>;
    ndxRiskOffOpenValues: Partial<Record<EtfConfig["riskOffAsset"], number[]>>;
    effectiveStartSp: string;
    effectiveStartNq: string;
  } | null>(null);
  const [strategyResults, setStrategyResults] = useState<StrategyResult[]>(initial.strategyResults);
  const [snapshotSummary, setSnapshotSummary] = useState<SnapshotStrategySummary | null>(initial.snapshotSummary);
  const [distributionSnapshot, setDistributionSnapshot] = useState<DistributionSnapshot | null>(initial.distributionSnapshot);
  const [yearlyGrowthSeries, setYearlyGrowthSeries] = useState<YearlyGrowthSeries | null>(initial.yearlyGrowthSeries);
  const {
    runSummary,
    setRunSummary,
    applyRunSummaryFromSnapshot,
    clearRunSummary,
  } = useRunSummary(initial.runSummaryInputs as RunSummary | null);
  const display = useRunDisplay(runSummary);

  const [loading, setLoading] = useState(false);
  const [pendingRun, setPendingRun] = useState(false);
  const [runProgress, setRunProgress] = useMonotonicRunProgress();
  const [error, setError] = useState<string | null>(null);
  const [sgovFinalByWindow, setSgovFinalByWindow] = useState<Map<string, number>>(new Map());
  const abortControllerRef = useRef<AbortController | null>(null);


  // Allow start dates from the earliest index (sp500 ~1885).
  // Nasdaq strategies will simply produce fewer rolling windows.
  const dateRange = INDEX_DATE_RANGES["sp500"];

  type CompareLetfsSnapshotState = typeof initial;

  const hasInvalidCachedResults =
    hasInvalidLiveStrategyResults(strategyResults);
  const hasCachedResults = !hasInvalidCachedResults && (strategyResults.length > 0 || yearlyGrowthSeries !== null);

  const shouldHydrateSnapshot = !hasCachedResults && !restoredFromCache;

  useRefreshEndDateOnInitialVisit({
    active,
    hasCachedResults,
    shouldHydrateSnapshot,
    endDate,
    setEndDate,
  });

  const applySnapshot = useCallback(
    (state: Record<string, unknown>) => {
      const snapshot = state as Partial<CompareLetfsSnapshotState>;
      if (snapshot.strategyResults) setStrategyResults(snapshot.strategyResults as StrategyResult[]);
      if (snapshot.snapshotSummary) setSnapshotSummary(snapshot.snapshotSummary as SnapshotStrategySummary);
      if (snapshot.distributionSnapshot !== undefined) setDistributionSnapshot(snapshot.distributionSnapshot as DistributionSnapshot | null);
      if (snapshot.yearlyGrowthSeries) setYearlyGrowthSeries(snapshot.yearlyGrowthSeries as YearlyGrowthSeries);
      if (snapshot.annualizedInflation != null) setAnnualizedInflation(snapshot.annualizedInflation as number);
      if (snapshot.monthlyCpi != null) setMonthlyCpi(snapshot.monthlyCpi as Array<{ date: string; value: number }>);
      applyRunSummaryFromSnapshot(snapshot);
      if (snapshot.tradeAfterHours !== undefined) setTradeAfterHours(snapshot.tradeAfterHours as boolean);
      save(snapshot as CompareLetfsSnapshotState);
    },
    [applyRunSummaryFromSnapshot, save, setTradeAfterHours]
  );

  const { clearMetadata } = useToolSnapshot({
    pageKey: "compare-letfs",
    shouldHydrate: shouldHydrateSnapshot,
    onSnapshot: applySnapshot,
    hasPersistedResults: (state) =>
      !!(state as Partial<CompareLetfsSnapshotState>).runSummaryInputs ||
      ((state as Partial<CompareLetfsSnapshotState>).strategyResults?.length ?? 0) > 0 ||
      !!(state as Partial<CompareLetfsSnapshotState>).yearlyGrowthSeries,
  });

  // Load the data feeding the "1-year forward real return by SMA gap" raincloud chart
  // independently of the user clicking Run, so the chart is always populated
  // by the time the user scrolls to the bottom.
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    (async () => {
      try {
        const md = await fetchMarketData(
          ["sp500", "nasdaq100"],
          startDate,
          endDate,
          controller.signal,
          undefined,
          {
            allowMissingPrices: true,
            rateStartDate: MARKET_DATA_EARLIEST_START,
            warmUpTradingDays: Math.max(smaSpPeriod, smaNqPeriod),
          },
        );
        if (cancelled) return;

        const spxPrices = md.pricesByIndex["sp500"] ?? [];
        const ndxPrices = md.pricesByIndex["nasdaq100"] ?? [];
        const [spxRiskOff, ndxRiskOff] = await Promise.all([
          loadRiskOffPriceSeries(riskOffAsset, spxPrices, startDate, endDate, controller.signal),
          ndxPrices.length >= 2
            ? loadRiskOffPriceSeries(riskOffAsset, ndxPrices, startDate, endDate, controller.signal)
            : Promise.resolve({
                closeValuesByAsset: {} as Partial<Record<EtfConfig["riskOffAsset"], number[]>>,
                openValuesByAsset: {} as Partial<Record<EtfConfig["riskOffAsset"], number[]>>,
              }),
        ]);
        if (cancelled) return;

        const { sp500Variants, nasdaqVariants } = buildStrategyVariants({
          smaSpPeriod,
          smaNqPeriod,
          smaSpUpperBuffer,
          smaSpLowerBuffer,
          smaNqUpperBuffer,
          smaNqLowerBuffer,
          riskOffAsset,
          tradeAfterHours,
        });
        const executionMode = tradeAfterHours ? "trigger-day-close" : "next-day-open";
        const uproConfig = sp500Variants.find(
          ({ config }) => config.name === "UPRO" && config.smaEnabled && config.smaExecutionMode === executionMode,
        )?.config;
        const tqqqConfig = nasdaqVariants.find(
          ({ config }) => config.name === "TQQQ" && config.smaEnabled && config.smaExecutionMode === executionMode,
        )?.config;
        if (!uproConfig || !tqqqConfig) throw new Error("Missing SMA chart strategy configuration.");

        setForwardChartData({
          spxPrices,
          ndxPrices,
          rates: md.rates,
          monthlyCpi: md.monthlyCpi,
          uproConfig,
          tqqqConfig,
          spxRiskOffValues: spxRiskOff.closeValuesByAsset,
          spxRiskOffOpenValues: spxRiskOff.openValuesByAsset,
          ndxRiskOffValues: ndxRiskOff.closeValuesByAsset,
          ndxRiskOffOpenValues: ndxRiskOff.openValuesByAsset,
          effectiveStartSp: effectiveStartDateFromAlignedSeries({
            requestedStartDate: startDate,
            dates: spxPrices.map((price) => price.date),
            closeByTicker: spxRiskOff.closeValuesByAsset,
          }),
          effectiveStartNq: effectiveStartDateFromAlignedSeries({
            requestedStartDate: startDate,
            dates: ndxPrices.map((price) => price.date),
            closeByTicker: ndxRiskOff.closeValuesByAsset,
          }),
        });
      } catch {
        // Silent fallback — chart shows empty-state message.
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [
    startDate,
    endDate,
    smaSpPeriod,
    smaNqPeriod,
    smaSpUpperBuffer,
    smaSpLowerBuffer,
    smaNqUpperBuffer,
    smaNqLowerBuffer,
    riskOffAsset,
    tradeAfterHours,
  ]);

  useEffect(() => {
    if (!hasInvalidCachedResults) return;
    // Defer state updates to avoid cascading render warnings
    Promise.resolve().then(() => {
      setStrategyResults([]);
      setSnapshotSummary(null);
      setDistributionSnapshot(null);
      setYearlyGrowthSeries(null);
      clearRunSummary();
    });
    save({
      letf: form.letf, index: form.index,
      startDate, endDate, windowLength,
      smaSpPeriod, smaNqPeriod,
      smaSpUpperBuffer, smaSpLowerBuffer, smaNqUpperBuffer, smaNqLowerBuffer,
      riskOffAsset,
      annualizedInflation,
      monthlyCpi,
      strategyResults: [],
      snapshotSummary: null,
      distributionSnapshot: null,
      yearlyGrowthSeries: null,
      runSummaryInputs: null,
      tradeAfterHours,
    });
  }, [
    hasInvalidCachedResults,
    form.letf, form.index,
    startDate, endDate, windowLength,
    smaSpPeriod, smaNqPeriod,
    smaSpUpperBuffer, smaSpLowerBuffer, smaNqUpperBuffer, smaNqLowerBuffer,
    riskOffAsset,
    annualizedInflation,
    monthlyCpi,
    save,
    clearRunSummary,
    tradeAfterHours,
  ]);

  const displayedStrategyResults = useMemo(() => {
    if (tradeAfterHours) return strategyResults;
    return strategyResults.filter((r) => !isAfterHoursStrategy(r.label));
  }, [strategyResults, tradeAfterHours]);

  useEffect(() => {
    if (!active) return;
    if (loading) return;
    const params = new URLSearchParams(searchParams.toString());

    // Defer state updates to avoid cascading render warnings
    Promise.resolve().then(() => {
      setPendingRun(
        shouldQueueToolAutorun(
          params,
          {
            allowInitialSearchAutoRun,
            suppressAutoRun,
            shouldAutoRunFromSearch,
            hasCachedResults,
          },
          pathname
        )
      );
    });
  }, [active, loading, suppressAutoRun, allowInitialSearchAutoRun, hasCachedResults, shouldAutoRunFromSearch, searchParams, pathname]);

  const getStrategiesUrlParams = useCallback(() => {
    const params = getUrlParams();
    params.delete("letf");
    return params;
  }, [getUrlParams]);

  const updateUrl = useCallback(() => {
    markNextSearchAsInternal();
    router.push(buildToolsUrl("strategies", getStrategiesUrlParams()));
  }, [getStrategiesUrlParams, router, markNextSearchAsInternal]);

  const handleCancel = useCallback(() => {
    abortControllerRef.current?.abort();
    setLoading(false);
    setRunProgress(null);
  }, [setRunProgress]);

  const handleRun = useCallback(async () => {
    setLoading(true);
    setRunProgress({ pct: 5, label: "Loading market data for both indexes..." });
    setError(null);
    updateUrl();

    // Abort any existing run
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const signal = controller.signal;

    try {
      // Fetch prices for both indexes + rates + inflation
      const marketData = await fetchMarketData(
        ["sp500", "nasdaq100"],
        startDate,
        endDate,
        signal,
        ({ completed, total, label }) => {
          setRunProgress({ pct: 5 + (completed / total) * 15, label });
        },
        {
          allowMissingPrices: true,
          rateStartDate: MARKET_DATA_EARLIEST_START,
          warmUpTradingDays: Math.max(smaSpPeriod, smaNqPeriod),
        }
      );
      const { rates, pricesByIndex, inflationWarning } = marketData;
      const inflationData = { annualizedInflation: marketData.annualizedInflation, monthlyCpi: marketData.monthlyCpi };
      setAnnualizedInflation(inflationData.annualizedInflation);
      setMonthlyCpi(inflationData.monthlyCpi);

      const sp500Prices = pricesByIndex["sp500"];
      const nasdaqPrices = pricesByIndex["nasdaq100"];
      const hasNasdaqPrices = nasdaqPrices.length >= 2;

      // Each index runs independently — no common-date intersection needed.
      // SP500 data may start from 1885, Nasdaq from 1985.
      if (sp500Prices.length < 2) {
        throw new Error(`Not enough ${LABEL_INDEX_SP500_TR} price data for this range.`);
      }

      setRunProgress({ pct: 20, label: "Loading risk-off prices..." });

      // Fetch risk-off prices (composite assets need multiple fetches)
      const riskSeriesForSp500 = await loadRiskOffPriceSeries(riskOffAsset, sp500Prices, startDate, endDate, signal);
      const riskSeriesForNasdaq = hasNasdaqPrices
        ? await loadRiskOffPriceSeries(riskOffAsset, nasdaqPrices, startDate, endDate, signal)
        : {
            closeValuesByAsset: {} as Partial<Record<EtfConfig["riskOffAsset"], number[]>>,
            openValuesByAsset: {} as Partial<Record<EtfConfig["riskOffAsset"], number[]>>,
          };

      const effectiveStartSp = effectiveStartDateFromAlignedSeries({
        requestedStartDate: startDate,
        dates: sp500Prices.map((p) => p.date),
        closeByTicker: riskSeriesForSp500.closeValuesByAsset,
      });
      const effectiveStartNq = hasNasdaqPrices
        ? effectiveStartDateFromAlignedSeries({
            requestedStartDate: startDate,
            dates: nasdaqPrices.map((p) => p.date),
            closeByTicker: riskSeriesForNasdaq.closeValuesByAsset,
          })
        : startDate;
      // Only warn about risk-off data gaps for SP500 — NDX strategies are naturally
      // capped at NDX data availability (1971-02-05), which is a price-history limit
      // not a risk-off basket limit.
      if (effectiveStartSp > startDate) {
        toast.warning(
          `Some risk-off components don't have data before ${effectiveStartSp}. ${LABEL_INDEX_SP500_TR} strategies will start from ${effectiveStartSp}.`,
          { duration: Infinity }
        );
      }

      setRunProgress({ pct: 35, label: "Running strategy simulations..." });

      const { sp500Variants, nasdaqVariants } = buildStrategyVariants({
        smaSpPeriod,
        smaNqPeriod,
        smaSpUpperBuffer, smaSpLowerBuffer, smaNqUpperBuffer, smaNqLowerBuffer,
        riskOffAsset,
        tradeAfterHours,
      });
      const effectiveNasdaqVariants = hasNasdaqPrices ? nasdaqVariants : [];

      const sp500ResultsPromise = runParallelVariants({
        prices: sp500Prices,
        rates,
        windowLength,
        startDate: effectiveStartSp,
        endDate,
        variants: sp500Variants,
        riskOffValuesByAsset: riskSeriesForSp500.closeValuesByAsset,
        riskOffOpenValuesByAsset: riskSeriesForSp500.openValuesByAsset,
        onProgress: (done: number, total: number) => {
          setRunProgress({
            pct: 35 + (done / total) * 30,
            label: `${LABEL_INDEX_SP500_TR} strategies (${done}/${total})...`,
          });
        },
      });

      const nasdaqResultsPromise = hasNasdaqPrices
        ? runParallelVariants({
            prices: nasdaqPrices,
            rates,
            windowLength,
            startDate: effectiveStartNq,
            endDate,
            variants: effectiveNasdaqVariants,
            riskOffValuesByAsset: riskSeriesForNasdaq.closeValuesByAsset,
            riskOffOpenValuesByAsset: riskSeriesForNasdaq.openValuesByAsset,
            onProgress: (done: number, total: number) => {
              setRunProgress({
                pct: 65 + (done / total) * 30,
                label: `${LABEL_INDEX_NASDAQ100_TR} strategies (${done}/${total})...`,
              });
            },
          })
        : Promise.resolve([] as Array<{ label: string; simulations: RollingSimulationPoint[] }>);

      const [sp500Results, nasdaqResults] = await Promise.all([sp500ResultsPromise, nasdaqResultsPromise]);
      if (signal.aborted) throw new Error("Aborted");

      const allResults: StrategyResult[] = [
        ...sp500Results.map(({ label, simulations }) => ({ label, runs: simulations })),
        ...nasdaqResults.map(({ label, simulations }) => ({ label, runs: simulations })),
      ];

      setStrategyResults(allResults);
      setSnapshotSummary(null);

      // Run single full-period backtests for yearly real growth chart
      setRunProgress({ pct: 96, label: "Computing yearly growth..." });
      const sp500Backtest = simulateWithWarmUp(
        sp500Prices,
        rates,
        sp500Variants.map((v) => v.config),
        startDate,
        1000, // Sufficient SMA history for state to sync
        {
          riskOffValuesByAsset: riskSeriesForSp500.closeValuesByAsset,
          riskOffOpenValuesByAsset: riskSeriesForSp500.openValuesByAsset,
          endDate,
        },
      );
      const nasdaqBacktest = hasNasdaqPrices
        ? simulateWithWarmUp(
            nasdaqPrices,
            rates,
            effectiveNasdaqVariants.map((v) => v.config),
            startDate,
            1000, // Sufficient SMA history for state to sync
            {
              riskOffValuesByAsset: riskSeriesForNasdaq.closeValuesByAsset,
              riskOffOpenValuesByAsset: riskSeriesForNasdaq.openValuesByAsset,
              endDate,
            },
          )
        : null;

      const computedYearlyGrowthSeries: YearlyGrowthSeries = buildStrategyYearlyGrowthSeries({
        sp500Backtest,
        nasdaqBacktest,
        sp500Variants,
        nasdaqVariants: effectiveNasdaqVariants,
        monthlyCpi: inflationData.monthlyCpi,
      });
      setYearlyGrowthSeries(computedYearlyGrowthSeries);

      const nextRunSummary = buildRunSummary({
        startDate,
        endDate,
        windowLength,
        smaSpPeriod,
        smaSpUpperBuffer, smaSpLowerBuffer,
        smaNqPeriod,
        smaNqUpperBuffer, smaNqLowerBuffer,
        letf,
        riskOffAsset,
        tradeAfterHours,
      });
      setRunSummary(nextRunSummary);

      // URL params
      save({
      letf: form.letf, index: form.index,
      startDate, endDate, windowLength,
      smaSpPeriod, smaNqPeriod,
      smaSpUpperBuffer, smaSpLowerBuffer, smaNqUpperBuffer, smaNqLowerBuffer,
      riskOffAsset,
      annualizedInflation: inflationData.annualizedInflation,
      monthlyCpi: inflationData.monthlyCpi,
        strategyResults: allResults,
        snapshotSummary: null,
        distributionSnapshot: null,
        yearlyGrowthSeries: computedYearlyGrowthSeries,
        runSummaryInputs: nextRunSummary,
        tradeAfterHours,
      });

      if (inflationWarning) {
        setError("Inflation data unavailable — Real CAGR may be inaccurate.");
      }
      if (allResults.every((r) => r.runs.length === 0)) {
        setError("No valid simulations for this range.");
      }
      clearMetadata();
      setRunProgress({ pct: 100, label: "Done" });
      if (allResults.some((r) => r.runs.length > 0)) {
        recordSuccessfulToolRun({
          tab: "strategies",
          tabLabel: "Strategies",
          href: buildToolsUrl("strategies", getStrategiesUrlParams()),
          summary: nextRunSummary,
          summaryDisplay: { showLetf: false },
        });
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return;
      }
      const message = err instanceof Error ? err.message : "Unexpected error";
      setError(message);
      setStrategyResults([]);
      setSnapshotSummary(null);
    } finally {
      if (abortControllerRef.current === controller) {
        setLoading(false);
        setRunProgress(null);
        abortControllerRef.current = null;
      }
    }
  }, [startDate, endDate, windowLength, smaSpPeriod, smaNqPeriod, smaSpUpperBuffer, smaSpLowerBuffer, smaNqUpperBuffer, smaNqLowerBuffer, riskOffAsset, form.letf, form.index, save, setRunSummary, updateUrl, clearMetadata, tradeAfterHours, letf, getStrategiesUrlParams, setRunProgress]);

  // Auto-run when page opened with URL params
  useEffect(() => {
    if (pendingRun && !loading) {
      // Defer state update to avoid cascading render lint error
      Promise.resolve().then(() => {
        setPendingRun(false);
        handleRun();
      });
    }
  }, [pendingRun, loading, handleRun]);

  const comparisonTableInflationPct = 0;

  // Summary table data — reuse the shared rolling summarizer so this page
  // matches SMA Period / SMA Buffer / Risk-Off / Statistics exactly.
  const { summaryRows, labelByIdx } = useMemo(() => {
    if ((strategyResults.length === 0 || hasInvalidCachedResults) && snapshotSummary) {
      const filteredLabels = snapshotSummary.labels.filter(
        (label) => tradeAfterHours || !isAfterHoursStrategy(label)
      );
      const labelToOriginalIndex = new Map(snapshotSummary.labels.map((label, idx) => [label, idx]));
      const filteredRows = filteredLabels
        .map((label) => {
          const originalIdx = labelToOriginalIndex.get(label);
          return originalIdx == null ? null : snapshotSummary.rows[originalIdx];
        })
        .filter((row): row is SmaComparisonRow => row !== null);
      return {
        summaryRows: filteredRows,
        labelByIdx: new Map(
          filteredLabels
            .map((label) => {
              const originalIdx = labelToOriginalIndex.get(label);
              return originalIdx == null ? null : [originalIdx, normalizeStrategyLabel(label)] as const;
            })
            .filter((entry): entry is readonly [number, string] => entry !== null)
        ),
      };
    }
    if (hasInvalidCachedResults) {
      return { summaryRows: [] as SmaComparisonRow[], labelByIdx: new Map<number, string>() };
    }
    const labels = new Map<number, string>();
    const rows = displayedStrategyResults
      .map((sr, idx) => {
        labels.set(idx, normalizeStrategyLabel(sr.label));
        return summarizeSmaRow(idx, sr.runs, monthlyCpi);
      });
    return { summaryRows: rows, labelByIdx: labels };
  }, [displayedStrategyResults, strategyResults.length, monthlyCpi, snapshotSummary, hasInvalidCachedResults, tradeAfterHours]);

  const cpiEndDate = display?.summary.endDate ?? endDate;
  const displayStartDate = display?.summary.startDate ?? startDate;
  const sp500StrategyDisplayStart = useMemo(
    () => minEarliestStartForStrategyFamily(summaryRows, labelByIdx, "sp500"),
    [summaryRows, labelByIdx]
  );
  const nasdaqStrategyDisplayStart = useMemo(
    () => minEarliestStartForStrategyFamily(summaryRows, labelByIdx, "nasdaq100"),
    [summaryRows, labelByIdx]
  );
  const bothFamiliesInSummary = useMemo(() => {
    let hasSp500 = false;
    let hasNasdaq = false;
    for (const row of summaryRows) {
      const label = labelByIdx.get(row.parameterValue);
      if (!label) continue;
      const fam = strategyFamilyForLabel(label);
      if (fam === "sp500") hasSp500 = true;
      if (fam === "nasdaq100") hasNasdaq = true;
    }
    return hasSp500 && hasNasdaq;
  }, [summaryRows, labelByIdx]);

  const realEndValuePercentileSeries = useMemo(
    () => {
      const orderedStrategies = displayedStrategyResults
        .map((result, idx) => {
          const row = summaryRows[idx];
          if (!row) return null;
          const label = formatStrategyLabelForDisplay(result.label, tradeAfterHours);
          return {
            label,
            color: getStrategyColor(label),
            score: scoreRow(row, comparisonTableInflationPct, row.avgWindowYears ?? windowLength, { hateDrawdown }),
            runs: result.runs,
          };
        })
        .filter((strategy): strategy is {
          label: string;
          color: string;
          score: number;
          runs: RollingSimulationPoint[];
        } => strategy !== null)
        .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label))
        .map(({ score, ...strategy }) => {
          void score;
          return strategy;
        });

      return buildRealEndValuePercentileSeries({
        strategies: orderedStrategies,
        monthlyCpi,
      });
    },
    [displayedStrategyResults, monthlyCpi, tradeAfterHours, summaryRows, windowLength, hateDrawdown]
  );

  const sp500InflationPctForDisplay = useMemo(
    () =>
      inflationPctForSweepSectionTitle({
        monthlyCpi,
        sectionDisplayStartDate: sp500StrategyDisplayStart,
        fallbackStartDate: displayStartDate,
        cpiEndDate,
        annualizedInflation,
      }),
    [
      monthlyCpi,
      sp500StrategyDisplayStart,
      displayStartDate,
      cpiEndDate,
      annualizedInflation,
    ]
  );
  const nasdaqInflationPctForDisplay = useMemo(
    () =>
      inflationPctForSweepSectionTitle({
        monthlyCpi,
        sectionDisplayStartDate: nasdaqStrategyDisplayStart,
        fallbackStartDate: displayStartDate,
        cpiEndDate,
        annualizedInflation,
      }),
    [
      monthlyCpi,
      nasdaqStrategyDisplayStart,
      displayStartDate,
      cpiEndDate,
      annualizedInflation,
    ]
  );

  /** Always-on Avg Inflation for tables that need inflation context regardless of history-wrap (e.g. Real Yearly Growth Rate). */
  const realYearlyGrowthInflationPct = useMemo(
    () =>
      displayedAnnualizedInflationPct(
        monthlyCpi,
        displayStartDate,
        cpiEndDate,
        annualizedInflation,
      ),
    [monthlyCpi, displayStartDate, cpiEndDate, annualizedInflation]
  );

  /** One combined title inflation only when a single index family is in the summary (combo mixes two effective CPI ranges). */
  const singleFamilySweepTitleInflationPct = useMemo(
    () =>
      bothFamiliesInSummary
        ? null
        : inflationPctForSweepSectionTitle({
            monthlyCpi,
            sectionDisplayStartDate: sp500StrategyDisplayStart ?? nasdaqStrategyDisplayStart,
            fallbackStartDate: displayStartDate,
            cpiEndDate,
            annualizedInflation,
          }),
    [
      bothFamiliesInSummary,
      monthlyCpi,
      sp500StrategyDisplayStart,
      nasdaqStrategyDisplayStart,
      displayStartDate,
      cpiEndDate,
      annualizedInflation,
    ]
  );

  const displayedYearlyGrowthSeries = useMemo<YearlyGrowthSeries | null>(() => {
    if (!yearlyGrowthSeries) return null;
    const sorted = [...yearlyGrowthSeries.series].sort(
      (a, b) =>
        getDistributionLabelOrder(a.label) - getDistributionLabelOrder(b.label) ||
        a.label.localeCompare(b.label)
    );
    return {
      years: yearlyGrowthSeries.years,
      series: sorted.map((s) => ({
        ...s,
        label: formatStrategyLabelForDisplay(s.label, tradeAfterHours),
      })),
      inflation: yearlyGrowthSeries.inflation,
    };
  }, [yearlyGrowthSeries, tradeAfterHours]);

  const uproPreset = ETF_PRESETS["UPRO"];
  const tqqqPreset = ETF_PRESETS["TQQQ"];
  const ssoPreset = ETF_PRESETS["SSO"];
  const qldPreset = ETF_PRESETS["QLD"];

  const presetKeyForLabel = useCallback(
    (label: string) => {
      if (label.includes("SSO")) return "SSO";
      if (label.includes("QLD")) return "QLD";
      return label.includes("S&P") || label.includes("UPRO") ? "UPRO" : "TQQQ";
    },
    []
  );

  const getStrategyLinkMeta = useCallback(
    (label: string): {
      isIndex: boolean;
      isSma: boolean;
      presetKey: "UPRO" | "SSO" | "TQQQ" | "QLD";
      preset: typeof uproPreset;
      smaPeriod: number;
      smaUpperBuffer: number;
      smaLowerBuffer: number;
    } => {
      const isSp500 = label.includes("S&P") || label.includes("UPRO") || label.includes("SSO");
      const isIndex = label.includes("S&P 500") || label.includes("Nasdaq 100");
      const isSma = label.includes("SMA");
      const presetKey = presetKeyForLabel(label);
      const preset = presetKey === "SSO"
        ? ssoPreset
        : presetKey === "QLD"
          ? qldPreset
          : presetKey === "UPRO"
            ? uproPreset
            : tqqqPreset;

      return {
        isIndex,
        isSma,
        presetKey,
        preset,
        smaPeriod: isSp500 ? smaSpPeriod : smaNqPeriod,
        smaUpperBuffer: isSp500 ? smaSpUpperBuffer : smaNqUpperBuffer,
        smaLowerBuffer: isSp500 ? smaSpLowerBuffer : smaNqLowerBuffer,
      };
    },
    [presetKeyForLabel, uproPreset, ssoPreset, tqqqPreset, qldPreset, smaSpPeriod, smaNqPeriod, smaSpUpperBuffer, smaSpLowerBuffer, smaNqUpperBuffer, smaNqLowerBuffer]
  );

  const buildBacktestUrl = useCallback(
    (label: string, dates: { start: string; end: string }) => {
      const meta = getStrategyLinkMeta(label);
      return buildPresetBacktestUrl({
        preset: meta.preset,
        startDate: dates.start,
        endDate: dates.end,
        smaPeriod: meta.smaPeriod,
        smaUpperBuffer: meta.smaUpperBuffer,
        smaLowerBuffer: meta.smaLowerBuffer,
        riskOffAsset,
      });
    },
    [getStrategyLinkMeta, riskOffAsset]
  );

  const liveStrategyDistributionSeries = useMemo(
    () =>
      computeSharedHistogramDistribution(
        displayedStrategyResults
          .filter((result) => shouldIncludeStrategyChartLabel(result.label))
          .map((result) => ({
            key: result.label,
            label: normalizeStrategyLabel(result.label),
            color: getStrategyColor(result.label),
            values: result.runs.map((run) => run.cagr - (monthlyCpi.length >= 2 ? annualizedInflationForRange(monthlyCpi, run.startDate, run.endDate) * 100 : 0)),
            borderWidth: 1.2,
          }))
          .filter((series) => series.values.some(Number.isFinite)),
        90
      ),
    [displayedStrategyResults, monthlyCpi]
  );
  const strategyDistributionSeries = useMemo<StrategyDistributionSeries>(
    () => liveStrategyDistributionSeries.series.length > 0 ? liveStrategyDistributionSeries : (distributionSnapshot?.chart ?? { x: [], series: [] }),
    [liveStrategyDistributionSeries, distributionSnapshot]
  );

  const distributionWindows = useMemo(
    () =>
      displayedStrategyResults
        .filter((result) => shouldIncludeStrategyChartLabel(result.label))
        .flatMap((result) => result.runs.map((run) => ({ startDate: run.startDate, endDate: run.endDate }))),
    [displayedStrategyResults]
  );

  useEffect(() => {
    if (distributionWindows.length === 0) {
      return;
    }

    const controller = new AbortController();

    const load = async () => {
      const sgovStartDate = distributionWindows.reduce(
        (earliest, window) => (window.startDate < earliest ? window.startDate : earliest),
        distributionWindows[0].startDate
      );
      const sgovEndDate = distributionWindows.reduce(
        (latest, window) => (window.endDate > latest ? window.endDate : latest),
        distributionWindows[0].endDate
      );
      const response = await fetchJsonCached<PricePoint[]>(
        `/api/risk-off-prices?asset=SGOV&startDate=${sgovStartDate}&endDate=${sgovEndDate}`,
        controller.signal
      );
      if (!response.ok) return;
      const points = response.data ?? [];
      setSgovFinalByWindow(
        buildSgovFinalValuesByWindow(distributionWindows, points, CONSTANT_INITIAL_INVESTMENT)
      );
    };

    load().catch((fetchError) => {
      if (fetchError instanceof Error && fetchError.name === "AbortError") return;
      console.error("Failed to load SGOV benchmark prices:", fetchError);
    });

    return () => controller.abort();
  }, [distributionWindows]);

  const liveDistributionSummaryRows = useMemo<DistributionSummaryRow[]>(() => {
    return liveStrategyDistributionSeries.series
      .map((series) => {
        const values = strategyResults
          .find((result) => shouldIncludeStrategyChartLabel(result.label) && normalizeStrategyLabel(result.label) === series.label)
          ?.runs.map((run) => run.cagr - (monthlyCpi.length >= 2 ? annualizedInflationForRange(monthlyCpi, run.startDate, run.endDate) * 100 : 0))
          .filter(Number.isFinite) ?? [];
        if (values.length === 0) return null;
        const sorted = [...values].sort((a, b) => a - b);
        return {
          label: series.label,
          p10: percentile(sorted, 0.1),
          p50: percentile(sorted, 0.5),
          avg: values.reduce((sum, value) => sum + value, 0) / values.length,
          p90: percentile(sorted, 0.9),
        };
      })
      .filter((row): row is DistributionSummaryRow => row !== null);
  }, [liveStrategyDistributionSeries, strategyResults, monthlyCpi]);
  const distributionSummaryRows = useMemo<DistributionSummaryRow[]>(
    () => liveDistributionSummaryRows.length > 0 ? liveDistributionSummaryRows : distributionSnapshot?.rows.map(// eslint-disable-next-line @typescript-eslint/no-unused-vars
        ({ categoryWinRates, ...row }) => row) ?? [],
    [liveDistributionSummaryRows, distributionSnapshot]
  );

  const liveDistributionCategoryWinRates = useMemo(() => {
    const includedResults = strategyResults
      .filter((result) => shouldIncludeStrategyChartLabel(result.label))
      .map((result) => ({
        label: normalizeStrategyLabel(result.label),
        byWindow: new Map<string, RollingSimulationPoint>(
          result.runs.map((run) => [`${run.startDate}|${run.endDate}`, run] as const)
        ),
      }));
    const byLabel = new Map(includedResults.map((result) => [result.label, result]));
    const labels = Array.from(new Set(includedResults.map((result) => result.label)));

    const computeWinRate = (label: string, opponentLabel?: string): number => {
      if (!opponentLabel) return 0;
      const result = byLabel.get(label);
      const opponent = byLabel.get(opponentLabel);
      if (!result || !opponent) return 0;

      let total = 0;
      let wins = 0;
      for (const [key, run] of result.byWindow.entries()) {
        const opponentRun = opponent.byWindow.get(key);
        if (!opponentRun) continue;
        wins += compareValuesWithTie(run.finalValue, opponentRun.finalValue);
        total += 1;
      }

      return total === 0 ? 0 : (wins / total) * 100;
    };

    const computeWinRateVsSgov = (label: string): number => {
      const result = byLabel.get(label);
      if (!result) return 0;
      let total = 0;
      let wins = 0;
      for (const [key, run] of result.byWindow.entries()) {
        const sgovFinal = sgovFinalByWindow.get(key);
        if (sgovFinal == null) continue;
        wins += compareValuesWithTie(run.finalValue, sgovFinal);
        total += 1;
      }
      return total === 0 ? 0 : (wins / total) * 100;
    };

    const ratesByLabel = new Map<string, DistributionCategoryWinRates>();
    for (const label of labels) {
      const comparisons = getDistributionComparisonLabels(label);
      ratesByLabel.set(label, {
        vsSma: computeWinRate(label, comparisons.vsSma),
        vsNonSma: computeWinRate(label, comparisons.vsNonSma),
        vsUnleveraged: computeWinRate(label, comparisons.vsUnleveraged),
        vsSgov: computeWinRateVsSgov(label),
      });
    }

    return { labels, ratesByLabel };
  }, [strategyResults, sgovFinalByWindow]);
  const distributionCategoryWinRates = useMemo(
    () =>
      liveDistributionSummaryRows.length > 0
        ? liveDistributionCategoryWinRates
        : {
            labels: distributionSnapshot?.rows.map((row) => row.label) ?? [],
            ratesByLabel: new Map(
              (distributionSnapshot?.rows ?? []).map((row) => [row.label, row.categoryWinRates] as const)
            ),
          },
    [liveDistributionSummaryRows.length, liveDistributionCategoryWinRates, distributionSnapshot]
  );

  const rankedDistributionSummaryRows = useMemo<RankedDistributionSummaryRow[]>(() => {
    return [...distributionSummaryRows]
      .map((row) => ({
        ...row,
        categoryWinRates: distributionCategoryWinRates.ratesByLabel.get(row.label) ?? {
          vsSma: 0,
          vsNonSma: 0,
          vsUnleveraged: 0,
          vsSgov: 0,
        },
      }))
      .sort((a, b) =>
        getDistributionLabelOrder(a.label) - getDistributionLabelOrder(b.label) ||
        a.label.localeCompare(b.label)
      );
  }, [distributionSummaryRows, distributionCategoryWinRates]);

  const distributionScoreByLabel = useMemo(() => {
    const scores = new Map<string, number>();
    summaryRows.forEach((row) => {
      const label = labelByIdx.get(row.parameterValue);
      if (!label) return;
      scores.set(
        label,
        scoreRow(row, comparisonTableInflationPct, row.avgWindowYears ?? windowLength, { hateDrawdown })
      );
    });
    return scores;
  }, [summaryRows, labelByIdx, windowLength, hateDrawdown]);

  const sp500DistributionSeries = useMemo<StrategyDistributionSeries>(() => ({
    x: strategyDistributionSeries.x,
    series: strategyDistributionSeries.series
      .filter((series) => strategyFamilyForLabel(series.label) === "sp500")
      .sort((a, b) => (distributionScoreByLabel.get(b.label) ?? Number.NEGATIVE_INFINITY) - (distributionScoreByLabel.get(a.label) ?? Number.NEGATIVE_INFINITY) || a.label.localeCompare(b.label)),
  }), [strategyDistributionSeries, distributionScoreByLabel]);

  const nasdaqDistributionSeries = useMemo<StrategyDistributionSeries>(() => ({
    x: strategyDistributionSeries.x,
    series: strategyDistributionSeries.series
      .filter((series) => strategyFamilyForLabel(series.label) === "nasdaq100")
      .sort((a, b) => (distributionScoreByLabel.get(b.label) ?? Number.NEGATIVE_INFINITY) - (distributionScoreByLabel.get(a.label) ?? Number.NEGATIVE_INFINITY) || a.label.localeCompare(b.label)),
  }), [strategyDistributionSeries, distributionScoreByLabel]);

  const sp500DistributionRows = useMemo(
    () => rankedDistributionSummaryRows.filter((row) => strategyFamilyForLabel(row.label) === "sp500"),
    [rankedDistributionSummaryRows]
  );
  const nasdaqDistributionRows = useMemo(
    () => rankedDistributionSummaryRows.filter((row) => strategyFamilyForLabel(row.label) === "nasdaq100"),
    [rankedDistributionSummaryRows]
  );

  const sp500DistributionPercentileBests = useMemo(() => ({
    p10: findBestLabelByValue(sp500DistributionRows, (r) => r.p10),
    p50: findBestLabelByValue(sp500DistributionRows, (r) => r.p50),
    avg: findBestLabelByValue(sp500DistributionRows, (r) => r.avg),
    p90: findBestLabelByValue(sp500DistributionRows, (r) => r.p90),
  }), [sp500DistributionRows]);
  const nasdaqDistributionPercentileBests = useMemo(() => ({
    p10: findBestLabelByValue(nasdaqDistributionRows, (r) => r.p10),
    p50: findBestLabelByValue(nasdaqDistributionRows, (r) => r.p50),
    avg: findBestLabelByValue(nasdaqDistributionRows, (r) => r.avg),
    p90: findBestLabelByValue(nasdaqDistributionRows, (r) => r.p90),
  }), [nasdaqDistributionRows]);

  const yearlyGrowthTableSeries = useMemo<YearlyGrowthSeries | null>(() => {
    if (!displayedYearlyGrowthSeries) return null;
    const desiredOrder = [
      formatStrategyLabelForDisplay("UPRO SMA Next Open", tradeAfterHours),
      "UPRO",
      "VOO",
      formatStrategyLabelForDisplay("TQQQ SMA Next Open", tradeAfterHours),
      "TQQQ",
      "QQQ",
    ];
    const byLabel = new Map(displayedYearlyGrowthSeries.series.map((series) => [series.label, series]));
    const series = desiredOrder
      .map((label) => byLabel.get(label))
      .filter((series): series is NonNullable<typeof series> => Boolean(series));
    if (series.length === 0) return null;
    return {
      years: displayedYearlyGrowthSeries.years,
      series,
      inflation: displayedYearlyGrowthSeries.inflation,
    };
  }, [displayedYearlyGrowthSeries, tradeAfterHours]);

  return (
    <div className="min-h-screen bg-background text-foreground p-3 md:p-6">
      <RunSpinnerOverlay active={loading} label={runProgress?.label} pct={runProgress?.pct} />
      <div className="max-w-7xl mx-auto space-y-4 md:space-y-6">
        <h1 className="text-3xl md:text-4xl font-bold">Strategies</h1>

        <SharedToolInputs
          values={{
            startDate, endDate, windowLength,
            smaSpPeriod, smaSpUpperBuffer, smaSpLowerBuffer,
            smaNqPeriod, smaNqUpperBuffer, smaNqLowerBuffer,
            riskOffAsset,
          }}
          onChange={(field, val) => {
            handleFieldChange(field, val);
          }}
          dateRange={dateRange}
          onRun={handleRun}
          onCancel={handleCancel}
          loading={loading}
          runLabel="Compare Strategies"
          progress={runProgress}
          error={error}
        />

        {display && summaryRows.length > 0 && (
          <SimulationRunSummary
            summary={display.summary}
            showLetf={false}
          />
        )}

        {summaryRows.length > 0 && (
          <>
            <Card>
              <div className="mb-3 flex items-center justify-between gap-3 flex-wrap">
                <SectionTitleWithInflation
                  title="Strategy Comparison"
                  inflationPct={singleFamilySweepTitleInflationPct}
                />
                <div className="flex items-center gap-4 flex-wrap">
                  <div className="flex items-center gap-1.5">
                    <Toggle
                      label="Show After-Hours Variants"
                      checked={tradeAfterHours}
                      onChange={setTradeAfterHours}
                    />
                    <InfoPopoverButton label="Show After-Hours Variants">
                      Adds extra rows showing the same strategies traded after-hours at the close of the signal
                      day, instead of waiting for the next morning&apos;s open. Useful for comparing the two
                      execution timings side-by-side.
                    </InfoPopoverButton>
                  </div>
                  {hateDrawdownToggle}
                </div>
              </div>
              <p className="text-xs text-muted mb-4">
                Compare strategies with different start dates carefully — some periods are mostly bull markets while others are dominated by bear markets, so results may reflect the time period as much as the strategy itself.
              </p>
              <SweepComparisonTable
                resultTableTestId="snapshot-tool-sweep-main"
                rows={summaryRows}
                inflationPct={comparisonTableInflationPct}
                windowYears={windowLength}
                firstColumnLabel="Strategy"
                formatFirstColumn={(row) => formatStrategyLabelForDisplay(labelByIdx.get(row.parameterValue) ?? "", tradeAfterHours)}
                firstColumnInfo={(row) => describeStrategy(labelByIdx.get(row.parameterValue) ?? "")}
                getBacktestUrl={(row, dates) => buildBacktestUrl(labelByIdx.get(row.parameterValue) ?? "", dates)}
                colorDot={(row) => getStrategyColor(formatStrategyLabelForDisplay(labelByIdx.get(row.parameterValue) ?? "", tradeAfterHours))}
                pagination={false}
                startDate={display?.summary.startDate}
                hateDrawdown={hateDrawdown}
                showAvgCagr
              />
            </Card>
          </>
        )}

        {realEndValuePercentileSeries.length > 0 && (
          <RealEndValuePercentileCard series={realEndValuePercentileSeries} />
        )}

        {sp500DistributionSeries.series.length > 0 && (
          <StrategyDistributionCard
            title="Probability Distribution · SPX Family"
            startDate={sp500StrategyDisplayStart}
            inflationPct={sp500InflationPctForDisplay}
            description="Distribution of real CAGR% (nominal CAGR minus inflation) across all rolling simulations for SPX family strategies. All SMA strategies here use next-open execution."
            series={sp500DistributionSeries}
            rows={sp500DistributionRows}
            bests={sp500DistributionPercentileBests}
            tradeAfterHours={tradeAfterHours}
            smaLabel="UPRO SMA"
            nonSmaLabel="UPRO"
            unleveragedLabel="VOO"
          />
        )}

        {nasdaqDistributionSeries.series.length > 0 && (
          <StrategyDistributionCard
            title="Probability Distribution · NDX Family"
            startDate={nasdaqStrategyDisplayStart}
            inflationPct={nasdaqInflationPctForDisplay}
            description="Distribution of real CAGR% (nominal CAGR minus inflation) across all rolling simulations for NDX family strategies. All SMA strategies here use next-open execution."
            series={nasdaqDistributionSeries}
            rows={nasdaqDistributionRows}
            bests={nasdaqDistributionPercentileBests}
            tradeAfterHours={tradeAfterHours}
            smaLabel="TQQQ SMA"
            nonSmaLabel="TQQQ"
            unleveragedLabel="QQQ"
          />
        )}

        <RealYearlyGrowthTable
          yearlyGrowthSeries={yearlyGrowthTableSeries}
          description={`Year-over-year nominal return minus that year's CPI inflation across UPRO SMA, UPRO, VOO, TQQQ SMA, TQQQ, and QQQ. SMA columns use next-open execution.`}
          title="Real Yearly Growth Rate"
          inflationPct={realYearlyGrowthInflationPct}
        />

        {forwardChartData && (
          <ForwardReturnVsSmaGapChart
            spxPrices={forwardChartData.spxPrices}
            ndxPrices={forwardChartData.ndxPrices}
            rates={forwardChartData.rates}
            monthlyCpi={forwardChartData.monthlyCpi}
            uproConfig={forwardChartData.uproConfig}
            tqqqConfig={forwardChartData.tqqqConfig}
            spxRiskOffValues={forwardChartData.spxRiskOffValues}
            spxRiskOffOpenValues={forwardChartData.spxRiskOffOpenValues}
            ndxRiskOffValues={forwardChartData.ndxRiskOffValues}
            ndxRiskOffOpenValues={forwardChartData.ndxRiskOffOpenValues}
            startDateSp={forwardChartData.effectiveStartSp}
            startDateNq={forwardChartData.effectiveStartNq}
            endDate={endDate}
          />
        )}
      </div>
    </div>
  );
}

function formatCompactPercentTick(value: number): string {
  if (!Number.isFinite(value)) return "";
  if (Math.abs(value) >= 1000) {
    return `${(value / 1000).toFixed(1)}k%`;
  }
  return `${Math.round(value)}%`;
}

function percentile(sorted: number[], p: number): number {
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const w = idx - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

function StrategyDistributionCard({
  title,
  startDate,
  inflationPct,
  description,
  series,
  rows,
  bests,
  tradeAfterHours,
  smaLabel,
  nonSmaLabel,
  unleveragedLabel,
}: {
  title: string;
  startDate?: string | null;
  inflationPct?: number | null;
  description: string;
  series: StrategyDistributionSeries;
  rows: RankedDistributionSummaryRow[];
  bests: { p10?: string; p50?: string; avg?: string; p90?: string };
  tradeAfterHours: boolean;
  smaLabel: string;
  nonSmaLabel: string;
  unleveragedLabel: string;
}) {
  const chartData = useMemo(() => {
    const maxY = Math.max(
      1e-12,
      ...series.series.flatMap((item) => item.y)
    );
    const scaleY = (value: number) => (value / maxY) * DISTRIBUTION_PEAK_PERCENT;
    return {
      datasets: series.series.map((item) => ({
        label: formatStrategyLabelForDisplay(item.label, tradeAfterHours),
        data: series.x.map((x, i) => ({
          x,
          y: scaleY(item.y[i] ?? 0),
        })),
        borderColor: getStrategyColor(formatStrategyLabelForDisplay(item.label, tradeAfterHours)),
        borderWidth: item.borderWidth,
        pointRadius: 0,
        tension: 0,
        fill: false,
      })),
    };
  }, [series, tradeAfterHours]);

  const xBounds = useMemo(() => {
    const nonEmptyX = series.x.filter((_, i) =>
      series.series.some((item) => (item.y[i] ?? 0) > 0)
    );
    if (nonEmptyX.length === 0) return { min: 0, max: 60 };
    const min = nonEmptyX[0];
    const max = nonEmptyX[nonEmptyX.length - 1];
    if (Math.abs(max - min) < 1e-9) return { min: min - 1, max: max + 1 };
    return { min, max };
  }, [series]);

  const chartOptions = useMemo<ChartOptions<"line">>(() => {
    const chartColors = getChartThemeColors();
    const legendHoverIsolation = createLegendHoverIsolation();
    return {
      responsive: true,
      maintainAspectRatio: false,
      parsing: false as const,
      interaction: {
        mode: "index" as const,
        axis: "x" as const,
        intersect: false,
      },
      plugins: {
        legend: {
          labels: { color: chartColors.legendText },
          ...legendHoverIsolation,
        },
        tooltip: {
          mode: "index" as const,
          intersect: false,
          callbacks: {
            title: (items: TooltipItem<"line">[]) =>
              `${formatPercent(items[0]?.parsed.x ?? 0)} real CAGR`,
            label: (item: TooltipItem<"line">) =>
              `${item.dataset.label}: ${formatPercent(item.parsed.y ?? 0)} likelihood`,
          },
        },
      },
      scales: {
        x: {
          type: "linear" as const,
          min: xBounds.min,
          max: xBounds.max,
          ticks: {
            color: chartColors.tickText,
            callback: (v: number | string) => formatCompactPercentTick(Number(v)),
          },
          grid: { color: chartColors.grid },
        },
        y: {
          min: 0,
          max: DISTRIBUTION_PEAK_PERCENT,
          ticks: {
            color: chartColors.tickText,
            callback: (v: number | string) => `${Math.round(Number(v))}%`,
          },
          grid: { color: chartColors.grid },
        },
      },
    };
  }, [xBounds]);

  const bestBeatsSma = findBestLabelByValue(rows, (row) =>
    distributionCategoryForLabel(row.label) === "sma"
      ? Number.NEGATIVE_INFINITY
      : row.categoryWinRates.vsSma ?? Number.NEGATIVE_INFINITY
  );
  const bestBeatsNonSma = findBestLabelByValue(rows, (row) =>
    distributionCategoryForLabel(row.label) === "nonSma"
      ? Number.NEGATIVE_INFINITY
      : row.categoryWinRates.vsNonSma ?? Number.NEGATIVE_INFINITY
  );
  const bestBeatsUnleveraged = findBestLabelByValue(rows, (row) =>
    distributionCategoryForLabel(row.label) === "unleveraged"
      ? Number.NEGATIVE_INFINITY
      : row.categoryWinRates.vsUnleveraged ?? Number.NEGATIVE_INFINITY
  );
  const bestBeatsSgov = findBestLabelByValue(rows, (row) => row.categoryWinRates.vsSgov ?? Number.NEGATIVE_INFINITY);

  return (
    <Card>
      <div className="mb-3">
        <SectionTitleWithInflation title={title} startDate={startDate} inflationPct={inflationPct} />
      </div>
      <p className="text-xs text-muted mb-4">{description}</p>
      <div className="h-[320px] mb-4">
        <ZoomableChart data={chartData} options={chartOptions} />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-card-border text-left text-muted">
              <th className="py-2 pr-4 font-medium"></th>
              <th className="py-2 pr-4 text-right font-medium">10th Pctl Real CAGR</th>
              <th className="py-2 pr-4 text-right font-medium">Avg Real CAGR</th>
              <th className="py-2 pr-4 text-right font-medium">Median Real CAGR</th>
              <th className="py-2 pr-4 text-right font-medium">90th Pctl Real CAGR</th>
              <th className="hidden py-2 pr-4 text-right font-medium md:table-cell">Beats {smaLabel}</th>
              <th className="hidden py-2 pr-4 text-right font-medium md:table-cell">Beats {nonSmaLabel}</th>
              <th className="hidden py-2 pr-4 text-right font-medium md:table-cell">Beats {unleveragedLabel}</th>
              <th className="hidden py-2 pr-4 text-right font-medium md:table-cell">Beats SGOV</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label} className="border-b border-card-border/60 last:border-b-0">
                <td className="py-2 pr-4 text-muted">{formatStrategyLabelForDisplay(row.label, tradeAfterHours)}</td>
                <td className={`py-2 pr-4 text-right tabular-nums ${bests.p10 === row.label ? "font-medium text-foreground" : "font-light text-muted"}`}>
                  {formatPercent(row.p10)}
                </td>
                <td className={`py-2 pr-4 text-right tabular-nums ${bests.avg === row.label ? "font-medium text-foreground" : "font-light text-muted"}`}>
                  {formatPercent(row.avg)}
                </td>
                <td className={`py-2 pr-4 text-right tabular-nums ${bests.p50 === row.label ? "font-medium text-foreground" : "font-light text-muted"}`}>
                  {formatPercent(row.p50)}
                </td>
                <td className={`py-2 pr-4 text-right tabular-nums ${bests.p90 === row.label ? "font-medium text-foreground" : "font-light text-muted"}`}>
                  {formatPercent(row.p90)}
                </td>
                {([
                  ["vsSma", "sma"],
                  ["vsNonSma", "nonSma"],
                  ["vsUnleveraged", "unleveraged"],
                ] as const).map(([key, targetCategory]) => {
                  const currentValue = row.categoryWinRates[key] ?? 0;
                  const ownCategory = distributionCategoryForLabel(row.label);
                  if (ownCategory === targetCategory) {
                    return (
                      <td
                        key={key}
                        className={`hidden py-2 pr-4 text-right tabular-nums ${(
                          (key === "vsSma" && bestBeatsSma === row.label) ||
                          (key === "vsNonSma" && bestBeatsNonSma === row.label) ||
                          (key === "vsUnleveraged" && bestBeatsUnleveraged === row.label)
                        ) ? "font-semibold text-foreground" : "font-light text-muted"} md:table-cell`}
                      >
                        &mdash;
                      </td>
                    );
                  }
                  return (
                    <td
                      key={key}
                      className={`hidden py-2 pr-4 text-right tabular-nums ${(
                        (key === "vsSma" && bestBeatsSma === row.label) ||
                        (key === "vsNonSma" && bestBeatsNonSma === row.label) ||
                        (key === "vsUnleveraged" && bestBeatsUnleveraged === row.label)
                      ) ? "font-semibold text-foreground" : "font-light text-muted"} md:table-cell`}
                    >
                      {formatPercent(currentValue)}
                    </td>
                  );
                })}
                <td className={`hidden py-2 pr-4 text-right tabular-nums ${bestBeatsSgov === row.label ? "font-semibold text-foreground" : "font-light text-muted"} md:table-cell`}>
                  {formatPercent(row.categoryWinRates.vsSgov ?? 0)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-4 md:hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-muted">
            <thead>
              <tr className="border-b border-card-border text-left text-xs">
                <th className="font-medium pb-1" />
                <th className="font-medium pb-1 text-right px-1">Beats {smaLabel}</th>
                <th className="font-medium pb-1 text-right px-1">Beats {nonSmaLabel}</th>
                <th className="font-medium pb-1 text-right px-1">Beats {unleveragedLabel}</th>
                <th className="font-medium pb-1 text-right px-1">Beats SGOV</th>
              </tr>
            </thead>
            <tbody className="text-sm tabular-nums text-foreground">
              {rows.map((row, i) => (
                <tr
                  key={row.label}
                  className={i === rows.length - 1 ? "" : "border-b border-card-border/50"}
                >
                  <td
                    className="py-1.5 pr-2 text-muted truncate max-w-[100px]"
                    title={formatStrategyLabelForDisplay(row.label, tradeAfterHours)}
                  >
                    {formatStrategyLabelForDisplay(row.label, tradeAfterHours)}
                  </td>
                  {(
                    [
                      ["vsSma", "sma"],
                      ["vsNonSma", "nonSma"],
                      ["vsUnleveraged", "unleveraged"],
                    ] as const
                  ).map(([key, targetCategory]) => {
                    const currentValue = row.categoryWinRates[key] ?? 0;
                    const ownCategory = distributionCategoryForLabel(row.label);
                    if (ownCategory === targetCategory) {
                      return (
                        <td key={key} className={`py-1.5 text-right ${(
                          (key === "vsSma" && bestBeatsSma === row.label) ||
                          (key === "vsNonSma" && bestBeatsNonSma === row.label) ||
                          (key === "vsUnleveraged" && bestBeatsUnleveraged === row.label)
                        ) ? "font-semibold text-foreground" : "font-light text-muted"}`}>
                          &mdash;
                        </td>
                      );
                    }
                    return (
                      <td key={key} className={`py-1.5 text-right ${(
                        (key === "vsSma" && bestBeatsSma === row.label) ||
                        (key === "vsNonSma" && bestBeatsNonSma === row.label) ||
                        (key === "vsUnleveraged" && bestBeatsUnleveraged === row.label)
                      ) ? "font-semibold text-foreground" : "font-light text-muted"}`}>
                        {formatPercent(currentValue)}
                      </td>
                    );
                  })}
                  <td className={`py-1.5 text-right ${bestBeatsSgov === row.label ? "font-semibold text-foreground" : "font-light text-muted"}`}>
                    {formatPercent(row.categoryWinRates.vsSgov ?? 0)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Card>
  );
}

function computeSharedHistogramDistribution(
  inputSeries: Array<{
    key: string;
    label: string;
    color: string;
    values: number[];
    borderWidth: number;
  }>,
  requestedBins: number
): {
  x: number[];
  series: Array<{
    key: string;
    label: string;
    color: string;
    borderWidth: number;
    y: number[];
  }>;
} {
  const all = inputSeries.flatMap((series) => series.values).filter(Number.isFinite);
  if (all.length === 0) {
    return { x: [], series: [] };
  }

  const minValue = Math.min(...all);
  const maxValue = Math.max(...all);
  if (!Number.isFinite(minValue) || !Number.isFinite(maxValue)) {
    return { x: [], series: [] };
  }

  const bins = Math.max(20, Math.min(140, Math.round(requestedBins)));
  const span = Math.max(1e-9, maxValue - minValue);
  const binWidth = span / bins;
  const x = Array.from({ length: bins }, (_, i) => minValue + (i + 0.5) * binWidth);

  const toIndex = (value: number): number => {
    const normalized = Math.floor((value - minValue) / binWidth);
    return Math.max(0, Math.min(bins - 1, normalized));
  };

  const series = inputSeries.map((input) => {
    const counts = new Array<number>(bins).fill(0);
    let sampleCount = 0;
    for (const value of input.values) {
      if (!Number.isFinite(value)) continue;
      counts[toIndex(value)] += 1;
      sampleCount += 1;
    }
    const denominator = Math.max(1, sampleCount);
    return {
      key: input.key,
      label: input.label,
      color: input.color,
      borderWidth: input.borderWidth,
      y: counts.map((count) => count / denominator),
    };
  });

  return { x, series };
}
