"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { TooltipItem } from "chart.js";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { ComparisonLineChart } from "@/components/tools/compare/ComparisonLineChart";
import { SectionTitleWithInflation } from "@/components/tools/SectionTitleWithInflation";
import { SharedToolInputs } from "@/components/tools/SharedToolInputs";
import { RunSpinnerOverlay } from "@/components/ui/RunSpinnerOverlay";
import { SweepComparisonTable } from "@/components/tools/compare/SweepComparisonTable";
import { useHateDrawdown } from "@/components/tools/compare/HateDrawdownToggle";
import { CONSTANT_INITIAL_INVESTMENT, INDEX_DATE_RANGES, getRiskOffFetchTickers } from "@/lib/constants";
import { alignRiskOffPriceSeries, getMarketDataWarmUpStartDate, loadAllRiskOffPricePoints } from "@/lib/fetch-market-data";
import { formatMultiple, formatPercent } from "@/lib/format";
import { inflationPctForSweepSectionTitle } from "@/lib/inflation";
import { getDefaultSmaPeriod } from "@/lib/simulation/defaults";
import {
  DEFAULT_COMBO_PRESET,
  ETF_PRESETS,
  PRESET_SELECT_OPTIONS,
  getComboEffectiveDateRange,
  getActivePreset,
  resolvePresetSelection,
} from "@/lib/simulation/presets";
import { useSearchSyncRunGuard } from "@/lib/hooks/use-search-sync-run-guard";
import { useMonotonicRunProgress } from "@/lib/hooks/use-monotonic-run-progress";
import { runParallelSimulations } from "@/lib/simulation/parallel";
import type {
  EtfConfig,
  IndexKey,
  PricePoint,
  RatePoint,
  RiskOffAsset,
  SmaComparisonRow,
} from "@/lib/simulation/types";
import { buildPresetBacktestUrl } from "@/lib/url-builders";
import { createSweepChartOptions, getBestSweepRow, getSweepTradesPerYear, sortSweepRowsByPeriod } from "@/lib/sweep";
import { runCompareSweep } from "@/lib/compare-sweep-runner";
import { SimulationRunSummary } from "@/components/tools/SimulationRunSummary";
import type { RunSummary } from "@/lib/run-summary";
import { buildRunSummary } from "@/lib/run-summary";
import { useRunSummary, useRunDisplay } from "@/lib/hooks/use-run-summary-inputs";
import { useToolSnapshot } from "@/lib/hooks/use-tool-snapshot";
import { useRefreshEndDateOnInitialVisit } from "@/lib/hooks/use-refresh-end-date";
import { getSweepDisplayStartDate } from "@/lib/tool-page-helpers";
import { useToolForm } from "@/lib/hooks/use-tool-form";
import { buildToolsUrl, shouldQueueToolAutorun } from "@/lib/tools-route";
import { recordSuccessfulToolRun } from "@/lib/tool-run-history";
import { parsePositiveIntegerOrFallback } from "@/lib/utils";

export default function CompareSmaStrategiesPage() {
  return (
    <Suspense fallback={null}>
      <CompareSmaStrategiesPageContent active />
    </Suspense>
  );
}

