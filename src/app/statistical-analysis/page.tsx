"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ZoomableChart } from "@/components/ui/ZoomableChart";
import type { TooltipItem } from "chart.js";
import { Card } from "@/components/ui/Card";
import { SharedToolInputs } from "@/components/tools/SharedToolInputs";
import { RunSpinnerOverlay } from "@/components/ui/RunSpinnerOverlay";
import { SectionTitleWithInflation } from "@/components/tools/SectionTitleWithInflation";
import { createLegendHoverIsolation, getChartThemeColors } from "@/lib/chart-options";
import {
  CHART_COLORS,
  INDEX_DATE_RANGES,
  getRiskOffFetchTickers,
  LABEL_INDEX_NASDAQ100_TR,
  LABEL_INDEX_SP500_TR,
} from "@/lib/constants";
import { formatPercent } from "@/lib/format";
import { isAbortError, throwIfAborted } from "@/lib/abort";
import { getIsoDate } from "@/lib/date";
import { inflationPctForSweepSectionTitle } from "@/lib/inflation";
import {
  PRESET_SELECT_OPTIONS,
  getComboSubPresets,
  DEFAULT_COMBO_PRESET,
  resolvePresetSelection,
} from "@/lib/simulation/presets";
import { useSearchSyncRunGuard } from "@/lib/hooks/use-search-sync-run-guard";
import { useMonotonicRunProgress } from "@/lib/hooks/use-monotonic-run-progress";
import {
  alignRiskOffPriceSeries,
  fetchJsonCached,
  fetchMarketData,
  getMarketDataWarmUpStartDate,
  loadAllRiskOffPricePoints,
  MARKET_DATA_EARLIEST_START,
} from "@/lib/fetch-market-data";
import type {
  EtfConfig,
  PricePoint,
} from "@/lib/simulation/types";
import { useToolSnapshot } from "@/lib/hooks/use-tool-snapshot";
import { useRefreshEndDateOnInitialVisit } from "@/lib/hooks/use-refresh-end-date";
import { SimulationRunSummary } from "@/components/tools/SimulationRunSummary";
import type { RunSummary } from "@/lib/run-summary";
import { buildRunSummary } from "@/lib/run-summary";
import { useRunSummary, useRunDisplay } from "@/lib/hooks/use-run-summary-inputs";
import { useToolForm } from "@/lib/hooks/use-tool-form";
import { buildToolsUrl, shouldQueueToolAutorun } from "@/lib/tools-route";
import { recordSuccessfulToolRun } from "@/lib/tool-run-history";
import { computeWinRatesByWindowLength, type WinRatesByWindow } from "@/lib/simulation/win-rates";

export default function StatisticalAnalysisPage() {
  return (
    <Suspense fallback={null}>
      <StatisticalAnalysisPageContent active />
    </Suspense>
  );
}

