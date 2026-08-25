"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isAbortError, throwIfAborted } from "@/lib/abort";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { SectionTitleWithInflation } from "@/components/tools/SectionTitleWithInflation";
import { SweepComparisonTable } from "@/components/tools/compare/SweepComparisonTable";
import { useHateDrawdown } from "@/components/tools/compare/HateDrawdownToggle";
import { SharedToolInputs } from "@/components/tools/SharedToolInputs";
import { RunSpinnerOverlay } from "@/components/ui/RunSpinnerOverlay";
import { CONSTANT_INITIAL_INVESTMENT, INDEX_DATE_RANGES, RISK_OFF_ASSET_OPTIONS, getRiskOffFetchTickers } from "@/lib/constants";
import { alignRiskOffPriceSeries, getMarketDataWarmUpStartDate, loadAllRiskOffPricePoints } from "@/lib/fetch-market-data";
import { formatMultiple, formatPercent } from "@/lib/format";
import { inflationPctForSweepSectionTitle } from "@/lib/inflation";
import { buildRiskOffVariantConfigs } from "@/lib/simulation/sweep-items";
import { ETF_PRESETS, PRESET_SELECT_OPTIONS, getComboEffectiveDateRange, getActivePreset, resolvePresetSelection } from "@/lib/simulation/presets";
import { DEFAULT_COMBO_PRESET } from "@/lib/simulation/presets";
import { useSearchSyncRunGuard } from "@/lib/hooks/use-search-sync-run-guard";
import { useMonotonicRunProgress } from "@/lib/hooks/use-monotonic-run-progress";
import { buildPresetBacktestUrl } from "@/lib/url-builders";
import type { PricePoint, RatePoint, SmaComparisonRow, IndexKey, RiskOffAsset } from "@/lib/simulation/types";
import { runParallelVariantSummaries } from "@/lib/simulation/parallel";
import { runCompareSweep } from "@/lib/compare-sweep-runner";
import { useToolSnapshot } from "@/lib/hooks/use-tool-snapshot";
import { useRefreshEndDateOnInitialVisit } from "@/lib/hooks/use-refresh-end-date";
import { getBestSweepRow, getSweepTradesPerYear } from "@/lib/sweep";
import { SimulationRunSummary } from "@/components/tools/SimulationRunSummary";
import type { RunSummary } from "@/lib/run-summary";
import { buildRunSummary } from "@/lib/run-summary";
import { useRunSummary, useRunDisplay } from "@/lib/hooks/use-run-summary-inputs";
import { useToolForm } from "@/lib/hooks/use-tool-form";
import { buildToolsUrl, shouldQueueToolAutorun } from "@/lib/tools-route";
import { recordSuccessfulToolRun } from "@/lib/tool-run-history";

type RiskOffComparisonRow = {
  riskOffAsset: RiskOffAsset;
  displayLabel: string;
  summary: SmaComparisonRow;
};

export default function CompareRiskOffAssetsPage() {
  return (
    <Suspense fallback={null}>
      <CompareRiskOffAssetsPageContent active />
    </Suspense>
  );
}

