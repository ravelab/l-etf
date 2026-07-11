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
import { parseNumberOrKeep } from "@/lib/utils";
import { getDefaultSmaPeriod } from "@/lib/simulation/defaults";
import { ETF_PRESETS, PRESET_SELECT_OPTIONS, getComboEffectiveDateRange, getActivePreset, resolvePresetSelection } from "@/lib/simulation/presets";
import { DEFAULT_COMBO_PRESET } from "@/lib/simulation/presets";
import { useSearchSyncRunGuard } from "@/lib/hooks/use-search-sync-run-guard";
import { useMonotonicRunProgress } from "@/lib/hooks/use-monotonic-run-progress";
import { buildPresetBacktestUrl } from "@/lib/url-builders";
import { runParallelSimulations } from "@/lib/simulation/parallel";
import {
  planCoarseGrid,
  planFineGrid,
  dedupePoints,
  pickTopCell,
  type AsymmetricSweepRow,
  type BufferPoint,
  type ObjectiveKey,
} from "@/lib/simulation/buffer-grid-search";
import { BufferHeatmap } from "@/components/tools/BufferHeatmap";
import type {
  EtfConfig,
  IndexKey,
  PricePoint,
  RatePoint,
  RiskOffAsset,
  SmaComparisonRow,
} from "@/lib/simulation/types";
import { createSweepChartOptions, getBestSweepRow, getSweepTradesPerYear, sortSweepRowsByPeriod } from "@/lib/sweep";
import { runCompareSweep } from "@/lib/compare-sweep-runner";
import type { EtfPreset } from "@/lib/simulation/presets";
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

export default function CompareBufferStrategiesPage() {
  return (
    <Suspense fallback={null}>
      <CompareBufferStrategiesPageContent active />
    </Suspense>
  );
}