export function StatisticalAnalysisPageContent({
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

  const form = useToolForm("statistical-analysis", {
    annualizedInflation: 0,
    monthlyCpi: [] as Array<{ date: string; value: number }>,
    runSummaryInputs: null as RunSummary | null,
    winRatesByWindow: null as WinRatesByWindow[] | null,
  }, {
    persistKeys: ["annualizedInflation", "monthlyCpi", "runSummaryInputs", "winRatesByWindow"],
  });

  const {
    letf, setLetf, index, setIndex, startDate, setStartDate, endDate, setEndDate,
    windowLength,
    smaSpPeriod, smaNqPeriod,
    smaSpUpperBuffer, smaSpLowerBuffer, smaNqUpperBuffer, smaNqLowerBuffer,
    riskOffAsset,
    isCombo, selectedPreset,
    handleFieldChange, getUrlParams, initial, save, restoredFromCache,
  } = form;

  const {
    runSummary,
    setRunSummary,
    applyRunSummaryFromSnapshot,
  } = useRunSummary(initial.runSummaryInputs as RunSummary | null);
  const display = useRunDisplay(runSummary);
  const [annualizedInflation, setAnnualizedInflation] = useState(initial.annualizedInflation);
  const [monthlyCpi, setMonthlyCpi] = useState<Array<{ date: string; value: number }>>(initial.monthlyCpi);
  const [winRatesByWindow, setWinRatesByWindow] = useState<WinRatesByWindow[] | null>(initial.winRatesByWindow);
  const [loading, setLoading] = useState(false);
  const [runProgress, setRunProgress] = useMonotonicRunProgress();
  const [error, setError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const initializedRef = useRef(false);
  const skipNextPresetEffectRef = useRef(false);

  const [pendingRun, setPendingRun] = useState(false);

  const dateRange = INDEX_DATE_RANGES[index];
  // Allow start dates earlier than launch date (synthetic pre-launch data is used)
  const effectiveMinDate = dateRange.min;
  type StatisticalSnapshotState = typeof initial;

  const hasCachedResults =
    !!runSummary ||
    (winRatesByWindow?.length ?? 0) > 0;
  const shouldHydrateSnapshot = !hasCachedResults && !restoredFromCache;

  useRefreshEndDateOnInitialVisit({
    active,
    hasCachedResults,
    shouldHydrateSnapshot,
    endDate,
    setEndDate,
  });

  const applyStatSnapshot = useCallback(
    (state: Record<string, unknown>) => {
      const snapshot = state as Partial<StatisticalSnapshotState>;

      if (snapshot.annualizedInflation != null) setAnnualizedInflation(snapshot.annualizedInflation as number);
      if (snapshot.monthlyCpi != null) setMonthlyCpi(snapshot.monthlyCpi as Array<{ date: string; value: number }>);
      applyRunSummaryFromSnapshot(snapshot);
      if (snapshot.winRatesByWindow !== undefined) setWinRatesByWindow(snapshot.winRatesByWindow as WinRatesByWindow[] | null);
      
      save(snapshot as StatisticalSnapshotState);
    },
    [applyRunSummaryFromSnapshot, save]
  );

  const { clearMetadata } = useToolSnapshot({
    pageKey: "statistical-analysis",
    shouldHydrate: shouldHydrateSnapshot,
    onSnapshot: applyStatSnapshot,
    hasPersistedResults: (state) =>
      !!(state as Partial<StatisticalSnapshotState>).runSummaryInputs ||
      ((state as Partial<StatisticalSnapshotState>).winRatesByWindow?.length ?? 0) > 0,
  });

  // Restore page-specific URL params on client-side navigation.
  useEffect(() => {
    if (!active) return;
    const params = new URLSearchParams(searchParams.toString());

    // Defer state updates to avoid cascading render warnings
    Promise.resolve().then(() => {
      const presetSelection = resolvePresetSelection(params.get("letf"), DEFAULT_COMBO_PRESET);
      if (presetSelection) {
        setLetf(presetSelection.key);
        if (!presetSelection.isCombo) {
          setIndex(presetSelection.preset.index);
          skipNextPresetEffectRef.current = true;
        }
      }
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
  }, [searchParams, pathname, shouldAutoRunFromSearch, active, suppressAutoRun, allowInitialSearchAutoRun, hasCachedResults, setLetf, setIndex]);

  useEffect(() => {
    const nextIndex = selectedPreset.index;
    setIndex(nextIndex);
    if (!initializedRef.current) {
      initializedRef.current = true;
      return;
    }
    if (skipNextPresetEffectRef.current) {
      skipNextPresetEffectRef.current = false;
      return;
    }
  }, [selectedPreset, setIndex]);

  const updateUrl = useCallback(() => {
    const params = getUrlParams();
    params.delete("py");
    markNextSearchAsInternal();
    router.replace(buildToolsUrl("statistics", params));
  }, [getUrlParams, router, markNextSearchAsInternal]);

  const handleCancel = useCallback(() => {
    abortControllerRef.current?.abort();
    setLoading(false);
    setRunProgress(null);
  }, [setRunProgress]);

  const handleRun = useCallback(async () => {
    if (loading) return;
    setLoading(true);
    setRunProgress({ pct: 5, label: "Saving settings..." });
    setError(null);
    updateUrl();

    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const signal = controller.signal;

    try {
      setRunProgress({ pct: 15, label: "Loading market data..." });
      const subs = isCombo ? getComboSubPresets(letf) : [selectedPreset];
      if (subs.length === 0) {
        throw new Error("No presets found for analysis");
      }

      const marketData = await fetchMarketData(
        [...new Set(subs.map((sub) => sub.index))],
        startDate,
        endDate,
        signal,
        ({ completed, total, label }) => {
          setRunProgress({ pct: 15 + (completed / total) * 10, label });
        },
        {
          allowMissingPrices: true,
          rateStartDate: MARKET_DATA_EARLIEST_START,
          warmUpTradingDays: Math.max(smaSpPeriod, smaNqPeriod),
        }
      );
      const { rates, pricesByIndex, inflationWarning } = marketData;
      const inflationData = {
        annualizedInflation: marketData.annualizedInflation,
        monthlyCpi: marketData.monthlyCpi,
      };
      setAnnualizedInflation(inflationData.annualizedInflation);
      setMonthlyCpi(inflationData.monthlyCpi);

      const rawRiskOffSeriesPromise = loadAllRiskOffPricePoints(
        getRiskOffFetchTickers(riskOffAsset),
        signal,
        ({ completed, total, label }) => {
          setRunProgress({ pct: 26 + (completed / total) * 8, label });
        },
        {
          startDate: getMarketDataWarmUpStartDate(startDate, Math.max(smaSpPeriod, smaNqPeriod)),
          endDate,
        }
      );
      const riskStartDate = getMarketDataWarmUpStartDate(startDate, Math.max(smaSpPeriod, smaNqPeriod));

      setRunProgress({ pct: 45, label: "Computing win rates by holding period..." });

      const sgovResponse = await fetchJsonCached<PricePoint[]>(
        `/api/risk-off-prices?asset=SGOV&startDate=${riskStartDate}&endDate=${endDate}`,
        signal,
      );
      const sgovPoints = sgovResponse.ok ? (sgovResponse.data ?? []) : [];

      const allWinRates: WinRatesByWindow[] = [];
      for (const sub of subs) {
        const prices = pricesByIndex[sub.index];
        if (!prices || prices.length === 0) continue;
        const riskSeries = alignRiskOffPriceSeries(prices, await rawRiskOffSeriesPromise);
        const smaConfig: EtfConfig = {
          id: `${sub.name}-wr-sma`,
          name: `${sub.name} SMA`,
          leverage: sub.leverage,
          expenseRatio: sub.expenseRatio,
          simulated: true,
          smaEnabled: true,
          smaPeriod: sub.index === "nasdaq100" ? smaNqPeriod : smaSpPeriod,
          smaUpperBuffer: sub.index === "nasdaq100" ? smaNqUpperBuffer : smaSpUpperBuffer, smaLowerBuffer: sub.index === "nasdaq100" ? smaNqLowerBuffer : smaSpLowerBuffer,
          smaIndex: sub.index,
          riskOffAsset,
        };
        const noSmaConfig: EtfConfig = { ...smaConfig, id: `${sub.name}-wr-nosma`, smaEnabled: false };
        const wr = await computeWinRatesByWindowLength({
          label: isCombo ? sub.name : letf,
          prices,
          rates,
          smaConfig,
          noSmaConfig,
          startDate,
          endDate,
          riskOffValuesByAsset: riskSeries.closeValuesByAsset,
          riskOffOpenValuesByAsset: riskSeries.openValuesByAsset,
          signal,
          sgovPoints,
          monthlyCpi: inflationData.monthlyCpi,
          onProgress: (year, total) => {
            const subIndex = subs.indexOf(sub);
            const subSpan = 50 / subs.length;
            const subBase = 45 + subIndex * subSpan;
            setRunProgress({
              pct: subBase + (year / total) * subSpan,
              label: `Win rates ${sub.name}: ${year}yr (${subIndex + 1}/${subs.length})...`,
            });
          },
        });
        allWinRates.push(wr);
      }

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
      // A run that was cancelled or superseded must not publish its results over
      // the run that replaced them — state, storage, and the URL are all written
      // from here down.
      throwIfAborted(signal);

      setRunSummary(nextRunSummary);
      setWinRatesByWindow(allWinRates.length > 0 ? allWinRates : null);

      const persistedState = {
        letf,
        index,
        startDate,
        endDate,
        windowLength,
        smaSpPeriod,
        smaNqPeriod,
        smaSpUpperBuffer, smaSpLowerBuffer, smaNqUpperBuffer, smaNqLowerBuffer,
        riskOffAsset,
        annualizedInflation: inflationData.annualizedInflation,
        monthlyCpi: inflationData.monthlyCpi,
        runSummaryInputs: nextRunSummary,
        winRatesByWindow: allWinRates.length > 0 ? allWinRates : null,
      } satisfies StatisticalSnapshotState;

      save(persistedState);

      if (allWinRates.length === 0) {
        setError("Not enough data for the selected period.");
      } else if (inflationWarning) {
        setError("Inflation data unavailable — Real CAGR may be inaccurate.");
      }

      setRunProgress({ pct: 100, label: "Done" });
      clearMetadata();
      if (allWinRates.length > 0) {
        const params = getUrlParams();
        params.delete("py");
        const href = buildToolsUrl("statistics", params);
        markNextSearchAsInternal();
        router.push(href);
        recordSuccessfulToolRun({
          tab: "statistics",
          tabLabel: "Holding Period",
          href,
          summary: nextRunSummary,
        });
      }
    } catch (err) {
      if (isAbortError(err)) {
        return;
      }
      const message = err instanceof Error ? err.message : "Unexpected error";
      setError(message);
      setWinRatesByWindow(null);
    } finally {
      if (abortControllerRef.current === controller) {
        setLoading(false);
        setRunProgress(null);
        abortControllerRef.current = null;
      }
    }
  }, [
    clearMetadata,
    endDate,
    getUrlParams,
    index,
    isCombo,
    loading,
    markNextSearchAsInternal,
    windowLength,
    letf,
    riskOffAsset,
    router,
    save,
    setMonthlyCpi,
    setRunSummary,
    setWinRatesByWindow,
    selectedPreset,
    smaNqUpperBuffer, smaNqLowerBuffer,
    smaNqPeriod,
    smaSpUpperBuffer, smaSpLowerBuffer,
    smaSpPeriod,
    startDate,
    updateUrl,
    setRunProgress,
  ]);

  // Auto-run when page opened with URL params
  useEffect(() => {
    if (pendingRun && initializedRef.current && !loading) {
      // Defer state update to avoid cascading render lint error
      Promise.resolve().then(() => {
        setPendingRun(false);
        handleRun();
      });
    }
  }, [pendingRun, loading, handleRun]);

  return (
    <>
      <RunSpinnerOverlay active={loading} label={runProgress?.label} pct={runProgress?.pct} />
      <div className="min-h-screen bg-background text-foreground p-3 md:p-6">
      <div className="max-w-7xl mx-auto space-y-4 md:space-y-6">
        <h1 className="text-3xl md:text-4xl font-bold">Holding Period</h1>

        <SharedToolInputs
          values={{
            letf, startDate, endDate, windowLength,
            smaSpPeriod, smaSpUpperBuffer, smaSpLowerBuffer, smaNqPeriod, smaNqUpperBuffer, smaNqLowerBuffer, riskOffAsset,
          }}
          onChange={handleFieldChange}
          showRollingFields={false}
          dateRange={{ min: effectiveMinDate, max: dateRange.max }}
          presetOptions={PRESET_SELECT_OPTIONS}
          onEndDateChange={(value) => {
            const nextEnd = clampDate(value, dateRange.min, dateRange.max);
            setEndDate(nextEnd);
            setStartDate(clampDate(startDate, dateRange.min, nextEnd));
          }}
          onEndDateToday={() => {
            const today = getIsoDate(new Date());
            setEndDate(today);
            setStartDate(clampDate(startDate, dateRange.min, today));
          }}
          onRun={handleRun}
          onCancel={handleCancel}
          loading={loading}
          runLabel="Run Statistical Analysis"
          progress={runProgress}
          error={error}
        />

        {display && (
          <SimulationRunSummary
            summary={display.summary}
            showWindow={false}
          />
        )}

        {display && winRatesByWindow && winRatesByWindow.length > 0 && (
          winRatesByWindow.map((section, idx) => (
            <StatWinRateCard
              key={section.label}
              section={section}
              multipleSections={winRatesByWindow.length > 1}
              inflationPct={inflationPctForSweepSectionTitle({
                monthlyCpi,
                sectionDisplayStartDate: section.earliestStartDate,
                fallbackStartDate: display.summary.startDate,
                cpiEndDate: display.summary.endDate,
                annualizedInflation,
              })}
              startDate={section.earliestStartDate}
              color={idx === 0 ? CHART_COLORS.etf[0] : CHART_COLORS.etf[1] ?? CHART_COLORS.etf[0]}
            />
          ))
        )}

      </div>
    </div>
    </>
  );
}

function WinRateSummaryTable({
  sections,
  multipleSections,
}: {
  sections: WinRatesByWindow[];
  multipleSections: boolean;
}) {
  const sectionOrder = new Map(sections.map((section, idx) => [section.label, idx]));
  const rows = sections.flatMap((section) =>
    (section.summaryRows ?? []).map((row) => {
      let label = row.label;
      if (multipleSections) {
        if (row.label === "No SMA") {
          label = section.label;
        } else if (row.label === "SMA") {
          label = `${section.label} SMA`;
        } else if (row.label !== LABEL_INDEX_SP500_TR && row.label !== LABEL_INDEX_NASDAQ100_TR) {
          label = `${section.label} ${row.label}`;
        }
      }
      return {
        ...row,
        label,
        sectionKey: section.label,
        sortGroup: row.label === "SMA" ? 0 : row.label === "No SMA" ? 1 : 2,
      };
    })
  );
  if (rows.length === 0) return null;
  const bestP10 = findBestLabelByValue(rows, (row) => row.p10);
  const bestAvg = findBestLabelByValue(rows, (row) => row.avg);
  const bestP50 = findBestLabelByValue(rows, (row) => row.p50);
  const bestP90 = findBestLabelByValue(rows, (row) => row.p90);
  const sortedRows = [...rows].sort((a, b) =>
    (sectionOrder.get(a.sectionKey) ?? Number.MAX_SAFE_INTEGER) - (sectionOrder.get(b.sectionKey) ?? Number.MAX_SAFE_INTEGER) ||
    a.sortGroup - b.sortGroup ||
    b.avg - a.avg ||
    b.p50 - a.p50 ||
    b.p10 - a.p10 ||
    b.p90 - a.p90 ||
    a.label.localeCompare(b.label)
  );

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" data-testid="snapshot-tool-sweep-winrates">
        <thead>
          <tr className="border-b border-card-border text-left text-muted">
            <th className="py-2 pr-4 font-medium"></th>
            <th className="py-2 pr-4 text-right font-medium">10th Pctl Real CAGR</th>
            <th className="py-2 pr-4 text-right font-medium">Avg Real CAGR</th>
            <th className="py-2 pr-4 text-right font-medium">Median Real CAGR</th>
            <th className="py-2 pr-4 text-right font-medium">90th Pctl Real CAGR</th>
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((row) => (
            <tr key={row.label} className="border-b border-card-border/60 last:border-b-0">
              <td className="py-2 pr-4 text-muted">{row.label}</td>
              <td className={`py-2 pr-4 text-right tabular-nums ${bestP10 === row.label ? "font-medium text-foreground" : "font-light text-muted"}`}>
                {formatPercent(row.p10)}
              </td>
              <td className={`py-2 pr-4 text-right tabular-nums ${bestAvg === row.label ? "font-medium text-foreground" : "font-light text-muted"}`}>
                {formatPercent(row.avg)}
              </td>
              <td className={`py-2 pr-4 text-right tabular-nums ${bestP50 === row.label ? "font-medium text-foreground" : "font-light text-muted"}`}>
                {formatPercent(row.p50)}
              </td>
              <td className={`py-2 pr-4 text-right tabular-nums ${bestP90 === row.label ? "font-medium text-foreground" : "font-light text-muted"}`}>
                {formatPercent(row.p90)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatWinRateCard({
  section,
  multipleSections,
  inflationPct,
  startDate,
  color,
}: {
  section: WinRatesByWindow;
  multipleSections: boolean;
  inflationPct: number | null;
  startDate?: string;
  color: string;
}) {
  const isSp500 = section.summaryRows?.some((row) => row.label === LABEL_INDEX_SP500_TR || row.label === "SPX");
  const isNasdaq = section.summaryRows?.some((row) => row.label === LABEL_INDEX_NASDAQ100_TR || row.label === "NDX");

  const familyTitle = isSp500
    ? "SMA Outperforming Chances · SPX Family"
    : isNasdaq
      ? "SMA Outperforming Chances · NDX Family"
      : "SMA Outperforming Chances";
      
  const nonSmaLabel = isSp500 ? "UPRO" : isNasdaq ? "TQQQ" : "non-SMA";
  const unleveragedLabel = isSp500 ? LABEL_INDEX_SP500_TR : isNasdaq ? LABEL_INDEX_NASDAQ100_TR : "Index";

  const bgAlpha = color === CHART_COLORS.etf[0] ? "rgba(22,243,206,0.1)" : "rgba(239,68,68,0.1)";
  const chartColors = getChartThemeColors();
  const legendHoverIsolation = createLegendHoverIsolation();

  return (
    <Card>
      <div className="mb-3">
        <SectionTitleWithInflation title={familyTitle} startDate={startDate} inflationPct={inflationPct} />
      </div>
      <ZoomableChart
        data={{
          labels: section.years,
          datasets: [
            {
              label: `Beats ${nonSmaLabel}`,
              data: section.beatsNonSma,
              borderColor: color,
              backgroundColor: bgAlpha,
              borderWidth: 1.5,
              pointRadius: 3,
              tension: 0.3,
              borderDash: [],
            },
            {
              label: `Beats ${unleveragedLabel}`,
              data: section.beatsIndex,
              borderColor: color,
              backgroundColor: bgAlpha,
              borderWidth: 1.5,
              pointRadius: 3,
              tension: 0.3,
              borderDash: [6, 3],
            },
            {
              label: "Beats SGOV",
              data: section.beatsSgov,
              borderColor: color,
              backgroundColor: bgAlpha,
              borderWidth: 1.5,
              pointRadius: 3,
              tension: 0.3,
              borderDash: [2, 2],
            },
          ],
        }}
        options={{
          interaction: { mode: "index" as const, intersect: false },
          scales: {
            x: {
              type: "linear" as const,
              title: { display: true, text: "Holding Period (Years)", color: chartColors.axisTitleText },
              min: 0,
              max: 30,
              ticks: {
                color: chartColors.tickText,
                callback: (value) => Number(value).toString(),
              },
              grid: { color: chartColors.grid },
            },
            y: {
              title: { display: true, text: "Avg Win Rate (%)", color: chartColors.axisTitleText },
              min: 30,
              max: 100,
              ticks: { color: chartColors.tickText },
              grid: { color: chartColors.grid },
            },
          },
          plugins: {
            legend: {
              ...legendHoverIsolation,
            },
            tooltip: {
              callbacks: {
                title: (items: TooltipItem<"line">[]) => `${items[0]?.label ?? ""} Years`,
                label: (item: TooltipItem<"line">) => `${item.dataset.label}: ${(item.raw as number).toFixed(1)}%`,
              },
            },
          },
        }}
        plugins={[
          {
            id: "referenceHoldingPeriods",
            afterDraw(chart) {
              const xScale = chart.scales["x"];
              const ctx = chart.ctx;
              const yScale = chart.scales["y"];
              if (!xScale || !yScale) return;
              for (const year of [5, 10, 15, 20, 25]) {
                const xPixel = xScale.getPixelForValue(year);
                if (xPixel < xScale.left || xPixel > xScale.right) continue;
                ctx.save();
                ctx.strokeStyle = chartColors.emphasisGrid;
                ctx.lineWidth = 1.25;
                ctx.setLineDash([4, 4]);
                ctx.beginPath();
                ctx.moveTo(xPixel, yScale.top);
                ctx.lineTo(xPixel, yScale.bottom);
                ctx.stroke();
                ctx.fillStyle = chartColors.emphasisText;
                ctx.font = "11px sans-serif";
                ctx.textAlign = "center";
                ctx.fillText(`${year}Y`, xPixel, yScale.top - 6);
                ctx.restore();
              }
            },
          },
        ]}
      />
      <div className="mt-4">
        <WinRateSummaryTable
          sections={[section]}
          multipleSections={multipleSections}
        />
      </div>
    </Card>
  );
}

function clampDate(value: string, min: string, max: string): string {
  if (value < min) return min;
  if (value > max) return max;
  return value;
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