export function CompareRiskOffAssetsPageContent({
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

  const form = useToolForm("compare-riskoff-assets", {
    showBaseline: true,
    annualizedInflation: 0,
    monthlyCpi: [] as Array<{ date: string; value: number }>,
    rows: [] as RiskOffComparisonRow[],
    rows2: [] as RiskOffComparisonRow[],
    baseline: null as SmaComparisonRow | null,
    baseline2: null as SmaComparisonRow | null,
    runSummaryInputs: null as RunSummary | null,
  }, {
    persistKeys: ["showBaseline", "rows", "rows2", "baseline", "baseline2", "annualizedInflation", "monthlyCpi", "runSummaryInputs"],
  });

  const {
    letf, setLetf, index, setIndex, startDate, endDate, setEndDate,
    windowLength,
    smaSpPeriod, smaNqPeriod, smaSpUpperBuffer, smaSpLowerBuffer, smaNqUpperBuffer, smaNqLowerBuffer,
    riskOffAsset,
    isCombo, selectedPreset, comboSubs,
    handleFieldChange, getUrlParams, initial, save, restoredFromCache,
  } = form;

  const [annualizedInflation, setAnnualizedInflation] = useState(initial.annualizedInflation);
  const [monthlyCpi, setMonthlyCpi] = useState<Array<{ date: string; value: number }>>(initial.monthlyCpi);
  const [rows, setRows] = useState<RiskOffComparisonRow[]>(initial.rows);
  const [baseline, setBaseline] = useState<SmaComparisonRow | null>(initial.baseline);
  const [rows2, setRows2] = useState<RiskOffComparisonRow[]>(initial.rows2);
  const [baseline2, setBaseline2] = useState<SmaComparisonRow | null>(initial.baseline2);
  const {
    runSummary,
    setRunSummary,
    applyRunSummaryFromSnapshot,
  } = useRunSummary(initial.runSummaryInputs);
  const display = useRunDisplay(runSummary);
  const [loading, setLoading] = useState(false);
  const [pendingRun, setPendingRun] = useState(false);
  const [runProgress, setRunProgress] = useMonotonicRunProgress();
  const [error, setError] = useState<string | null>(null);
  const { hateDrawdown, toggle: hateDrawdownToggle } = useHateDrawdown();
  const abortControllerRef = useRef<AbortController | null>(null);
  const initializedRef = useRef(false);
  const skipNextPresetEffectRef = useRef(false);


  type CompareRiskOffSnapshotState = typeof initial;

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
      const snapshot = state as Partial<CompareRiskOffSnapshotState>;
      if (snapshot.rows) setRows(snapshot.rows as RiskOffComparisonRow[]);
      if (snapshot.baseline !== undefined) setBaseline(snapshot.baseline as SmaComparisonRow | null);
      if (snapshot.rows2) setRows2(snapshot.rows2 as RiskOffComparisonRow[]);
      if (snapshot.baseline2 !== undefined) setBaseline2(snapshot.baseline2 as SmaComparisonRow | null);
      if (snapshot.annualizedInflation != null) setAnnualizedInflation(snapshot.annualizedInflation as number);
      if (snapshot.monthlyCpi != null) setMonthlyCpi(snapshot.monthlyCpi as Array<{ date: string; value: number }>);
      applyRunSummaryFromSnapshot(snapshot);
      save(snapshot as CompareRiskOffSnapshotState);
    },
    [applyRunSummaryFromSnapshot, save]
  );

  const { clearMetadata } = useToolSnapshot({
    pageKey: "compare-riskoff-assets",
    shouldHydrate: shouldHydrateSnapshot,
    onSnapshot: applySnapshot,
    hasPersistedResults: (state) =>
      !!(state as Partial<CompareRiskOffSnapshotState>).runSummaryInputs ||
      ((state as Partial<CompareRiskOffSnapshotState>).rows?.length ?? 0) > 0,
  });

  const buildBacktestUrl = useCallback(
    (row: RiskOffComparisonRow, dates: { start: string; end: string }, subPresetIdx?: number) => {
      if (!display) return "#";
      const p = getActivePreset(display.selectedPreset, display.comboSubs, subPresetIdx);
      return buildPresetBacktestUrl({
        preset: p,
        startDate: dates.start,
        endDate: dates.end,
        smaPeriod: p.index === "nasdaq100" ? display.summary.smaNqPeriod : display.summary.smaSpPeriod,
        smaUpperBuffer: p.index === "nasdaq100" ? display.summary.smaNqUpperBuffer : display.summary.smaSpUpperBuffer, smaLowerBuffer: p.index === "nasdaq100" ? display.summary.smaNqLowerBuffer : display.summary.smaSpLowerBuffer,
        riskOffAsset: row.riskOffAsset,
      });
    },
    [display]
  );

  const riskOffLabelByAsset = useMemo(() => {
    const out = new Map<RiskOffAsset, string>();
    for (const opt of RISK_OFF_ASSET_OPTIONS) out.set(opt.value as RiskOffAsset, opt.label);
    return out;
  }, []);

  // Shared inputs are hydrated separately; re-apply page-specific URL params on client-side navigation.
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

  const dateRange = isCombo ? getComboEffectiveDateRange(letf) : INDEX_DATE_RANGES[index];
  // Allow start dates earlier than launch date, but warn users if data won't be available
  const effectiveMinDate = dateRange.min;


  const runRiskOffForPreset = useCallback(async (
    presetDef: { name: string; leverage: number; expenseRatio: number; simulated: boolean; index: IndexKey },
    prices: PricePoint[],
    rates: RatePoint[],
    riskOffSeries: {
      closeValuesByAsset: Partial<Record<RiskOffAsset, number[]>>;
      openValuesByAsset: Partial<Record<RiskOffAsset, number[]>>;
    },
    pctBase: number,
    pctSpan: number,
    cpiData?: Array<{ date: string; value: number }>,
  ) => {
    // Variants across every candidate risk-off asset + a no-SMA baseline last
    // (shared item builder).
    const variants = buildRiskOffVariantConfigs({
      preset: presetDef,
      baselineRiskOffAsset: riskOffAsset as RiskOffAsset,
      assets: RISK_OFF_ASSET_OPTIONS.map((opt) => opt.value as RiskOffAsset),
      smaPeriod: presetDef.index === "nasdaq100" ? smaNqPeriod : smaSpPeriod,
      upperBuffer: presetDef.index === "nasdaq100" ? smaNqUpperBuffer : smaSpUpperBuffer,
      lowerBuffer: presetDef.index === "nasdaq100" ? smaNqLowerBuffer : smaSpLowerBuffer,
    });

    const variantResults = await runParallelVariantSummaries({
      prices, rates,
      windowLength, startDate, endDate,
      variants,
      riskOffValuesByAsset: riskOffSeries.closeValuesByAsset,
      riskOffOpenValuesByAsset: riskOffSeries.openValuesByAsset,
      monthlyCpi: cpiData,
    });

    const baselineResult = variantResults.find(r => r.label === "baseline");
    const bl = baselineResult?.summary ?? null;

    const nextRows: RiskOffComparisonRow[] = variantResults
      .filter(r => r.label !== "baseline")
      .map(({ label, summary }) => {
        const asset = label as RiskOffAsset;
        return { riskOffAsset: asset, displayLabel: riskOffLabelByAsset.get(asset) ?? asset, summary };
      });

    return { rows: nextRows, baseline: bl };
  }, [riskOffAsset, smaNqPeriod, smaSpPeriod, smaNqUpperBuffer, smaNqLowerBuffer, smaSpUpperBuffer, smaSpLowerBuffer, windowLength, startDate, endDate, riskOffLabelByAsset]);

  const buildRiskoffUrlParams = useCallback(() => {
    const params = getUrlParams();
    params.delete("ro");
    return params;
  }, [getUrlParams]);

  const updateUrl = useCallback(() => {
    markNextSearchAsInternal();
    router.push(buildToolsUrl("riskoff", buildRiskoffUrlParams()));
  }, [buildRiskoffUrlParams, router, markNextSearchAsInternal]);

  const handleCancel = useCallback(() => {
    abortControllerRef.current?.abort();
    setLoading(false);
    setRunProgress(null);
  }, [setRunProgress]);

  const handleRun = useCallback(async () => {
    if (loading) return;
    setLoading(true);
    setRunProgress({ pct: 5, label: "Loading market data..." });
    setError(null);
    updateUrl();

    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const signal = controller.signal;

    try {
      const allTickers = Array.from(new Set(RISK_OFF_ASSET_OPTIONS.flatMap((opt) => getRiskOffFetchTickers(opt.value))));
      const rawRiskOffSeriesPromise = loadAllRiskOffPricePoints(allTickers, signal, ({ completed, total, label }) => {
        setRunProgress({ pct: 16 + (completed / total) * 4, label });
      }, {
        startDate: getMarketDataWarmUpStartDate(startDate, Math.max(smaSpPeriod, smaNqPeriod)),
        endDate,
      });
      const result = await runCompareSweep({
        comboSubs,
        selectedPreset,
        index,
        startDate,
        endDate,
        warmUpTradingDays: Math.max(smaSpPeriod, smaNqPeriod),
        onProgress: (pct, label) => setRunProgress({ pct, label }),
        loadRiskOffValues: async (_preset, prices) =>
          alignRiskOffPriceSeries(prices, await rawRiskOffSeriesPromise),
        runSweepForPreset: runRiskOffForPreset,
        signal,
      });
      throwIfAborted(signal);
      const { rows: computedRows, baseline: computedBaseline, rows2: computedRows2, baseline2: computedBaseline2, inflationData, inflationWarning } = result;
      setAnnualizedInflation(inflationData.annualizedInflation);
      setMonthlyCpi(inflationData.monthlyCpi);
      setRows(computedRows);
      setBaseline(computedBaseline);
      setRows2(computedRows2);
      setBaseline2(computedBaseline2);
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
      });
      setRunSummary(nextRunSummary);

      save({
        letf, index, startDate, endDate, windowLength,
        smaSpPeriod, smaNqPeriod, smaSpUpperBuffer, smaSpLowerBuffer, smaNqUpperBuffer, smaNqLowerBuffer, riskOffAsset, showBaseline: true,
        annualizedInflation: inflationData.annualizedInflation, monthlyCpi: inflationData.monthlyCpi,
        rows: computedRows,
        baseline: computedBaseline,
        rows2: computedRows2,
        baseline2: computedBaseline2,
        runSummaryInputs: nextRunSummary,
      });

      if (inflationWarning) setError("Inflation data unavailable — Real CAGR may be inaccurate.");
      setRunProgress({ pct: 100, label: "Done" });
      clearMetadata();
      if (computedRows.length > 0 || computedRows2.length > 0) {
        recordSuccessfulToolRun({
          tab: "riskoff",
          tabLabel: "SMA Risk-Off Assets",
          href: buildToolsUrl("riskoff", buildRiskoffUrlParams()),
          summary: nextRunSummary,
          summaryDisplay: { showRiskOffAsset: false },
        });
      }
    } catch (err) {
      if (isAbortError(err)) {
        return;
      }
      const message = err instanceof Error ? err.message : "Unexpected error";
      setError(message);
      setRows([]); setBaseline(null);
      setRows2([]); setBaseline2(null);
    } finally {
      if (abortControllerRef.current === controller) {
        setLoading(false);
        setRunProgress(null);
        abortControllerRef.current = null;
      }
    }
  }, [
    index, startDate, endDate, windowLength,
    smaSpPeriod, smaNqPeriod, smaSpUpperBuffer, smaSpLowerBuffer, smaNqUpperBuffer, smaNqLowerBuffer,
    letf, selectedPreset,
    save, updateUrl, clearMetadata,
    riskOffAsset, comboSubs, buildRiskoffUrlParams,
    loading, runRiskOffForPreset, setRunSummary, setRunProgress
  ]);

  // When monthlyCpi is provided, summarizeSmaRow returns real (inflation-adjusted) values,
  // so no further subtraction is needed. Fall back to global inflation only when CPI is unavailable.
  const inflPct = monthlyCpi.length >= 2 ? 0 : annualizedInflation * 100;

  const sweepRows = useMemo(() => rows.map((r, i) => ({ ...r.summary, parameterValue: i })), [rows]);
  const sweepRows2 = useMemo(() => rows2.map((r, i) => ({ ...r.summary, parameterValue: i })), [rows2]);
  const primaryDisplayStartDate = useMemo(
    () => sweepRows.find((row) => Boolean(row.earliestStartDate))?.earliestStartDate ?? baseline?.earliestStartDate,
    [sweepRows, baseline]
  );
  const secondaryDisplayStartDate = useMemo(
    () => sweepRows2.find((row) => Boolean(row.earliestStartDate))?.earliestStartDate ?? baseline2?.earliestStartDate,
    [sweepRows2, baseline2]
  );

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
    () => (display ? getBestSweepRow(sweepRows, inflPct, display.summary.windowLength) : null),
    [sweepRows, inflPct, display]
  );
  const bestRow2 = useMemo(
    () => (display ? getBestSweepRow(sweepRows2, inflPct, display.summary.windowLength) : null),
    [sweepRows2, inflPct, display]
  );
  const avgSweepAvgFinalRealValue = useMemo(
    () => (sweepRows.length === 0 ? 0 : sweepRows.reduce((sum, row) => sum + row.avgFinalRealValue, 0) / sweepRows.length),
    [sweepRows]
  );
  const avgSweepAvgFinalRealValue2 = useMemo(
    () => (sweepRows2.length === 0 ? 0 : sweepRows2.reduce((sum, row) => sum + row.avgFinalRealValue, 0) / sweepRows2.length),
    [sweepRows2]
  );
  const avgTradesPerYear = useMemo(
    () => getSweepTradesPerYear(sweepRows, display?.summary.windowLength),
    [sweepRows, display]
  );
  const avgTradesPerYear2 = useMemo(
    () => getSweepTradesPerYear(sweepRows2, display?.summary.windowLength),
    [sweepRows2, display]
  );
  const formatAsset = useCallback((row: SmaComparisonRow) => rows[row.parameterValue]?.displayLabel ?? "?", [rows]);
  const formatAsset2 = useCallback((row: SmaComparisonRow) => rows2[row.parameterValue]?.displayLabel ?? "?", [rows2]);
  const formatFinalValuePct = useCallback(
    (value: number) => formatMultiple(value / CONSTANT_INITIAL_INVESTMENT),
    []
  );

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
        <h1 className="text-3xl md:text-4xl font-bold">SMA Risk-Off Assets</h1>

        <SharedToolInputs
          values={{
            letf: letf as string, startDate, endDate, windowLength,
            smaSpPeriod, smaSpUpperBuffer, smaSpLowerBuffer, smaNqPeriod, smaNqUpperBuffer, smaNqLowerBuffer,
          }}
          onChange={handleFieldChange}
          dateRange={{ min: effectiveMinDate, max: dateRange.max }}
          presetOptions={PRESET_SELECT_OPTIONS}
          onRun={handleRun}
          onCancel={handleCancel}
          loading={loading}
          runLabel="Compare Assets"
          progress={runProgress}
          error={error}
        />

        {display && (
          <SimulationRunSummary summary={display.summary} showRiskOffAsset={false} />
        )}

        {display && bestRow && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <Card>
              <p className="text-xs text-muted mb-1">{display.comboLabels ? `${display.comboLabels[0]} Best Risk-Off Asset` : "Best Avg Real CAGR Risk-Off Asset"}</p>
              <p className="text-lg font-semibold">{formatAsset(bestRow)}</p>
            </Card>
            <Card>
              <p className="text-xs text-muted mb-1">{display.comboLabels ? `${display.comboLabels[0]} Best Avg Real CAGR` : "Best Avg Real CAGR"}</p>
              <p className="text-lg font-semibold text-positive">{formatPercent(bestRow.avgReturn - inflPct)}</p>
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
                  <p className="text-xs text-muted mb-1">{display.comboLabels[1]} Best Risk-Off Asset</p>
                  <p className="text-lg font-semibold">{formatAsset2(bestRow2)}</p>
                </Card>
                <Card>
                  <p className="text-xs text-muted mb-1">{display.comboLabels[1]} Best Avg Real CAGR</p>
                  <p className="text-lg font-semibold text-positive">{formatPercent(bestRow2.avgReturn - inflPct)}</p>
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
            {display.comboLabels && <h2 className="text-lg font-semibold">{display.comboLabels[0]}</h2>}
            <Card>
              <div className="mb-3 flex items-center justify-between gap-3 flex-wrap">
                <SectionTitleWithInflation className="text-lg font-semibold" title={display.comboLabels ? `${display.comboLabels[0]} — Performance by Risk-Off Asset` : "Performance by Risk-Off Asset"} startDate={primaryDisplayStartDate} inflationPct={primaryInflationPctForDisplay} avgTradesPerYear={avgTradesPerYear} />
                {hateDrawdownToggle}
              </div>
              <SweepComparisonTable
                resultTableTestId="snapshot-tool-sweep-0"
                rows={sweepRows}
                baseline={baseline}
                inflationPct={inflPct}
                windowYears={display.summary.windowLength}
                firstColumnLabel="Asset"
                formatFirstColumn={formatAsset}
                getBacktestUrl={(smaRow, dates) => buildBacktestUrl(rows[smaRow.parameterValue], dates, display.isCombo ? 0 : undefined)}
                startDate={display.summary.startDate}
                showStartDate={false}
                hateDrawdown={hateDrawdown}
                showAvgTrades={false}
              />
            </Card>
          </>
        )}

        {display && rows2.length > 0 && display.comboLabels && (
          <>
            <h2 className="text-lg font-semibold">{display.comboLabels[1]}</h2>
            <Card>
              <div className="mb-3 flex items-center justify-between gap-3 flex-wrap">
                <SectionTitleWithInflation className="text-lg font-semibold" title={`${display.comboLabels[1]} — Performance by Risk-Off Asset`} startDate={secondaryDisplayStartDate} inflationPct={secondaryInflationPctForDisplay} avgTradesPerYear={avgTradesPerYear2} />
              </div>
              <SweepComparisonTable
                resultTableTestId="snapshot-tool-sweep-1"
                rows={sweepRows2}
                baseline={baseline2}
                inflationPct={inflPct}
                windowYears={display.summary.windowLength}
                firstColumnLabel="Asset"
                formatFirstColumn={formatAsset2}
                getBacktestUrl={(smaRow, dates) => buildBacktestUrl(rows2[smaRow.parameterValue], dates, 1)}
                startDate={display.summary.startDate}
                showStartDate={false}
                hateDrawdown={hateDrawdown}
                showAvgTrades={false}
              />
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