export function CompareSmaStrategiesPageContent({
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

  const form = useToolForm("compare-sma", {
    minSmaPeriod: 20,
    maxSmaPeriod: 280,
    stepSize: 5,
    showBaseline: true,
    annualizedInflation: 0,
    monthlyCpi: [] as Array<{ date: string; value: number }>,
    rows: [] as SmaComparisonRow[],
    rows2: [] as SmaComparisonRow[],
    baseline: null as SmaComparisonRow | null,
    baseline2: null as SmaComparisonRow | null,
    runSummaryInputs: null as RunSummary | null,
  }, {
    persistKeys: ["minSmaPeriod", "maxSmaPeriod", "stepSize", "showBaseline", "rows", "rows2", "baseline", "baseline2", "annualizedInflation", "monthlyCpi", "runSummaryInputs"],
  });

  const {
    letf, setLetf, index, setIndex, startDate, endDate, setEndDate,
    windowLength,
    smaSpPeriod, smaNqPeriod, smaSpUpperBuffer, smaSpLowerBuffer, smaNqUpperBuffer, smaNqLowerBuffer, riskOffAsset,
    isCombo, selectedPreset, comboSubs,
    handleFieldChange, getUrlParams, initial, save, restoredFromCache,
  } = form;

  const [minSmaPeriod, setMinSmaPeriod] = useState(initial.minSmaPeriod as number);
  const [maxSmaPeriod, setMaxSmaPeriod] = useState(initial.maxSmaPeriod as number);
  const [stepSize, setStepSize] = useState(initial.stepSize as number);
  const [annualizedInflation, setAnnualizedInflation] = useState(initial.annualizedInflation);
  const [monthlyCpi, setMonthlyCpi] = useState<Array<{ date: string; value: number }>>(initial.monthlyCpi);
  const [rows, setRows] = useState<SmaComparisonRow[]>(initial.rows);
  const [baseline, setBaseline] = useState<SmaComparisonRow | null>(initial.baseline);
  const [rows2, setRows2] = useState<SmaComparisonRow[]>(initial.rows2);
  const [baseline2, setBaseline2] = useState<SmaComparisonRow | null>(initial.baseline2);
  const {
    runSummary,
    setRunSummary,
    applyRunSummaryFromSnapshot,
  } = useRunSummary(initial.runSummaryInputs as RunSummary | null);
  const display = useRunDisplay(runSummary);
  const [loading, setLoading] = useState(false);
  const [pendingRun, setPendingRun] = useState(false);
  const [runProgress, setRunProgress] = useMonotonicRunProgress();
  const [error, setError] = useState<string | null>(null);
  const { hateDrawdown, toggle: hateDrawdownToggle } = useHateDrawdown();
  const abortControllerRef = useRef<AbortController | null>(null);
  const initializedRef = useRef(false);
  const skipNextPresetEffectRef = useRef(false);


  type CompareSmaSnapshotState = typeof initial;

  const hasCachedResults =
    rows.length > 0 || rows2.length > 0 || baseline !== null || baseline2 !== null;

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
      const snapshot = state as Partial<CompareSmaSnapshotState>;
      if (snapshot.minSmaPeriod) setMinSmaPeriod(snapshot.minSmaPeriod as number);
      if (snapshot.maxSmaPeriod) setMaxSmaPeriod(snapshot.maxSmaPeriod as number);
      if (snapshot.stepSize) setStepSize(snapshot.stepSize as number);
      if (snapshot.rows) setRows(snapshot.rows as SmaComparisonRow[]);
      if (snapshot.baseline !== undefined) setBaseline(snapshot.baseline as SmaComparisonRow | null);
      if (snapshot.rows2) setRows2(snapshot.rows2 as SmaComparisonRow[]);
      if (snapshot.baseline2 !== undefined) setBaseline2(snapshot.baseline2 as SmaComparisonRow | null);
      if (snapshot.annualizedInflation != null) setAnnualizedInflation(snapshot.annualizedInflation as number);
      if (snapshot.monthlyCpi != null) setMonthlyCpi(snapshot.monthlyCpi as Array<{ date: string; value: number }>);
      applyRunSummaryFromSnapshot(snapshot);
      save(snapshot as CompareSmaSnapshotState);
    },
    [applyRunSummaryFromSnapshot, save]
  );

  const { clearMetadata } = useToolSnapshot({
    pageKey: "compare-sma",
    shouldHydrate: shouldHydrateSnapshot,
    onSnapshot: applySnapshot,
    hasPersistedResults: (state) =>
      !!(state as Partial<CompareSmaSnapshotState>).runSummaryInputs ||
      ((state as Partial<CompareSmaSnapshotState>).rows?.length ?? 0) > 0,
  });

  // Re-apply page-specific URL params on client-side navigation.
  useEffect(() => {
    if (!active) return;
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
      const presetSelection = resolvePresetSelection(params.get("letf"), DEFAULT_COMBO_PRESET);
      if (presetSelection) {
        setLetf(presetSelection.key as keyof typeof ETF_PRESETS);
        if (!presetSelection.isCombo) {
          setIndex(presetSelection.preset.index);
          skipNextPresetEffectRef.current = true;
        }
      }
      // Page-specific params
      const minP = params.get("minP");
      const maxP = params.get("maxP");
      const step = params.get("step");
      if (minP) setMinSmaPeriod(parsePositiveIntegerOrFallback(minP, 20));
      if (maxP) setMaxSmaPeriod(parsePositiveIntegerOrFallback(maxP, 300));
      if (step) setStepSize(parsePositiveIntegerOrFallback(step, 5));
    });
  }, [searchParams, pathname, shouldAutoRunFromSearch, active, suppressAutoRun, allowInitialSearchAutoRun, hasCachedResults, setLetf, setIndex]);

  useEffect(() => {
    if (!initializedRef.current) {
      initializedRef.current = true;
      return;
    }
    if (skipNextPresetEffectRef.current) {
      skipNextPresetEffectRef.current = false;
      if (!isCombo) {
        setIndex(selectedPreset.index);
      }
      return;
    }
    if (isCombo) {
    } else {
      setIndex(selectedPreset.index);
    }
  }, [selectedPreset, isCombo, letf, setIndex]);

  const dateRange = isCombo
    ? getComboEffectiveDateRange(letf)
    : INDEX_DATE_RANGES[index];
  // Allow start dates earlier than launch date, but warn users if data won't be available
  const effectiveMinDate = dateRange.min;

  const buildBacktestUrl = useCallback(
    (row: SmaComparisonRow, dates: { start: string; end: string }, subPresetIdx?: number) => {
      if (!display) return "#";
      const p = getActivePreset(display.selectedPreset, display.comboSubs, subPresetIdx);
      return buildPresetBacktestUrl({
        preset: p,
        startDate: dates.start,
        endDate: dates.end,
        smaPeriod: row.parameterValue,
        smaUpperBuffer: p.index === "nasdaq100" ? display.summary.smaNqUpperBuffer : display.summary.smaSpUpperBuffer, smaLowerBuffer: p.index === "nasdaq100" ? display.summary.smaNqLowerBuffer : display.summary.smaSpLowerBuffer,
        riskOffAsset: display.summary.riskOffAsset as RiskOffAsset,
      });
    },
    [display]
  );

  // When monthlyCpi is provided, summarizeSmaRow returns real (inflation-adjusted) values,
  // so no further subtraction is needed. Fall back to global inflation only when CPI is unavailable.
  const inflPct = monthlyCpi.length >= 2 ? 0 : annualizedInflation * 100;
  const primaryDisplayStartDate = useMemo(() => getSweepDisplayStartDate(rows, baseline), [rows, baseline]);
  const secondaryDisplayStartDate = useMemo(() => getSweepDisplayStartDate(rows2, baseline2), [rows2, baseline2]);
  const primaryInflationPctForDisplay = useMemo(
    () =>
      display
        ? inflationPctForSweepSectionTitle({
            monthlyCpi,
            sectionDisplayStartDate: primaryDisplayStartDate,
            fallbackStartDate: display.summary.startDate,
            cpiEndDate: display.summary.endDate,
            annualizedInflation,
          })
        : 0,
    [display, monthlyCpi, primaryDisplayStartDate, annualizedInflation]
  );
  const secondaryInflationPctForDisplay = useMemo(
    () =>
      display
        ? inflationPctForSweepSectionTitle({
            monthlyCpi,
            sectionDisplayStartDate: secondaryDisplayStartDate,
            fallbackStartDate: display.summary.startDate,
            cpiEndDate: display.summary.endDate,
            annualizedInflation,
          })
        : 0,
    [display, monthlyCpi, secondaryDisplayStartDate, annualizedInflation]
  );
  const bestRow = useMemo(
    () => (display ? getBestSweepRow(rows, inflPct, display.summary.windowLength) : null),
    [display, rows, inflPct]
  );
  const bestRow2 = useMemo(
    () => (display ? getBestSweepRow(rows2, inflPct, display.summary.windowLength) : null),
    [display, rows2, inflPct]
  );
  const avgSweepAvgFinalRealValue = useMemo(
    () => (rows.length === 0 ? 0 : rows.reduce((sum, row) => sum + row.avgFinalRealValue, 0) / rows.length),
    [rows]
  );
  const avgSweepAvgFinalRealValue2 = useMemo(
    () => (rows2.length === 0 ? 0 : rows2.reduce((sum, row) => sum + row.avgFinalRealValue, 0) / rows2.length),
    [rows2]
  );

  const avgTradesPerYear = useMemo(
    () => getSweepTradesPerYear(rows, display?.summary.windowLength),
    [rows, display]
  );

  const avgTradesPerYear2 = useMemo(
    () => getSweepTradesPerYear(rows2, display?.summary.windowLength),
    [rows2, display]
  );

  const chartRows = useMemo(
    () => sortSweepRowsByPeriod(rows),
    [rows]
  );
  const chartRows2 = useMemo(
    () => sortSweepRowsByPeriod(rows2),
    [rows2]
  );

  const chartOptions = useMemo(
    () =>
      createSweepChartOptions({
        title: (items: TooltipItem<"line">[]) => `SMA ${Math.round(items[0]?.parsed.x ?? 0)} days`,
        xTick: (value: number | string) => Number(value),
        xMin: minSmaPeriod,
        xMax: maxSmaPeriod,
      }),
    [minSmaPeriod, maxSmaPeriod]
  );

  const runSweepForPreset = useCallback(async (
    presetDef: { name: string; leverage: number; expenseRatio: number; simulated: boolean; index: IndexKey },
    prices: PricePoint[],
    rates: RatePoint[],
    riskOffSeries: {
      closeValuesByAsset: Partial<Record<EtfConfig["riskOffAsset"], number[]>>;
      openValuesByAsset: Partial<Record<EtfConfig["riskOffAsset"], number[]>>;
    },
    pctBase: number,
    pctSpan: number,
    cpiData?: Array<{ date: string; value: number }>,
    signal?: AbortSignal,
  ) => {
    // Include baseline in the sweep items
    const blConfig: EtfConfig = {
      id: "baseline", name: `${presetDef.name} (No SMA)`,
      leverage: presetDef.leverage, expenseRatio: presetDef.expenseRatio, simulated: true,
      smaEnabled: false, smaPeriod: getDefaultSmaPeriod(presetDef.index), smaUpperBuffer: 0, smaLowerBuffer: 0,
      smaIndex: presetDef.index, riskOffAsset,
    };

    const items: Array<{ paramValue: number; config: EtfConfig }> = [
      { paramValue: 0, config: blConfig },  // Baseline first
    ];

    for (let sma = minSmaPeriod; sma <= maxSmaPeriod; sma += stepSize) {
      items.push({
        paramValue: sma,
        config: {
          id: `sma-${sma}`,
          name: `${presetDef.name} SMA ${sma}`,
          leverage: presetDef.leverage,
          expenseRatio: presetDef.expenseRatio,
          simulated: presetDef.simulated,
          smaEnabled: true,
          smaPeriod: sma,
          smaUpperBuffer: presetDef.index === "nasdaq100" ? smaNqUpperBuffer : smaSpUpperBuffer, smaLowerBuffer: presetDef.index === "nasdaq100" ? smaNqLowerBuffer : smaSpLowerBuffer,
          smaIndex: presetDef.index,
          riskOffAsset,
        },
      });
    }
    const allSweepRows = await runParallelSimulations({
      prices, rates,
      windowLength, startDate, endDate,
      configs: items.map(i => i.config),
      riskOffValuesByAsset: riskOffSeries.closeValuesByAsset,
      riskOffOpenValuesByAsset: riskOffSeries.openValuesByAsset,
      monthlyCpi: cpiData,
      mode: 'sweep',
      signal,
      onProgress: (fraction, label) =>
        setRunProgress({
          pct: pctBase + fraction * pctSpan,
          label: label ?? "Running simulations...",
        }),
    }) as SmaComparisonRow[];

    // Extract baseline (first item) and sweep rows (rest)
    const bl = allSweepRows.length > 0 ? allSweepRows[0] : null;
    const sweepRows = allSweepRows.slice(1);

    return { rows: sweepRows, baseline: bl };
  }, [riskOffAsset, smaNqUpperBuffer, smaNqLowerBuffer, smaSpUpperBuffer, smaSpLowerBuffer, minSmaPeriod, maxSmaPeriod, stepSize, windowLength, startDate, endDate, setRunProgress]);

  const buildSmaPeriodUrlParams = useCallback(() => {
    const params = getUrlParams();
    params.delete("smaPsp");
    params.delete("smaPnq");
    params.set("minP", String(minSmaPeriod));
    params.set("maxP", String(maxSmaPeriod));
    params.set("step", String(stepSize));
    return params;
  }, [getUrlParams, minSmaPeriod, maxSmaPeriod, stepSize]);

  const updateUrl = useCallback(() => {
    markNextSearchAsInternal();
    router.push(buildToolsUrl("sma-period", buildSmaPeriodUrlParams()));
  }, [buildSmaPeriodUrlParams, router, markNextSearchAsInternal]);

  const formatFinalValuePct = useCallback(
    (value: number) => formatMultiple(value / CONSTANT_INITIAL_INVESTMENT),
    []
  );

  const handleCancel = useCallback(() => {
    abortControllerRef.current?.abort();
    setLoading(false);
    setRunProgress(null);
  }, [setRunProgress]);

  const handleRun = useCallback(async () => {
    setLoading(true);
    setRunProgress({ pct: 5, label: "Loading market data..." });
    setError(null);
    updateUrl();

    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const signal = controller.signal;

    try {
      const rawRiskOffSeriesPromise = loadAllRiskOffPricePoints(
        getRiskOffFetchTickers(riskOffAsset),
        signal,
        ({ completed, total, label }) => {
          setRunProgress({ pct: 16 + (completed / total) * 4, label });
        },
        { startDate: getMarketDataWarmUpStartDate(startDate, maxSmaPeriod), endDate }
      );
      const result = await runCompareSweep({
        comboSubs,
        selectedPreset,
        index,
        startDate,
        endDate,
        warmUpTradingDays: maxSmaPeriod,
        onProgress: (pct, label) => setRunProgress({ pct, label }),
        loadRiskOffValues: async (_preset, prices) =>
          alignRiskOffPriceSeries(prices, await rawRiskOffSeriesPromise),
        runSweepForPreset: runSweepForPreset,
        signal,
      });
      if (signal.aborted) throw new Error("Aborted");

      const { rows: computedRows, baseline: computedBaseline, rows2: computedRows2, baseline2: computedBaseline2, inflationData, inflationWarning } = result;
      setAnnualizedInflation(inflationData.annualizedInflation);
      setMonthlyCpi(inflationData.monthlyCpi);
      setRows(computedRows);
      setBaseline(computedBaseline);
      setRows2(computedRows2);
      setBaseline2(computedBaseline2);

      if (comboSubs ? computedRows.length === 0 && computedRows2.length === 0 : computedRows.length === 0) {
        setError("No valid simulations for this range and SMA configuration.");
      }
      const nextRunSummary = buildRunSummary({
        startDate,
        endDate,
        windowLength,
        smaSpPeriod,
        smaNqPeriod,
        smaSpUpperBuffer, smaSpLowerBuffer, smaNqUpperBuffer, smaNqLowerBuffer,
        letf,
        riskOffAsset,
      });
      setRunSummary(nextRunSummary);

      save({
        letf, index, startDate, endDate, windowLength,
        minSmaPeriod, maxSmaPeriod, stepSize, smaSpPeriod: form.smaSpPeriod, smaNqPeriod: form.smaNqPeriod,
        smaSpUpperBuffer, smaSpLowerBuffer, smaNqUpperBuffer, smaNqLowerBuffer, riskOffAsset,
        showBaseline: true, annualizedInflation: inflationData.annualizedInflation, monthlyCpi: inflationData.monthlyCpi,
        rows: computedRows,
        baseline: computedBaseline,
        rows2: computedRows2,
        baseline2: computedBaseline2,
        runSummaryInputs: nextRunSummary,
      });

      if (inflationWarning) {
        setError("Inflation data unavailable — Real CAGR may be inaccurate.");
      }
      clearMetadata();
      setRunProgress({ pct: 100, label: "Done" });
      if (computedRows.length > 0 || computedRows2.length > 0) {
        recordSuccessfulToolRun({
          tab: "sma-period",
          tabLabel: "SMA Period",
          href: buildToolsUrl("sma-period", buildSmaPeriodUrlParams()),
          summary: nextRunSummary,
        });
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return;
      }
      const message = err instanceof Error ? err.message : "Unexpected error";
      setError(message);
      setRows([]);
      setBaseline(null);
      setRows2([]);
      setBaseline2(null);
    } finally {
      if (abortControllerRef.current === controller) {
        setLoading(false);
        setRunProgress(null);
        abortControllerRef.current = null;
      }
    }
  }, [startDate, endDate, windowLength, smaSpPeriod, smaNqPeriod, smaSpUpperBuffer, smaSpLowerBuffer, smaNqUpperBuffer, smaNqLowerBuffer, riskOffAsset, letf, index, comboSubs, selectedPreset, buildSmaPeriodUrlParams, runSweepForPreset, setRunSummary, save, clearMetadata, form.smaSpPeriod, form.smaNqPeriod, minSmaPeriod, maxSmaPeriod, stepSize, updateUrl, setRunProgress]);

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

  return (
    <div className="min-h-screen bg-background text-foreground p-3 md:p-6">
      <RunSpinnerOverlay active={loading} label={runProgress?.label} pct={runProgress?.pct} />
      <div className="max-w-7xl mx-auto space-y-4 md:space-y-6">
        <h1 className="text-3xl md:text-4xl font-bold">SMA Period</h1>

        <SharedToolInputs
          values={{
            letf, startDate, endDate, windowLength,
            smaSpUpperBuffer, smaSpLowerBuffer, smaNqUpperBuffer, smaNqLowerBuffer, riskOffAsset,
          }}
          onChange={handleFieldChange}
          dateRange={{ min: effectiveMinDate, max: dateRange.max }}
          presetOptions={PRESET_SELECT_OPTIONS}
          onRun={handleRun}
          onCancel={handleCancel}
          loading={loading}
          runLabel="Compare SMA Strategies"
          progress={runProgress}
          error={error}
        >
          <Input
            label="Min SMA Period"
            suffix="days"
            type="number"
            min={5}
            max={500}
            value={minSmaPeriod}
            onChange={(e) => setMinSmaPeriod(parsePositiveIntegerOrFallback(e.currentTarget.value, minSmaPeriod))}
          />
          <Input
            label="Max SMA Period"
            suffix="days"
            type="number"
            min={10}
            max={700}
            value={maxSmaPeriod}
            onChange={(e) => setMaxSmaPeriod(parsePositiveIntegerOrFallback(e.currentTarget.value, maxSmaPeriod))}
          />
          <Input
            label="Period Step Size"
            suffix="days"
            info="The gap between each SMA period tested. e.g. a step of 5 between 50 and 200 tests 50, 55, 60, …, 200. Smaller steps try more periods but take longer to run."
            type="number"
            min={1}
            max={100}
            value={stepSize}
            onChange={(e) => setStepSize(parsePositiveIntegerOrFallback(e.currentTarget.value, stepSize))}
          />
        </SharedToolInputs>

        {display && rows.length > 0 && (
          <SimulationRunSummary summary={display.summary} />
        )}

        {display && bestRow && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <Card>
              <p className="text-xs text-muted mb-1">{display.comboLabels ? `${display.comboLabels[0]} Best Period` : "Best Avg Real CAGR Period"}</p>
              <p className="text-lg font-semibold">{bestRow.parameterValue} days</p>
            </Card>
            <Card>
              <p className="text-xs text-muted mb-1">{display.comboLabels ? `${display.comboLabels[0]} Best Avg Real CAGR` : "Best Avg Real CAGR"}</p>
              <p className="text-lg font-semibold text-positive">{formatPercent((bestRow.avgReturn - inflPct))}</p>
            </Card>
            <Card>
              <p className="text-xs text-muted mb-1">{display.comboLabels ? `${display.comboLabels[0]} Best Avg Real End Value` : "Best Avg Real End Value"}</p>
              <p className="text-lg font-semibold text-value-accent">{formatFinalValuePct(bestRow.avgFinalRealValue)}</p>
            </Card>
            <Card>
              <p className="text-xs text-muted mb-1">{display.comboLabels ? `${display.comboLabels[0]} Avg Avg Real End Value` : "Avg Avg Real End Value Across Sweep"}</p>
              <p className="text-lg font-semibold text-value-accent">{formatFinalValuePct(avgSweepAvgFinalRealValue)}</p>
            </Card>
            {bestRow2 && display.comboLabels && (
              <>
                <Card>
                  <p className="text-xs text-muted mb-1">{display.comboLabels[1]} Best Period</p>
                  <p className="text-lg font-semibold">{bestRow2.parameterValue} days</p>
                </Card>
                <Card>
                  <p className="text-xs text-muted mb-1">{display.comboLabels[1]} Best Avg Real CAGR</p>
                  <p className="text-lg font-semibold text-positive">{formatPercent((bestRow2.avgReturn - inflPct))}</p>
                </Card>
                <Card>
                  <p className="text-xs text-muted mb-1">{display.comboLabels[1]} Best Avg Real End Value</p>
                  <p className="text-lg font-semibold text-value-accent">{formatFinalValuePct(bestRow2.avgFinalRealValue)}</p>
                </Card>
                <Card>
                  <p className="text-xs text-muted mb-1">{display.comboLabels[1]} Avg Avg Real End Value</p>
                  <p className="text-lg font-semibold text-value-accent">{formatFinalValuePct(avgSweepAvgFinalRealValue2)}</p>
                </Card>
              </>
            )}
          </div>
        )}

        {display && rows.length > 0 && (
          <>
            <Card>
              <h2 className="text-lg font-semibold mb-2">Performance Across SMA Periods</h2>
              <p className="text-xs text-muted mb-4">
                These charts compare SMA-period performance against the non-SMA baseline
                (horizontal lines). Charts are unsmoothed to preserve real variation.
              </p>
              <p className="text-xs text-muted mb-4">
                Beware of overfitting: robust strategies should not collapse from small parameter
                changes.
              </p>
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                <ComparisonLineChart
                  title="Average Real CAGR"
                  rows={chartRows}
                  baseline={baseline}
                  chartOptions={chartOptions}
                  series={[
                    { label: `${display.comboLabels?.[0] ?? ""} Avg Real CAGR`.trim(), metric: (r) => (r.avgReturn - inflPct), color: "#16f3ce" },
                    ...(chartRows2.length > 0 ? [
                      { label: `${display.comboLabels?.[1] ?? ""} Avg Real CAGR`.trim(), metric: (r: SmaComparisonRow) => (r.avgReturn - inflPct), color: "#f97316", rows: chartRows2, borderDash: [6, 3] },
                    ] : []),
                  ]}
                  baselineSeries={[
                    { label: `${display.comboLabels?.[0] ?? ""} Baseline Avg`.trim(), metric: (b) => (b.avgReturn - inflPct), color: "#16f3ce" },
                    ...(baseline2 ? [{ label: `${display.comboLabels?.[1] ?? ""} Baseline Avg`.trim(), metric: (b: SmaComparisonRow) => (b.avgReturn - inflPct), color: "#f97316", rows: [baseline2], borderDash: [6, 4] }] : []),
                  ]}
                />
                <ComparisonLineChart
                  title="Best Real CAGR"
                  rows={chartRows}
                  baseline={baseline}
                  chartOptions={chartOptions}
                  series={[
                    { label: `${display.comboLabels?.[0] ?? ""} Best Real CAGR`.trim(), metric: (r) => (r.bestReturn - inflPct), color: "#00FA9A" },
                    ...(chartRows2.length > 0 ? [{ label: `${display.comboLabels?.[1] ?? ""} Best Real CAGR`.trim(), metric: (r: SmaComparisonRow) => (r.bestReturn - inflPct), color: "#a855f7", rows: chartRows2, borderDash: [6, 3] }] : []),
                  ]}
                  baselineSeries={[
                    { label: `${display.comboLabels?.[0] ?? ""} Baseline Best`.trim(), metric: (b) => (b.bestReturn - inflPct), color: "#00FA9A" },
                    ...(baseline2 ? [{ label: `${display.comboLabels?.[1] ?? ""} Baseline Best`.trim(), metric: (b: SmaComparisonRow) => (b.bestReturn - inflPct), color: "#a855f7", rows: [baseline2], borderDash: [6, 4] }] : []),
                  ]}
                />
                <ComparisonLineChart
                  title="Worst Real CAGR"
                  rows={chartRows}
                  baseline={baseline}
                  chartOptions={chartOptions}
                  series={[
                    { label: `${display.comboLabels?.[0] ?? ""} Worst Real CAGR`.trim(), metric: (r) => (r.worstReturn - inflPct), color: "#ef4444" },
                    ...(chartRows2.length > 0 ? [{ label: `${display.comboLabels?.[1] ?? ""} Worst Real CAGR`.trim(), metric: (r: SmaComparisonRow) => (r.worstReturn - inflPct), color: "#a855f7", rows: chartRows2, borderDash: [6, 3] }] : []),
                  ]}
                  baselineSeries={[
                    { label: `${display.comboLabels?.[0] ?? ""} Baseline Worst`.trim(), metric: (b) => (b.worstReturn - inflPct), color: "#ef4444" },
                    ...(baseline2 ? [{ label: `${display.comboLabels?.[1] ?? ""} Baseline Worst`.trim(), metric: (b: SmaComparisonRow) => (b.worstReturn - inflPct), color: "#a855f7", rows: [baseline2], borderDash: [6, 4] }] : []),
                  ]}
                />
                <ComparisonLineChart
                  title="Maximum Drawdowns"
                  rows={chartRows}
                  baseline={baseline}
                  chartOptions={chartOptions}
                  series={[
                    { label: `${display.comboLabels?.[0] ?? ""} Avg Max Drawdown`.trim(), metric: (r) => r.avgMaxDrawdown, color: "#eab308" },
                    { label: `${display.comboLabels?.[0] ?? ""} Biggest Max Drawdown`.trim(), metric: (r) => r.biggestMaxDrawdown, color: "#f97316" },
                    ...(chartRows2.length > 0 ? [
                      { label: `${display.comboLabels?.[1] ?? ""} Avg Max Drawdown`.trim(), metric: (r: SmaComparisonRow) => r.avgMaxDrawdown, color: "#a855f7", rows: chartRows2, borderDash: [6, 3] },
                      { label: `${display.comboLabels?.[1] ?? ""} Biggest Max Drawdown`.trim(), metric: (r: SmaComparisonRow) => r.biggestMaxDrawdown, color: "#ec4899", rows: chartRows2, borderDash: [6, 3] },
                    ] : []),
                  ]}
                  baselineSeries={[
                    { label: `${display.comboLabels?.[0] ?? ""} Baseline Avg Drawdown`.trim(), metric: (b) => b.avgMaxDrawdown, color: "#eab308" },
                    ...(baseline2 ? [{ label: `${display.comboLabels?.[1] ?? ""} Baseline Avg Drawdown`.trim(), metric: (b: SmaComparisonRow) => b.avgMaxDrawdown, color: "#a855f7", rows: [baseline2], borderDash: [6, 4] }] : []),
                  ]}
                />
              </div>
            </Card>
            {display.comboLabels && rows2.length > 0 ? (
              <>
                <Card>
                  <div className="mb-3 flex items-center justify-between gap-3 flex-wrap">
                    <SectionTitleWithInflation className="text-lg font-semibold" title={`${display.comboLabels[0]} — SMA Period Comparison`} startDate={primaryDisplayStartDate} inflationPct={primaryInflationPctForDisplay} avgTradesPerYear={avgTradesPerYear} />
                    {hateDrawdownToggle}
                  </div>
                  <SweepComparisonTable resultTableTestId="snapshot-tool-sweep-0" rows={rows} inflationPct={inflPct} windowYears={display.summary.windowLength} firstColumnLabel="SMA" formatFirstColumn={(r) => String(r.parameterValue)} getBacktestUrl={(row, dates) => buildBacktestUrl(row, dates, 0)} baseline={baseline} startDate={display.summary.startDate} showStartDate={false} hateDrawdown={hateDrawdown} showAvgTrades={avgTradesPerYear === undefined} />
                </Card>
                <Card>
                  <div className="mb-3 flex items-center justify-between gap-3 flex-wrap">
                    <SectionTitleWithInflation className="text-lg font-semibold" title={`${display.comboLabels[1]} — SMA Period Comparison`} startDate={secondaryDisplayStartDate} inflationPct={secondaryInflationPctForDisplay} avgTradesPerYear={avgTradesPerYear2} />
                  </div>
                  <SweepComparisonTable resultTableTestId="snapshot-tool-sweep-1" rows={rows2} inflationPct={inflPct} windowYears={display.summary.windowLength} firstColumnLabel="SMA" formatFirstColumn={(r) => String(r.parameterValue)} getBacktestUrl={(row, dates) => buildBacktestUrl(row, dates, 1)} baseline={baseline2} startDate={display.summary.startDate} showStartDate={false} hateDrawdown={hateDrawdown} showAvgTrades={avgTradesPerYear2 === undefined} />
                </Card>
              </>
            ) : (
              <Card>
                <div className="mb-3 flex items-center justify-between gap-3 flex-wrap">
                  <SectionTitleWithInflation className="text-lg font-semibold" title="SMA Period Comparison" startDate={primaryDisplayStartDate} inflationPct={primaryInflationPctForDisplay} avgTradesPerYear={avgTradesPerYear} />
                  {hateDrawdownToggle}
                </div>
                <SweepComparisonTable resultTableTestId="snapshot-tool-sweep-main" rows={rows} inflationPct={inflPct} windowYears={display.summary.windowLength} firstColumnLabel="SMA" formatFirstColumn={(r) => String(r.parameterValue)} getBacktestUrl={buildBacktestUrl} baseline={baseline} startDate={display.summary.startDate} showStartDate={false} hateDrawdown={hateDrawdown} showAvgTrades={avgTradesPerYear === undefined} />
              </Card>
            )}
          </>
        )}

      </div>
    </div>
  );
}