export function CompareBufferStrategiesPageContent({
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

  const form = useToolForm("compare-threshold", {
    minBuffer: 0,
    maxBuffer: 21,
    fineStep: 0.5,
    coarseStep: 2,
    fineHalfWidth: 1.5,
    showBaseline: true,
    annualizedInflation: 0,
    monthlyCpi: [] as Array<{ date: string; value: number }>,
    rows: [] as SmaComparisonRow[],
    rows2: [] as SmaComparisonRow[],
    baseline: null as SmaComparisonRow | null,
    baseline2: null as SmaComparisonRow | null,
    asymRows: [] as AsymmetricSweepRow[],
    asymRows2: [] as AsymmetricSweepRow[],
    asymFineWindow: null as { minU: number; maxU: number; minL: number; maxL: number } | null,
    asymFineWindow2: null as { minU: number; maxU: number; minL: number; maxL: number } | null,
    runSummaryInputs: null as RunSummary | null,
  }, {
    persistKeys: ["minBuffer", "maxBuffer", "fineStep", "coarseStep", "fineHalfWidth", "showBaseline", "rows", "rows2", "baseline", "baseline2", "asymRows", "asymRows2", "asymFineWindow", "asymFineWindow2", "annualizedInflation", "monthlyCpi", "runSummaryInputs"],
  });

  const {
    letf, setLetf, index, setIndex, startDate, endDate, setEndDate,
    windowLength,
    smaSpPeriod, setSmaSpPeriod, smaSpUpperBuffer, smaSpLowerBuffer, smaNqPeriod, setSmaNqPeriod, smaNqUpperBuffer, smaNqLowerBuffer, riskOffAsset,
    isCombo, selectedPreset, comboSubs,
    handleFieldChange, getUrlParams, initial, save, restoredFromCache,
  } = form;

  const [minBuffer, setMinBuffer] = useState(initial.minBuffer as number);
  const [maxBuffer, setMaxBuffer] = useState(initial.maxBuffer as number);
  const [fineStep, setFineStep] = useState(initial.fineStep as number);
  const [coarseStep, setCoarseStep] = useState(initial.coarseStep as number);
  const [fineHalfWidth, setFineHalfWidth] = useState(initial.fineHalfWidth as number);
  const [annualizedInflation, setAnnualizedInflation] = useState(initial.annualizedInflation);
  const [monthlyCpi, setMonthlyCpi] = useState<Array<{ date: string; value: number }>>(initial.monthlyCpi);
  const [rows, setRows] = useState<SmaComparisonRow[]>(initial.rows);
  const [baseline, setBaseline] = useState<SmaComparisonRow | null>(initial.baseline);
  const [rows2, setRows2] = useState<SmaComparisonRow[]>(initial.rows2);
  const [baseline2, setBaseline2] = useState<SmaComparisonRow | null>(initial.baseline2);
  const [asymRows, setAsymRows] = useState<AsymmetricSweepRow[]>(initial.asymRows);
  const [asymRows2, setAsymRows2] = useState<AsymmetricSweepRow[]>(initial.asymRows2);
  const [asymFineWindow, setAsymFineWindow] = useState<{ minU: number; maxU: number; minL: number; maxL: number } | null>(initial.asymFineWindow);
  const [asymFineWindow2, setAsymFineWindow2] = useState<{ minU: number; maxU: number; minL: number; maxL: number } | null>(initial.asymFineWindow2);
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
  // Cross-stage hand-off: handleRun pre-plans coarse asym points per preset and
  // runBufferSweepForPreset appends them to its config batch so the worker pool
  // sees symmetric + coarse asym as one job (one round of precomputeAllConfigDailyValues
  // instead of two). After the batch returns, runBufferSweepForPreset writes the
  // asym coarse rows + the per-preset sim context (prices/rates/risk-off/cpi) into
  // the refs below, and handleRun reads them to dispatch the fine stage per preset.
  type AsymContext = {
    prices: PricePoint[];
    rates: RatePoint[];
    riskOffSeries: {
      closeValuesByAsset: Partial<Record<EtfConfig["riskOffAsset"], number[]>>;
      openValuesByAsset: Partial<Record<EtfConfig["riskOffAsset"], number[]>>;
    };
    monthlyCpi: Array<{ date: string; value: number }> | undefined;
    coarsePoints: BufferPoint[];
  };
  const asymCoarsePointsByPresetRef = useRef<Map<string, BufferPoint[]>>(new Map());
  const asymCoarseRowsByPresetRef = useRef<Map<string, AsymmetricSweepRow[]>>(new Map());
  const asymContextByPresetRef = useRef<Map<string, AsymContext>>(new Map());


  type CompareThresholdSnapshotState = typeof initial;

  const hasCachedResults =
    rows.length > 0 ||
    rows2.length > 0 ||
    baseline !== null ||
    baseline2 !== null;

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
      const snapshot = state as Partial<CompareThresholdSnapshotState>;
      if (snapshot.minBuffer != null) setMinBuffer(snapshot.minBuffer as number);
      if (snapshot.maxBuffer != null) setMaxBuffer(snapshot.maxBuffer as number);
      if (snapshot.fineStep) setFineStep(snapshot.fineStep as number);
      if (snapshot.coarseStep) setCoarseStep(snapshot.coarseStep as number);
      if (snapshot.fineHalfWidth) setFineHalfWidth(snapshot.fineHalfWidth as number);
      if (snapshot.asymRows) setAsymRows(snapshot.asymRows as AsymmetricSweepRow[]);
      if (snapshot.asymRows2) setAsymRows2(snapshot.asymRows2 as AsymmetricSweepRow[]);
      if (snapshot.asymFineWindow !== undefined) setAsymFineWindow(snapshot.asymFineWindow);
      if (snapshot.asymFineWindow2 !== undefined) setAsymFineWindow2(snapshot.asymFineWindow2);
      if (snapshot.rows) setRows(snapshot.rows as SmaComparisonRow[]);
      if (snapshot.baseline !== undefined) setBaseline(snapshot.baseline as SmaComparisonRow | null);
      if (snapshot.rows2) setRows2(snapshot.rows2 as SmaComparisonRow[]);
      if (snapshot.baseline2 !== undefined) setBaseline2(snapshot.baseline2 as SmaComparisonRow | null);
      if (snapshot.annualizedInflation != null) setAnnualizedInflation(snapshot.annualizedInflation as number);
      if (snapshot.monthlyCpi != null) setMonthlyCpi(snapshot.monthlyCpi as Array<{ date: string; value: number }>);
      applyRunSummaryFromSnapshot(snapshot);
      save(snapshot as CompareThresholdSnapshotState);
    },
    [applyRunSummaryFromSnapshot, save]
  );

  const { clearMetadata } = useToolSnapshot({
    pageKey: "compare-threshold",
    shouldHydrate: shouldHydrateSnapshot,
    onSnapshot: applySnapshot,
    hasPersistedResults: (state) =>
      !!(state as Partial<CompareThresholdSnapshotState>).runSummaryInputs ||
      ((state as Partial<CompareThresholdSnapshotState>).rows?.length ?? 0) > 0,
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
      const smaPsp = params.get("smaPsp");
      const smaPnq = params.get("smaPnq");
      const minT = params.get("minT");
      const maxT = params.get("maxT");
      const step = params.get("stepT");
      const cstep = params.get("cstepT");
      const hw = params.get("hwT");
      if (smaPsp) setSmaSpPeriod(parseNumberOrKeep(smaPsp, getDefaultSmaPeriod("sp500")));
      if (smaPnq) setSmaNqPeriod(parseNumberOrKeep(smaPnq, getDefaultSmaPeriod("nasdaq100")));
      if (minT) setMinBuffer(parseNumberOrKeep(minT, 0));
      if (maxT) setMaxBuffer(parseNumberOrKeep(maxT, 21));
      if (step) setFineStep(parseNumberOrKeep(step, 0.5));
      if (cstep) setCoarseStep(parseNumberOrKeep(cstep, 2));
      if (hw) setFineHalfWidth(parseNumberOrKeep(hw, 1.5));
    });
  }, [searchParams, pathname, shouldAutoRunFromSearch, active, suppressAutoRun, allowInitialSearchAutoRun, hasCachedResults, setLetf, setIndex, setSmaSpPeriod, setSmaNqPeriod]);

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

  const buildBacktestUrl = useCallback(
    (row: SmaComparisonRow, dates: { start: string; end: string }, subPresetIdx?: number) => {
      if (!display) return "#";
      const p = getActivePreset(display.selectedPreset, display.comboSubs, subPresetIdx);
      return buildPresetBacktestUrl({
        preset: p,
        startDate: dates.start,
        endDate: dates.end,
        smaPeriod: p.index === "nasdaq100" ? display.summary.smaNqPeriod : display.summary.smaSpPeriod,
        smaUpperBuffer: row.parameterValue, smaLowerBuffer: row.parameterValue,
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
        title: (items: TooltipItem<"line">[]) => `Buffer ${(items[0]?.parsed.x ?? 0).toFixed(1)}%`,
        xTick: (value: number | string) => `${Number(value).toFixed(1)}%`,
        xMin: minBuffer,
        xMax: maxBuffer,
      }),
    [minBuffer, maxBuffer]
  );

  const runBufferSweepForPreset = useCallback(async (
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
    // Include baseline FIRST in the sweep items
    const blConfig: EtfConfig = {
      id: "baseline", name: `${presetDef.name} (No SMA)`,
      leverage: presetDef.leverage, expenseRatio: presetDef.expenseRatio, simulated: true,
      smaEnabled: false, smaPeriod: presetDef.index === "nasdaq100" ? smaNqPeriod : smaSpPeriod, smaUpperBuffer: 0, smaLowerBuffer: 0,
      smaIndex: presetDef.index, riskOffAsset,
    };

    const items: Array<{ paramValue: number; config: EtfConfig }> = [
      { paramValue: 0, config: blConfig },  // Baseline first
    ];

    for (let buf = minBuffer; buf <= maxBuffer + 1e-9; buf += fineStep) {
      const rt = Math.round(buf * 1000) / 1000;
      items.push({
        paramValue: rt,
        config: {
          id: `buffer-${rt}`, name: `${presetDef.name} SMA ${presetDef.index === "nasdaq100" ? smaNqPeriod : smaSpPeriod} Buffer ${rt}%`,
          leverage: presetDef.leverage, expenseRatio: presetDef.expenseRatio, simulated: presetDef.simulated,
          smaEnabled: true, smaPeriod: presetDef.index === "nasdaq100" ? smaNqPeriod : smaSpPeriod, smaUpperBuffer: rt, smaLowerBuffer: rt,
          smaIndex: presetDef.index, riskOffAsset,
        },
      });
    }

    // Append the coarse asymmetric (upper × lower) configs for this preset so the
    // worker pool sees symmetric + coarse asym as one batch. precomputeAllConfigDailyValues
    // runs once across the combined set instead of twice.
    const coarseAsymPoints = asymCoarsePointsByPresetRef.current.get(presetDef.name) ?? [];
    const period = presetDef.index === "nasdaq100" ? smaNqPeriod : smaSpPeriod;
    for (const p of coarseAsymPoints) {
      const encoded = Math.round(p.upper * 100) * 10000 + Math.round(p.lower * 100);
      items.push({
        paramValue: encoded,
        config: {
          id: `asym-${encoded}`,
          name: `${presetDef.name} SMA ${period} U${p.upper}/L${p.lower} (coarse)`,
          leverage: presetDef.leverage, expenseRatio: presetDef.expenseRatio, simulated: presetDef.simulated,
          smaEnabled: true, smaPeriod: period,
          smaUpperBuffer: p.upper, smaLowerBuffer: p.lower,
          smaIndex: presetDef.index, riskOffAsset,
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

    // Split rows by parameterValue magnitude. Asym configs encode (upper, lower) as
    // `upper*100 * 10000 + lower*100`, so any non-trivial pair is >= 10000 — well
    // above the symmetric range (0..30). Threshold of 1000 is a safe boundary.
    const ASYM_THRESHOLD = 1000;
    const symRows: SmaComparisonRow[] = [];
    const asymRowsForPreset: AsymmetricSweepRow[] = [];
    let bl: SmaComparisonRow | null = null;
    for (const row of allSweepRows) {
      if (row.parameterValue >= ASYM_THRESHOLD) {
        const encoded = row.parameterValue;
        const l = encoded % 10000;
        const u = (encoded - l) / 10000;
        asymRowsForPreset.push({ ...row, upperBuffer: u / 100, lowerBuffer: l / 100, stage: "coarse" });
      } else if (bl === null) {
        bl = row;
      } else {
        symRows.push(row);
      }
    }
    asymCoarseRowsByPresetRef.current.set(presetDef.name, asymRowsForPreset);
    asymContextByPresetRef.current.set(presetDef.name, {
      prices, rates, riskOffSeries, monthlyCpi: cpiData, coarsePoints: coarseAsymPoints,
    });

    return { rows: symRows, baseline: bl };
  }, [riskOffAsset, smaNqPeriod, smaSpPeriod, minBuffer, maxBuffer, fineStep, windowLength, startDate, endDate, setRunProgress]);

  const buildSmaBufferUrlParams = useCallback(() => {
    const params = getUrlParams();
    params.delete("smatsp");
    params.delete("smatnq");
    params.set("minT", String(minBuffer));
    params.set("maxT", String(maxBuffer));
    params.set("stepT", String(fineStep));
    params.set("cstepT", String(coarseStep));
    params.set("hwT", String(fineHalfWidth));
    return params;
  }, [getUrlParams, minBuffer, maxBuffer, fineStep, coarseStep, fineHalfWidth]);

  const updateUrl = useCallback(() => {
    markNextSearchAsInternal();
    router.push(buildToolsUrl("sma-buffer", buildSmaBufferUrlParams()));
  }, [buildSmaBufferUrlParams, router, markNextSearchAsInternal]);

  const formatFinalValuePct = useCallback(
    (value: number) => formatMultiple(value / CONSTANT_INITIAL_INVESTMENT),
    []
  );

  const handleCancel = useCallback(() => {
    abortControllerRef.current?.abort();
    setLoading(false);
    setRunProgress(null);
  }, [setRunProgress]);

  // Asymmetric FINE-only sweep for a single sub-preset. Coarse rows already came
  // from the symmetric+coarse batch in runBufferSweepForPreset and live in
  // asymCoarseRowsByPresetRef. Here we just pick the top coarse cell, plan the
  // refined grid around it, dispatch the fine run reusing the per-preset
  // context (prices/rates/risk-off) captured by runBufferSweepForPreset.
  const runAsymmetricFineForPreset = useCallback(async (
    presetDef: EtfPreset,
    inflPct: number,
    signal: AbortSignal,
    progressBase: number,
    progressSpan: number,
  ): Promise<{ rows: AsymmetricSweepRow[]; fineWindow: { minU: number; maxU: number; minL: number; maxL: number } | null }> => {
    const coarseRows = asymCoarseRowsByPresetRef.current.get(presetDef.name) ?? [];
    const ctx = asymContextByPresetRef.current.get(presetDef.name);
    if (!ctx || coarseRows.length === 0) return { rows: coarseRows, fineWindow: null };

    const top = pickTopCell(coarseRows, "score", inflPct);
    if (!top) return { rows: coarseRows, fineWindow: null };

    const finePoints = dedupePoints(
      planFineGrid({
        centerUpper: top.upperBuffer,
        centerLower: top.lowerBuffer,
        halfWidth: fineHalfWidth,
        fineStep,
        bounds: { minUpper: minBuffer, maxUpper: maxBuffer, minLower: minBuffer, maxLower: maxBuffer },
      }),
      ctx.coarsePoints,
    );
    const fineWindow = {
      minU: Math.max(minBuffer, top.upperBuffer - fineHalfWidth),
      maxU: Math.min(maxBuffer, top.upperBuffer + fineHalfWidth),
      minL: Math.max(minBuffer, top.lowerBuffer - fineHalfWidth),
      maxL: Math.min(maxBuffer, top.lowerBuffer + fineHalfWidth),
    };
    if (finePoints.length === 0) return { rows: coarseRows, fineWindow };

    const period = presetDef.index === "nasdaq100" ? smaNqPeriod : smaSpPeriod;
    const fineConfigs: EtfConfig[] = finePoints.map((p) => {
      const encoded = Math.round(p.upper * 100) * 10000 + Math.round(p.lower * 100);
      return {
        id: `asym-${encoded}`,
        name: `${presetDef.name} SMA ${period} U${p.upper}/L${p.lower} (fine)`,
        leverage: presetDef.leverage,
        expenseRatio: presetDef.expenseRatio,
        simulated: presetDef.simulated,
        smaEnabled: true,
        smaPeriod: period,
        smaUpperBuffer: p.upper,
        smaLowerBuffer: p.lower,
        smaIndex: presetDef.index,
        riskOffAsset,
      };
    });
    const fineResult = (await runParallelSimulations({
      prices: ctx.prices,
      rates: ctx.rates,
      windowLength,
      startDate,
      endDate,
      configs: fineConfigs,
      riskOffValuesByAsset: ctx.riskOffSeries.closeValuesByAsset,
      riskOffOpenValuesByAsset: ctx.riskOffSeries.openValuesByAsset,
      monthlyCpi: ctx.monthlyCpi,
      mode: "sweep",
      signal,
      onProgress: (fraction, label) =>
        setRunProgress({ pct: progressBase + fraction * progressSpan, label: label ?? "Asymmetric fine…" }),
    })) as SmaComparisonRow[];

    const fineRows: AsymmetricSweepRow[] = fineResult.map((row) => {
      const encoded = row.parameterValue;
      const l = encoded % 10000;
      const u = (encoded - l) / 10000;
      return { ...row, upperBuffer: u / 100, lowerBuffer: l / 100, stage: "fine" };
    });
    return { rows: [...coarseRows, ...fineRows], fineWindow };
  }, [riskOffAsset, smaNqPeriod, smaSpPeriod, minBuffer, maxBuffer, fineStep, fineHalfWidth, windowLength, startDate, endDate, setRunProgress]);

  const handleRun = useCallback(async () => {
    setLoading(true);
    setRunProgress({ pct: 5, label: "Loading market data..." });
    setError(null);
    updateUrl();

    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const signal = controller.signal;

    // Reset asym output. Pre-plan the coarse (upper × lower) grid per preset so
    // runBufferSweepForPreset can append those configs to its symmetric batch and
    // the worker pool sees one job instead of two (saves one round of
    // precomputeAllConfigDailyValues per preset). The fine stage runs after the
    // combined batch — it depends on the best coarse cell.
    setAsymRows([]); setAsymRows2([]); setAsymFineWindow(null); setAsymFineWindow2(null);
    const asymPresets: EtfPreset[] = comboSubs ?? [selectedPreset];
    const coarsePointsPlan = planCoarseGrid({
      minUpper: minBuffer,
      maxUpper: maxBuffer,
      minLower: minBuffer,
      maxLower: maxBuffer,
      coarseStep,
    });
    asymCoarsePointsByPresetRef.current = new Map(asymPresets.map((sub) => [sub.name, coarsePointsPlan]));
    asymCoarseRowsByPresetRef.current = new Map();
    asymContextByPresetRef.current = new Map();

    try {
      const rawRiskOffSeriesPromise = loadAllRiskOffPricePoints(
        getRiskOffFetchTickers(riskOffAsset),
        signal,
        ({ completed, total, label }) => {
          setRunProgress({ pct: 16 + (completed / total) * 4, label });
        },
        {
          startDate: getMarketDataWarmUpStartDate(startDate, Math.max(smaSpPeriod, smaNqPeriod)),
          endDate,
        }
      );
      const result = await runCompareSweep({
        comboSubs,
        selectedPreset,
        index,
        startDate,
        endDate,
        warmUpTradingDays: Math.max(smaSpPeriod, smaNqPeriod),
        // Combined symmetric + coarse-asym batch claims pct 0→80; the fine asym
        // dispatch below claims 80→100. Monotonic clamping handles the boundary.
        onProgress: (pct, label) => setRunProgress({ pct: pct * 0.8, label }),
        loadRiskOffValues: async (_preset, prices) =>
          alignRiskOffPriceSeries(prices, await rawRiskOffSeriesPromise),
        runSweepForPreset: runBufferSweepForPreset,
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
        setError("No valid simulations for this range and buffer configuration.");
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
        smaSpPeriod, smaNqPeriod,
        smaSpUpperBuffer, smaSpLowerBuffer, smaNqUpperBuffer, smaNqLowerBuffer,
        minBuffer, maxBuffer, fineStep, coarseStep, fineHalfWidth, riskOffAsset,
        showBaseline: true, annualizedInflation: inflationData.annualizedInflation, monthlyCpi: inflationData.monthlyCpi,
        rows: computedRows,
        baseline: computedBaseline,
        rows2: computedRows2,
        baseline2: computedBaseline2,
        asymRows: [],
        asymRows2: [],
        asymFineWindow: null,
        asymFineWindow2: null,
        runSummaryInputs: nextRunSummary,
      });

      if (inflationWarning) {
        setError("Inflation data unavailable — Real CAGR may be inaccurate.");
      }

      // Coarse asym rows were already produced in the symmetric+coarse merged batch
      // above (one less precompute round). Now dispatch the fine refinement per
      // preset in parallel — each preset's fine grid depends only on its own coarse
      // top cell, and reuses the prices/rates/risk-off context cached by
      // runBufferSweepForPreset.
      const inflPctForAsym = inflationData.monthlyCpi.length >= 2 ? 0 : inflationData.annualizedInflation * 100;
      const finePromises = asymPresets.map((sub, i) => {
        const span = 20 / Math.max(1, asymPresets.length); // fine claims 80→100
        const base = 80 + span * i;
        return runAsymmetricFineForPreset(sub, inflPctForAsym, signal, base, span).catch((asymErr) => {
          if (!(asymErr instanceof Error && asymErr.name === "AbortError")) {
            console.error("Asymmetric fine sweep failed:", asymErr);
          }
          return { rows: asymCoarseRowsByPresetRef.current.get(sub.name) ?? [], fineWindow: null };
        });
      });
      const fineResults = await Promise.all(finePromises);
      if (!signal.aborted) {
        for (let i = 0; i < fineResults.length; i++) {
          const { rows: subAsymRows, fineWindow } = fineResults[i];
          if (i === 0) {
            setAsymRows(subAsymRows);
            setAsymFineWindow(fineWindow);
          } else if (i === 1) {
            setAsymRows2(subAsymRows);
            setAsymFineWindow2(fineWindow);
          }
        }
      }

      clearMetadata();
      setRunProgress({ pct: 100, label: "Done" });
      if (computedRows.length > 0 || computedRows2.length > 0) {
        recordSuccessfulToolRun({
          tab: "sma-buffer",
          tabLabel: "SMA Buffer",
          href: buildToolsUrl("sma-buffer", buildSmaBufferUrlParams()),
          summary: nextRunSummary,
        });
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return;
      }
      console.error("Buffer strategy comparison failed:", err);
      let message = "Failed to run simulations. ";
      if (err instanceof Error) {
        message += err.message;
      } else if (typeof err === "string") {
        message += err;
      } else {
        message += "An unexpected error occurred.";
      }
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
  }, [startDate, endDate, windowLength, smaSpPeriod, smaNqPeriod, smaSpUpperBuffer, smaSpLowerBuffer, smaNqUpperBuffer, smaNqLowerBuffer, riskOffAsset, letf, index, comboSubs, selectedPreset, buildSmaBufferUrlParams, runBufferSweepForPreset, runAsymmetricFineForPreset, setRunSummary, save, clearMetadata, fineStep, coarseStep, fineHalfWidth, maxBuffer, minBuffer, updateUrl, setRunProgress]);

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
        <h1 className="text-3xl md:text-4xl font-bold">SMA Buffer</h1>

        <SharedToolInputs
          values={{
            letf, startDate, endDate, windowLength,
            smaSpPeriod, smaNqPeriod, riskOffAsset,
          }}
          onChange={handleFieldChange}
          dateRange={{ min: effectiveMinDate, max: dateRange.max }}
          presetOptions={PRESET_SELECT_OPTIONS}
          onRun={handleRun}
          onCancel={handleCancel}
          loading={loading}
          runLabel="Compare Strategies"
          progress={runProgress}
          error={error}
        >
          <Input
            label="Min SMA Buffer"
            suffix="%"
            type="number"
            step={0.5}
            min={0}
            max={20}
            value={minBuffer}
            onChange={(e) => setMinBuffer(parseNumberOrKeep(e.currentTarget.value, minBuffer))}
          />
          <Input
            label="Max SMA Buffer"
            suffix="%"
            type="number"
            step={0.5}
            min={0}
            max={20}
            value={maxBuffer}
            onChange={(e) => setMaxBuffer(parseNumberOrKeep(e.currentTarget.value, maxBuffer))}
          />
          <Input
            label="Fine Step"
            suffix="%"
            info="Drives the symmetric 1D sweep and the asymmetric stage-2 refinement grid. Smaller steps try more buffers but take longer."
            type="number"
            step={0.1}
            min={0.1}
            max={5}
            value={fineStep}
            onChange={(e) => setFineStep(parseNumberOrKeep(e.currentTarget.value, fineStep))}
          />
          <Input
            label="Coarse Step"
            suffix="%"
            info="Stage-1 grid resolution for the asymmetric (upper × lower) sweep. Larger = fewer runs."
            type="number"
            step={0.5}
            min={0.5}
            max={10}
            value={coarseStep}
            onChange={(e) => setCoarseStep(parseNumberOrKeep(e.currentTarget.value, coarseStep))}
          />
          <Input
            label="Fine Window Half-Width"
            suffix="%"
            info="How far around the best coarse cell the asymmetric stage-2 grid refines."
            type="number"
            step={0.5}
            min={0.5}
            max={10}
            value={fineHalfWidth}
            onChange={(e) => setFineHalfWidth(parseNumberOrKeep(e.currentTarget.value, fineHalfWidth))}
          />
        </SharedToolInputs>

        {display && rows.length > 0 && (
          <SimulationRunSummary summary={display.summary} />
        )}

        {display && bestRow && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <Card>
              <p className="text-xs text-muted mb-1">{display.comboLabels ? `${display.comboLabels[0]} Best Buffer` : "Best Avg Real CAGR Buffer"}</p>
              <p className="text-lg font-semibold">{bestRow.parameterValue}%</p>
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
                  <p className="text-xs text-muted mb-1">{display.comboLabels[1]} Best Buffer</p>
                  <p className="text-lg font-semibold">{bestRow2.parameterValue}%</p>
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
              <h2 className="text-lg font-semibold mb-2">Performance Across Buffers</h2>
              <p className="text-xs text-muted mb-4">
                These charts compare buffer performance against the non-SMA baseline
                (horizontal lines). Charts are unsmoothed to preserve real variation.
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
                    <SectionTitleWithInflation className="text-lg font-semibold" title={`${display.comboLabels[0]} — Buffer Comparison`} startDate={primaryDisplayStartDate} inflationPct={primaryInflationPctForDisplay} avgTradesPerYear={avgTradesPerYear} />
                    {hateDrawdownToggle}
                  </div>
                  <SweepComparisonTable resultTableTestId="snapshot-tool-sweep-0" rows={rows} inflationPct={inflPct} windowYears={display.summary.windowLength} firstColumnLabel="Buffer (%)" formatFirstColumn={(r) => `${r.parameterValue}%`} getBacktestUrl={(row, dates) => buildBacktestUrl(row, dates, 0)} baseline={baseline} startDate={display.summary.startDate} showStartDate={false} hateDrawdown={hateDrawdown} showAvgTrades={avgTradesPerYear === undefined} />
                </Card>
                <Card>
                  <div className="mb-3 flex items-center justify-between gap-3 flex-wrap">
                    <SectionTitleWithInflation className="text-lg font-semibold" title={`${display.comboLabels[1]} — Buffer Comparison`} startDate={secondaryDisplayStartDate} inflationPct={secondaryInflationPctForDisplay} avgTradesPerYear={avgTradesPerYear2} />
                  </div>
                  <SweepComparisonTable resultTableTestId="snapshot-tool-sweep-1" rows={rows2} inflationPct={inflPct} windowYears={display.summary.windowLength} firstColumnLabel="Buffer (%)" formatFirstColumn={(r) => `${r.parameterValue}%`} getBacktestUrl={(row, dates) => buildBacktestUrl(row, dates, 1)} baseline={baseline2} startDate={display.summary.startDate} showStartDate={false} hateDrawdown={hateDrawdown} showAvgTrades={avgTradesPerYear2 === undefined} />
                </Card>
              </>
            ) : (
              <Card>
                <div className="mb-3 flex items-center justify-between gap-3 flex-wrap">
                  <SectionTitleWithInflation className="text-lg font-semibold" title="Buffer Comparison" startDate={primaryDisplayStartDate} inflationPct={primaryInflationPctForDisplay} avgTradesPerYear={avgTradesPerYear} />
                  {hateDrawdownToggle}
                </div>
                <SweepComparisonTable resultTableTestId="snapshot-tool-sweep-main" rows={rows} inflationPct={inflPct} windowYears={display.summary.windowLength} firstColumnLabel="Buffer (%)" formatFirstColumn={(r) => `${r.parameterValue}%`} getBacktestUrl={buildBacktestUrl} baseline={baseline} startDate={display.summary.startDate} showStartDate={false} hateDrawdown={hateDrawdown} showAvgTrades={avgTradesPerYear === undefined} />
              </Card>
            )}
          </>
        )}

        {/* Asymmetric (upper × lower) heatmaps + per-sub-preset tables. */}
        {display && (asymRows.length > 0 || asymRows2.length > 0) && (
          <>
            <AsymmetricSection
              title={display.comboLabels ? `${display.comboLabels[0]} — Asymmetric (Upper × Lower)` : "Asymmetric (Upper × Lower)"}
              rows={asymRows}
              fineWindow={asymFineWindow}
              inflationPct={inflPct}
              windowYears={display.summary.windowLength}
              startDate={display.summary.startDate}
              hateDrawdown={hateDrawdown}
            />
            {display.comboLabels && asymRows2.length > 0 && (
              <AsymmetricSection
                title={`${display.comboLabels[1]} — Asymmetric (Upper × Lower)`}
                rows={asymRows2}
                fineWindow={asymFineWindow2}
                inflationPct={inflPct}
                windowYears={display.summary.windowLength}
                startDate={display.summary.startDate}
                hateDrawdown={hateDrawdown}
              />
            )}
          </>
        )}

      </div>
    </div>
  );
}

function AsymmetricSection({
  title,
  rows,
  fineWindow,
  inflationPct,
  windowYears,
  startDate,
  hateDrawdown,
}: {
  title: string;
  rows: AsymmetricSweepRow[];
  fineWindow: { minU: number; maxU: number; minL: number; maxL: number } | null;
  inflationPct: number;
  windowYears: number;
  startDate?: string;
  hateDrawdown?: boolean;
}) {
  const objective: ObjectiveKey = "score";
  const top = pickTopCell(rows, objective, inflationPct);
  // Asymmetric rows carry upper/lower buffers; format the first table column as
  // `−lower%/upper%` so the existing SweepComparisonTable renders the right pair.
  const formatPair = (r: SmaComparisonRow) => {
    const a = r as AsymmetricSweepRow;
    return `−${a.lowerBuffer.toFixed(2)}%/${a.upperBuffer.toFixed(2)}%`;
  };
  return (
    <Card>
      <h2 className="text-lg font-semibold mb-3">{title}</h2>
      <BufferHeatmap
        rows={rows}
        objective={objective}
        inflationPct={inflationPct}
        highlight={top ? { upper: top.upperBuffer, lower: top.lowerBuffer } : null}
        fineWindow={fineWindow}
      />
      <div className="mt-4">
        <SweepComparisonTable
          rows={rows as SmaComparisonRow[]}
          inflationPct={inflationPct}
          windowYears={windowYears}
          firstColumnLabel="−Lower / +Upper"
          formatFirstColumn={formatPair}
          getBacktestUrl={() => null}
          startDate={startDate}
          showStartDate={false}
          hateDrawdown={hateDrawdown}
        />
      </div>
    </Card>
  );
}

