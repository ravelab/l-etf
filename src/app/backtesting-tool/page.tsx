"use client";

import { Suspense, useState, useCallback, useEffect, useMemo, useRef } from "react";
import { flushSync } from "react-dom";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import type { EtfConfig, BacktestResult } from "@/lib/simulation/types";
import { runParallelBacktest } from "@/lib/simulation/parallel";
import { useMonotonicRunProgress } from "@/lib/hooks/use-monotonic-run-progress";
import {
  createDefaultEtfConfig,
  applyPreset,
  ETF_PRESETS,
  PRESET_SELECT_OPTIONS,
  isComboPreset,
  getComboSubPresets,
  getConfigDefaultStartDate,
  getValidPresetKey,
  DEFAULT_COMBO_PRESET,
} from "@/lib/simulation/presets";
import { getDefaultSmaBuffer, getDefaultSmaPeriod } from "@/lib/simulation/defaults";
import { EtfConfigCard } from "@/components/tools/backtest/EtfConfigCard";
import { ValueChart } from "@/components/tools/backtest/ValueChart";
import { SmaChart } from "@/components/tools/backtest/SmaChart";
import { ResultsTable } from "@/components/tools/backtest/ResultsTable";
import { RunSpinnerOverlay } from "@/components/ui/RunSpinnerOverlay";
import { Button } from "@/components/ui/Button";
import {
  INDEX_DATE_RANGES,
  CONSTANT_INITIAL_INVESTMENT,
  getRiskOffFetchTickers,
  LABEL_INDEX_NASDAQ100_TR,
  LABEL_INDEX_SP500_TR,
} from "@/lib/constants";
import { DEFAULT_RISK_OFF_ASSET } from "@/lib/simulation/defaults";
import type { PricePoint, RatePoint, IndexKey, RiskOffAsset } from "@/lib/simulation/types";
import { decodeBacktestParams } from "@/lib/url-state";
import { getIsoDate } from "@/lib/date";
import { annualizedInflationForRange } from "@/lib/inflation";
import { SharedToolInputs } from "@/components/tools/SharedToolInputs";
import { SimulationRunSummary } from "@/components/tools/SimulationRunSummary";
import type { RunSummary } from "@/lib/run-summary";
import { buildRunSummary } from "@/lib/run-summary";
import { useRunSummary, useRunDisplay } from "@/lib/hooks/use-run-summary-inputs";
import { useToolForm } from "@/lib/hooks/use-tool-form";
import { useToolSnapshot } from "@/lib/hooks/use-tool-snapshot";
import { useRefreshEndDateOnInitialVisit } from "@/lib/hooks/use-refresh-end-date";
import { buildBacktestChartSeries } from "@/lib/backtest-chart-series";
import { buildToolsUrl, shouldQueueToolAutorun } from "@/lib/tools-route";
import { recordSuccessfulToolRun } from "@/lib/tool-run-history";
import { useSearchSyncRunGuard } from "@/lib/hooks/use-search-sync-run-guard";
import { getLaunchDateForPresetName, useEtfLaunchDates } from "@/lib/hooks/use-etf-launch-dates";
import { fetchJsonCached, getMarketDataWarmUpStartDate, loadAllRiskOffPricePoints } from "@/lib/fetch-market-data";
import { validateSimulationReadyPrices } from "@/lib/utils";
import { shortBacktestAssetLabel } from "@/lib/strategy-page-data";
import { normalizeDateString, normalizeNumberValue, normalizeRiskOffAsset } from "@/lib/input-normalization";
import { alignCloseSeriesToDates } from "@/lib/utils";
import { effectiveStartDateFromAlignedSeries } from "@/lib/simulation/effective-start";

const EMPTY_UNDERLYING_INDEX_SERIES: Array<{
  index: IndexKey;
  label: string;
  dates: string[];
  values: number[];
}> = [];

const buildPresetConfigs = (letf: string): EtfConfig[] => {
  const validPreset = getValidPresetKey(letf, DEFAULT_COMBO_PRESET);
  if (isComboPreset(validPreset)) {
    return getComboSubPresets(validPreset).map((subPreset, idx) =>
      applyPreset(createDefaultEtfConfig(`etf${idx + 1}`), subPreset.name)
    );
  }

  return [applyPreset(createDefaultEtfConfig("etf1"), validPreset)];
};

export default function BacktestingPage() {
  return (
    <Suspense fallback={null}>
      <BacktestingPageContent active />
    </Suspense>
  );
}

export function BacktestingPageContent({
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
  const etfLaunchDates = useEtfLaunchDates();
  const form = useToolForm("backtesting", {
    etfConfigs: [] as EtfConfig[],
    result: null as BacktestResult | null,
    annualizedInflation: 0,
    monthlyCpi: [] as Array<{ date: string; value: number }>,
    closePricesByEtfId: {} as Record<string, number[]>,
    adjustedClosePricesByEtfId: {} as Record<string, number[]>,
    openPricesByEtfId: {} as Record<string, number[]>,
    tradeClosePricesByEtfId: {} as Record<string, number[]>,
    tradeOpenPricesByEtfId: {} as Record<string, number[]>,
    syntheticPriceScaleByEtfId: {} as Record<string, number>,
    datesByEtfId: {} as Record<string, string[]>,
    riskOffPricesByTicker: {} as Record<string, PricePoint[]>,
    underlyingIndexSeries: [] as Array<{ index: IndexKey; label: string; dates: string[]; values: number[] }>,
    expandedSmaCharts: [] as string[],
    smaMode: 1,
    runSummaryInputs: null as RunSummary | null,
  }, {
    persistKeys: ["etfConfigs", "smaMode", "runSummaryInputs"],
  });

  const {
    letf, setLetf, index, setIndex,
    startDate, setStartDate, endDate, setEndDate,
    windowLength,
    smaSpPeriod, setSmaSpPeriod, smaNqPeriod, setSmaNqPeriod,
    smaSpUpperBuffer, setSmaSpUpperBuffer, smaSpLowerBuffer, setSmaSpLowerBuffer,
    smaNqUpperBuffer, setSmaNqUpperBuffer, smaNqLowerBuffer, setSmaNqLowerBuffer,
    riskOffAsset, setRiskOffAsset,
    handleFieldChange, initial, save, restoredFromCache,
  } = form;

  const initialInvestment = CONSTANT_INITIAL_INVESTMENT;
  const [etfConfigs, setEtfConfigs] = useState<EtfConfig[]>(initial.etfConfigs);
  const [result, setResult] = useState<BacktestResult | null>(initial.result);
  const hasCachedResults = result !== null;
  const [annualizedInflation, setAnnualizedInflation] = useState(initial.annualizedInflation);
  const [monthlyCpi, setMonthlyCpi] = useState<Array<{ date: string; value: number }>>(initial.monthlyCpi ?? []);
  const [riskOffPricesByTicker, setRiskOffPricesByTicker] = useState<Record<string, PricePoint[]>>(initial.riskOffPricesByTicker ?? {});
  const [loading, setLoading] = useState(false);
  const [runProgress, setRunProgress] = useMonotonicRunProgress();
  const abortControllerRef = useRef<AbortController | null>(null);
  const [closePricesByEtfId, setClosePricesByEtfId] = useState<
    Record<string, number[]>
  >(initial.closePricesByEtfId);
  const [adjustedClosePricesByEtfId, setAdjustedClosePricesByEtfId] = useState<Record<string, number[]>>(
    initial.adjustedClosePricesByEtfId ?? {}
  );
  const [openPricesByEtfId, setOpenPricesByEtfId] = useState<Record<string, number[]>>(
    initial.openPricesByEtfId ?? {}
  );
  const [tradeClosePricesByEtfId, setTradeClosePricesByEtfId] = useState<Record<string, number[]>>(
    initial.tradeClosePricesByEtfId ?? {}
  );
  const [tradeOpenPricesByEtfId, setTradeOpenPricesByEtfId] = useState<Record<string, number[]>>(
    initial.tradeOpenPricesByEtfId ?? {}
  );
  const [syntheticPriceScaleByEtfId, setSyntheticPriceScaleByEtfId] = useState<Record<string, number>>(
    initial.syntheticPriceScaleByEtfId ?? {}
  );
  const [datesByEtfId, setDatesByEtfId] = useState<Record<string, string[]>>(initial.datesByEtfId);
  const [underlyingIndexSeries, setUnderlyingIndexSeries] = useState<
    Array<{ index: IndexKey; label: string; dates: string[]; values: number[] }>
  >(initial.underlyingIndexSeries);
  const [expandedSmaCharts, setExpandedSmaCharts] = useState<string[]>(initial.expandedSmaCharts);
  const {
    runSummary,
    setRunSummary,
    applyRunSummaryFromSnapshot,
    clearRunSummary,
  } = useRunSummary(initial.runSummaryInputs as RunSummary | null);
  const display = useRunDisplay(runSummary);
  const [error, setError] = useState<string | null>(null);
  const [pendingRun, setPendingRun] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [smaMode, setSmaMode] = useState(initial.smaMode);
  const skipNextPresetEffectRef = useRef(false);

  const baseEtfConfigs = useMemo(() => buildPresetConfigs(letf), [letf]);
  const checkSimulationDisplayStarts = useMemo(
    () => ({
      UPRO: etfLaunchDates.UPRO,
      TQQQ: etfLaunchDates.TQQQ,
      SSO: etfLaunchDates.SSO,
      QLD: etfLaunchDates.QLD,
    }),
    [etfLaunchDates]
  );

  const resolvedEtfConfigs = useMemo(
    () => {
      const isCheckSimulationsSetup =
        smaMode === 0 &&
        letf === "UPRO+TQQQ" &&
        etfConfigs.some((cfg) => cfg.name === "UPRO-real") &&
        etfConfigs.some((cfg) => cfg.name === "TQQQ-real");

      const baseConfigs = [...baseEtfConfigs, ...etfConfigs].map((cfg, idx) => ({
        ...cfg,
        id: `etf${idx + 1}`,
        displayStartDate: isCheckSimulationsSetup
          ? ((checkSimulationDisplayStarts[cfg.name.replace(/-real$/, "") as keyof typeof checkSimulationDisplayStarts]
            ?? getLaunchDateForPresetName(cfg.name, etfLaunchDates))
            || cfg.displayStartDate
            || (cfg.simulated ? getConfigDefaultStartDate(cfg) : undefined))
          : cfg.simulated
            ? (cfg.displayStartDate || getConfigDefaultStartDate(cfg))
            : getLaunchDateForPresetName(cfg.name, etfLaunchDates) || cfg.displayStartDate,
        smaEnabled: smaMode !== 0 && cfg.smaEnabled,
        smaPeriod: smaMode !== 0 ? (cfg.smaIndex === "nasdaq100" ? smaNqPeriod : smaSpPeriod) : 0,
        smaUpperBuffer: smaMode !== 0 ? (cfg.smaIndex === "nasdaq100" ? smaNqUpperBuffer : smaSpUpperBuffer) : 0, smaLowerBuffer: smaMode !== 0 ? (cfg.smaIndex === "nasdaq100" ? smaNqLowerBuffer : smaSpLowerBuffer) : 0,
        riskOffAsset,
      }));

      if (smaMode === 0) return baseConfigs;
      return baseConfigs;
    },
    [baseEtfConfigs, etfConfigs, letf, smaSpPeriod, smaNqPeriod, smaSpUpperBuffer, smaSpLowerBuffer, smaNqUpperBuffer, smaNqLowerBuffer, riskOffAsset, smaMode, checkSimulationDisplayStarts, etfLaunchDates]
  );

  type BacktestingSnapshotState = typeof initial;

  const searchStr = searchParams.toString();

  useEffect(() => {
    const params = new URLSearchParams(searchStr);
    const decoded = decodeBacktestParams(searchStr ? `?${searchStr}` : "");

    // Read LETF directly from URL (not from decodeBacktestParams)
    const urlLetf = params.get("letf");
    if (urlLetf) {
      setLetf(getValidPresetKey(urlLetf, DEFAULT_COMBO_PRESET));
    }

    if (decoded) {
      const activeIdx: IndexKey =
        decoded.index === "sp500" || decoded.index === "nasdaq100" ? decoded.index : "sp500";
      setIndex(activeIdx);
      if (decoded.startDate) {
        const range = {
          min: INDEX_DATE_RANGES.sp500.min < INDEX_DATE_RANGES.nasdaq100.min ? INDEX_DATE_RANGES.sp500.min : INDEX_DATE_RANGES.nasdaq100.min,
          max: INDEX_DATE_RANGES.sp500.max < INDEX_DATE_RANGES.nasdaq100.max ? INDEX_DATE_RANGES.sp500.max : INDEX_DATE_RANGES.nasdaq100.max,
        };
        const sd = normalizeDateString(decoded.startDate, range.min);
        setStartDate(sd < range.min ? range.min : sd > range.max ? range.max : sd);
      }
      if (decoded.endDate) setEndDate(normalizeDateString(decoded.endDate, getIsoDate(new Date())));
      if (decoded.smaSpPeriod != null) setSmaSpPeriod(normalizeNumberValue(decoded.smaSpPeriod, getDefaultSmaPeriod("sp500"), { integer: true, min: 1 }));
      if (decoded.smaNqPeriod != null) setSmaNqPeriod(normalizeNumberValue(decoded.smaNqPeriod, getDefaultSmaPeriod("nasdaq100"), { integer: true, min: 1 }));
      if (decoded.smaSpUpperBuffer != null) setSmaSpUpperBuffer(normalizeNumberValue(decoded.smaSpUpperBuffer, getDefaultSmaBuffer("sp500"), { min: 0 }));
      if (decoded.smaNqUpperBuffer != null) setSmaNqUpperBuffer(normalizeNumberValue(decoded.smaNqUpperBuffer, getDefaultSmaBuffer("nasdaq100"), { min: 0 }));
      if (decoded.riskOffAsset) setRiskOffAsset(normalizeRiskOffAsset(decoded.riskOffAsset));
      const smaParam = params.get("sma");
      // Use Promise.resolve().then() to defer state updates and avoid cascading render warnings
      Promise.resolve().then(() => {
        if (smaParam === "0") setSmaMode(0);
        else setSmaMode(1);
      });

      // Load etfConfigs from URL as additional cards, or clear if none in URL
      if (decoded.etfConfigs && decoded.etfConfigs.length > 0) {
        const hydrated = decoded.etfConfigs.map((partial, i) => ({
          ...createDefaultEtfConfig(`etf${i + 1}`),
          ...partial,
          id: `etf${i + 1}`,
        }));
        Promise.resolve().then(() => {
          setEtfConfigs(hydrated);
        });
        skipNextPresetEffectRef.current = true;
      } else if (!urlLetf) {
        Promise.resolve().then(() => {
          setEtfConfigs([]);
        });
      }
    }
    Promise.resolve().then(() => {
      setPendingRun(
        active &&
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
      setInitialized(true);
    });
  }, [
    active,
    suppressAutoRun,
    allowInitialSearchAutoRun,
    shouldAutoRunFromSearch,
    hasCachedResults,
    searchStr,
    pathname,
    setLetf,
    setIndex,
    setStartDate,
    setEndDate,
    setSmaSpPeriod,
    setSmaNqPeriod,
    setSmaSpUpperBuffer, setSmaSpLowerBuffer, setSmaNqUpperBuffer, setSmaNqLowerBuffer,
    setRiskOffAsset,
  ]);

  const shouldHydrateSnapshot = !hasCachedResults && !restoredFromCache;

  useRefreshEndDateOnInitialVisit({
    active,
    hasCachedResults,
    shouldHydrateSnapshot,
    endDate,
    setEndDate,
  });

  const applyBacktestSnapshot = useCallback(
    (state: Record<string, unknown>) => {
      const snapshot = state as Partial<BacktestingSnapshotState>;
      if (snapshot.etfConfigs) setEtfConfigs(snapshot.etfConfigs as EtfConfig[]);
      if (snapshot.result) setResult(snapshot.result as BacktestResult);
      if (snapshot.annualizedInflation != null) setAnnualizedInflation(snapshot.annualizedInflation as number);
      if (Array.isArray(snapshot.monthlyCpi)) setMonthlyCpi(snapshot.monthlyCpi as Array<{ date: string; value: number }>);
      // Derived chart series (close/open/trade arrays, synthetic scales, underlying index series)
      // are recomputed on the client after snapshot hydration to keep the snapshot JSON smaller.
      setClosePricesByEtfId({});
      setAdjustedClosePricesByEtfId({});
      setOpenPricesByEtfId({});
      setTradeClosePricesByEtfId({});
      setTradeOpenPricesByEtfId({});
      setSyntheticPriceScaleByEtfId({});
      setDatesByEtfId({});
      setUnderlyingIndexSeries([]);
      if (snapshot.expandedSmaCharts) setExpandedSmaCharts(snapshot.expandedSmaCharts as string[]);
      if (snapshot.smaMode != null) setSmaMode(snapshot.smaMode as number);
      applyRunSummaryFromSnapshot(snapshot);
      save(snapshot as BacktestingSnapshotState);
    },
    [applyRunSummaryFromSnapshot, save]
  );

  const snapshotRehydrateAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!result) return;
    if (loading) return;
    // If we already have derived series, don't recompute.
    if (Object.keys(closePricesByEtfId).length > 0) return;

    snapshotRehydrateAbortRef.current?.abort();
    const controller = new AbortController();
    snapshotRehydrateAbortRef.current = controller;
    const signal = controller.signal;

    (async () => {
      try {
        const primaryIndex: IndexKey = resolvedEtfConfigs[0]?.smaIndex ?? index;
        const requiredIndexes = Array.from(new Set(resolvedEtfConfigs.map((cfg) => cfg.smaIndex))) as IndexKey[];
        if (requiredIndexes.length === 0) requiredIndexes.push(primaryIndex);

        const displayStartDate = startDate;
        const maxSmaWarmUp = Math.max(0, ...resolvedEtfConfigs.map((cfg) => (cfg.smaEnabled ? cfg.smaPeriod : 0)));
        const expandedStartDate = getMarketDataWarmUpStartDate(displayStartDate, maxSmaWarmUp);

        const priceResults = await Promise.all(
          requiredIndexes.map(async (idx) => {
            const idxMin = INDEX_DATE_RANGES[idx]?.min ?? displayStartDate;
            const fetchStartDate = expandedStartDate < idxMin ? idxMin : expandedStartDate;
            const res = await fetchJsonCached<Array<PricePoint | { date: string; adj_close?: number; close?: number }>>(
              `/api/prices?index=${idx}&startDate=${fetchStartDate}&endDate=${endDate}`,
              signal
            );
            if (!res.ok) return [idx, [] as PricePoint[]] as const;
            const prices = validateSimulationReadyPrices(
              idx,
              res.data ?? [],
              endDate
            );
            return [idx, prices] as const;
          })
        );
        const pricesByIndex = Object.fromEntries(priceResults) as Record<IndexKey, PricePoint[]>;
        const availableIndexes = requiredIndexes.filter((idx) => (pricesByIndex[idx]?.length ?? 0) >= 2);
        if (availableIndexes.length === 0) return;

        const effectivePrimaryIndex: IndexKey =
          (pricesByIndex[primaryIndex]?.length ?? 0) >= 2 ? primaryIndex : availableIndexes[0]!;

        const effectiveConfigs = resolvedEtfConfigs.filter((cfg) => (pricesByIndex[cfg.smaIndex]?.length ?? 0) >= 2);
        if (effectiveConfigs.length === 0) return;

        const ratesRes = await fetchJsonCached<RatePoint[]>(
          `/api/interest-rates?startDate=${expandedStartDate}&endDate=${endDate}`,
          signal
        );
        if (!ratesRes.ok) return;
        const rates = ratesRes.data ?? [];
        if (rates.length === 0) return;

        const riskOffAssets = Array.from(new Set(effectiveConfigs.flatMap((cfg) => getRiskOffFetchTickers(cfg.riskOffAsset))));
        const riskOffSeriesByAsset: Partial<Record<RiskOffAsset, PricePoint[]>> = {};
        if (riskOffAssets.length > 0 && smaMode !== 0) {
          const rawRiskOffSeriesByAsset = await loadAllRiskOffPricePoints(riskOffAssets, signal, undefined, {
            startDate: expandedStartDate,
            endDate,
          });
          for (const [asset, points] of Object.entries(rawRiskOffSeriesByAsset)) {
            if (!points || points.length === 0) continue;
            riskOffSeriesByAsset[asset as RiskOffAsset] = points;
          }
        }
        setRiskOffPricesByTicker(Object.fromEntries(Object.entries(riskOffSeriesByAsset).filter(([, v]) => (v?.length ?? 0) > 0)));

        // Fetch ETF prices for anchoring synthetic price series (same as UI run path).
        const historicalEtfSymbols = new Set<string>();
        for (const cfg of effectiveConfigs) {
          if (cfg.simulated) historicalEtfSymbols.add(cfg.name.replace(/-real$/, ""));
          else historicalEtfSymbols.add(cfg.name.replace(/-real$/, ""));
        }
        const etfRows =
          historicalEtfSymbols.size > 0
            ? await Promise.all(
                Array.from(historicalEtfSymbols).map(async (symbol) => {
                  const res = await fetchJsonCached<PricePoint[]>(
                    `/api/etf-prices?symbol=${encodeURIComponent(symbol)}&startDate=${expandedStartDate}&endDate=${endDate}`,
                    signal
                  );
                  if (!res.ok) return [symbol, [] as PricePoint[]] as const;
                  return [symbol, res.data ?? []] as const;
                })
              )
            : [];
        const etfPricePointsByName = Object.fromEntries(
          etfRows.filter(([, points]) => points.length > 0).map(([symbol, points]) => [symbol, points])
        ) as Record<string, PricePoint[]>;

        const {
          closePricesByEtfId: nextClosePricesByEtfId,
          adjustedClosePricesByEtfId: nextAdjustedClosePricesByEtfId,
          openPricesByEtfId: nextOpenPricesByEtfId,
          tradeClosePricesByEtfId: nextTradeClosePricesByEtfId,
          tradeOpenPricesByEtfId: nextTradeOpenPricesByEtfId,
          syntheticPriceScaleByEtfId: nextSyntheticPriceScaleByEtfId,
          datesByEtfId: nextDatesByEtfId,
          underlyingIndexSeries: nextUnderlyingIndexSeries,
        } = buildBacktestChartSeries({
          pricesByIndex,
          requiredIndexes: availableIndexes,
          primaryIndex: effectivePrimaryIndex,
          resolvedEtfConfigs: effectiveConfigs,
          result,
          initialInvestment: CONSTANT_INITIAL_INVESTMENT,
          etfPricePointsByName,
          rates,
        });

        if (signal.aborted) return;
        setClosePricesByEtfId(nextClosePricesByEtfId);
        setAdjustedClosePricesByEtfId(nextAdjustedClosePricesByEtfId);
        setOpenPricesByEtfId(nextOpenPricesByEtfId);
        setTradeClosePricesByEtfId(nextTradeClosePricesByEtfId);
        setTradeOpenPricesByEtfId(nextTradeOpenPricesByEtfId);
        setSyntheticPriceScaleByEtfId(nextSyntheticPriceScaleByEtfId);
        setDatesByEtfId(nextDatesByEtfId);
        if (smaMode !== 0) {
          setUnderlyingIndexSeries(nextUnderlyingIndexSeries);
        }
      } catch (e) {
        // Ignore: snapshot can still render main ValueChart from result.dailyValues.
        console.warn("[backtest] snapshot chart rehydrate failed:", e);
      }
    })();
  }, [
    result,
    resolvedEtfConfigs,
    startDate,
    endDate,
    index,
    smaMode,
    loading,
    closePricesByEtfId,
    setRiskOffPricesByTicker,
  ]);

  useToolSnapshot({
    pageKey: "backtesting",
    shouldHydrate: shouldHydrateSnapshot,
    onSnapshot: applyBacktestSnapshot,
    onNoData: () => setPendingRun(true),
    // Backtesting does not persist `result` to avoid quota issues, so we always
    // fall back to the server snapshot — no localStorage results to restore.
    hasPersistedResults: () => false,
  });

  useEffect(() => {
    if (!initialized) return;
    if (skipNextPresetEffectRef.current) {
      skipNextPresetEffectRef.current = false;
      return;
    }

    const validPreset = getValidPresetKey(letf, DEFAULT_COMBO_PRESET);

    if (isComboPreset(validPreset)) {
      const comboConfigs = buildPresetConfigs(validPreset);
      setIndex(comboConfigs[0]?.smaIndex ?? "sp500");
      return;
    }

    setIndex(ETF_PRESETS[validPreset]?.index ?? "sp500");
  }, [letf, initialized, setIndex]);

  useEffect(() => {
    if (!result) {
      if (expandedSmaCharts.length > 0) {
        Promise.resolve().then(() => {
          setExpandedSmaCharts([]);
        });
      }
      return;
    }
    const validIds = new Set(result.etfResults.map((etf) => etf.id));
    Promise.resolve().then(() => {
      setExpandedSmaCharts((current) => {
        const next = current.filter((id) => validIds.has(id));
        return next.length === current.length ? current : next;
      });
    });
  }, [result, expandedSmaCharts.length]);

  const updateUrl = useCallback(() => {
    const urlParams = new URLSearchParams();
    urlParams.set("letf", getValidPresetKey(letf, DEFAULT_COMBO_PRESET));
    urlParams.set("sd", startDate);
    urlParams.set("ed", endDate);

    // Always include SMA params so the URL is shareable
    urlParams.set("smaPsp", String(smaSpPeriod));
    urlParams.set("smaPnq", String(smaNqPeriod));
    urlParams.set("smatsp", String(smaSpUpperBuffer));
    urlParams.set("smatnq", String(smaNqUpperBuffer));
    urlParams.set("ro", riskOffAsset);
    if (smaMode === 0) urlParams.set("sma", "0");

    // Add etfConfigs as additional cards
    etfConfigs.forEach((cfg, i) => {
      const prefix = `e${i}`;
      urlParams.set(`${prefix}_n`, cfg.name);
    });

    markNextSearchAsInternal();
    router.push(buildToolsUrl("backtest", urlParams));
  }, [letf, startDate, endDate, smaMode, smaSpPeriod, smaNqPeriod, smaSpUpperBuffer, smaNqUpperBuffer, riskOffAsset, etfConfigs, router, markNextSearchAsInternal]);

  const handleCancel = useCallback(() => {
    abortControllerRef.current?.abort();
    setLoading(false);
    setRunProgress(null);
  }, [setRunProgress]);

  const toggleSmaChart = useCallback((etfId: string) => {
    setExpandedSmaCharts((current) =>
      current.includes(etfId)
        ? current.filter((id) => id !== etfId)
        : [...current, etfId]
    );
  }, []);

  const handleRun = useCallback(async () => {
    setLoading(true);
    setError(null);
    setRunProgress({ pct: 5, label: "Loading market data..." });
    toast.dismiss();
    setUnderlyingIndexSeries([]);
    updateUrl();

    // Abort any existing run
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const signal = controller.signal;

    try {
      const primaryIndex: IndexKey = resolvedEtfConfigs[0]?.smaIndex ?? index;
      const requiredIndexes = Array.from(
        new Set([
          ...(resolvedEtfConfigs.map((cfg) => cfg.smaIndex) as IndexKey[]),
        ])
      ) as IndexKey[];
      if (requiredIndexes.length === 0) requiredIndexes.push(primaryIndex);

      const displayStartDate = startDate;

      const maxSmaWarmUp = Math.max(0, ...resolvedEtfConfigs.map((cfg) => (cfg.smaEnabled ? cfg.smaPeriod : 0)));
      const expandedStartDate = getMarketDataWarmUpStartDate(displayStartDate, maxSmaWarmUp);

      const priceResults = await Promise.all(
        requiredIndexes.map(async (idx) => {
          const idxMin = INDEX_DATE_RANGES[idx]?.min ?? displayStartDate;
          const fetchStartDate = expandedStartDate < idxMin ? idxMin : expandedStartDate;
          const res = await fetchJsonCached<Array<PricePoint | { date: string; adj_close?: number; close?: number }>>(
            `/api/prices?index=${idx}&startDate=${fetchStartDate}&endDate=${endDate}`,
            signal
          );
          if (!res.ok) {
            // Degrade gracefully: if an index is missing (e.g. nasdaq100), skip those configs.
            const payload = (res.data ?? {}) as { error?: string };
            const detail = payload.error ?? res.statusText;
            console.warn("[backtest] missing index prices:", idx, detail);
            return [idx, [] as PricePoint[]] as const;
          }
          const prices = validateSimulationReadyPrices(
            idx,
            res.data ?? [],
            endDate
          );
          setRunProgress({
            pct: 10 + ((requiredIndexes.indexOf(idx) + 1) / requiredIndexes.length) * 10,
            label: `Loaded ${idx === "sp500" ? LABEL_INDEX_SP500_TR : LABEL_INDEX_NASDAQ100_TR} prices`,
          });
          return [idx, prices] as const;
        })
      );
      setRunProgress({ pct: 25, label: "Loading rates and inflation..." });
      const pricesByIndex = Object.fromEntries(priceResults) as Record<
        IndexKey,
        PricePoint[]
      >;
      const availableIndexes = requiredIndexes.filter((idx) => (pricesByIndex[idx]?.length ?? 0) >= 2);
      if (availableIndexes.length === 0) {
        throw new Error("No price data available yet. Please try again shortly after ingestion completes.");
      }

      const effectivePrimaryIndex: IndexKey =
        (pricesByIndex[primaryIndex]?.length ?? 0) >= 2
          ? primaryIndex
          : availableIndexes[0];

      const effectiveConfigs = resolvedEtfConfigs.filter(
        (cfg) => (pricesByIndex[cfg.smaIndex]?.length ?? 0) >= 2
      );
      if (effectiveConfigs.length === 0) {
        throw new Error("No ETF configs can be simulated with the available price data.");
      }

      const basePricesForAlignment =
        pricesByIndex[effectivePrimaryIndex] ?? pricesByIndex[availableIndexes[0]];

      // Fetch rates and inflation in parallel
      const [ratesRes, inflationRes] = await Promise.all([
        fetchJsonCached<RatePoint[]>(`/api/interest-rates?startDate=${expandedStartDate}&endDate=${endDate}`, signal),
        fetchJsonCached<{ annualizedInflation: number; monthlyCpi: Array<{ date: string; value: number }> }>(`/api/inflation?startDate=${startDate}&endDate=${endDate}`, signal),
      ]);
      if (!ratesRes.ok) {
        const payload = (ratesRes.data ?? {}) as { error?: string };
        throw new Error(payload.error ?? "Failed to load interest rate data");
      }
      const rates = ratesRes.data ?? [];
      let inflationWarning = false;
      const inflationData = inflationRes.ok
        ? (inflationRes.data ?? { annualizedInflation: 0, monthlyCpi: [] })
        : (() => { inflationWarning = true; return { annualizedInflation: 0, monthlyCpi: [] as Array<{ date: string; value: number }> }; })();
      // Compute inflation client-side using the same function as all other pages,
      // falling back to the API's pre-computed value if monthlyCpi is unavailable.
      const computedInflation = inflationData.monthlyCpi.length >= 2
        ? annualizedInflationForRange(inflationData.monthlyCpi, displayStartDate, endDate)
        : inflationData.annualizedInflation;
      setAnnualizedInflation(computedInflation);
      setMonthlyCpi(inflationData.monthlyCpi);
      if (!basePricesForAlignment || basePricesForAlignment.length < 2) {
        throw new Error(
          "No price data available yet. Please try again shortly after ingestion completes."
        );
      }
      if (rates.length === 0) {
        throw new Error(
          "No interest-rate data available yet. Please try again shortly."
        );
      }

      const riskOffAssets = Array.from(
        new Set(
          effectiveConfigs
            .flatMap((cfg) => getRiskOffFetchTickers(cfg.riskOffAsset))
        )
      );
      // Keep raw PricePoint[] so each index group can align them to its own date range.
      const riskOffSeriesByAsset: Partial<Record<RiskOffAsset, PricePoint[]>> = {};
      if (riskOffAssets.length > 0 && smaMode !== 0) {
        setRunProgress({ pct: 40, label: "Loading risk-off prices..." });
        const rawRiskOffSeriesByAsset = await loadAllRiskOffPricePoints(riskOffAssets, signal, ({ completed, total, label }) => {
          setRunProgress({ pct: 40 + (completed / total) * 12, label });
        }, {
          startDate: expandedStartDate,
          endDate,
        });
        for (const [asset, points] of Object.entries(rawRiskOffSeriesByAsset)) {
          if (!points || points.length === 0) continue;
          riskOffSeriesByAsset[asset as RiskOffAsset] = points;
        }
      }

      // Store raw risk-off price series for SMA chart trade table
      const riskOffByTicker: Record<string, PricePoint[]> = {};
      for (const [asset, points] of Object.entries(riskOffSeriesByAsset)) {
        if (points && points.length > 0) riskOffByTicker[asset] = points;
      }
      setRiskOffPricesByTicker(riskOffByTicker);

      // Fetch historical ETF prices for non-simulated configs
      // Also fetch for simulated configs whose real ETF exists by the end date
      // (used to anchor synthetic prices to real prices in the SMA chart)
      const historicalEtfSymbols = new Set(
        effectiveConfigs
          .filter((cfg) => !cfg.simulated)
          .map((cfg) => cfg.name.replace(/-real$/, ""))
      );
      for (const cfg of effectiveConfigs) {
        if (cfg.simulated) {
          // Always fetch real ETF prices for anchoring synthetic trade prices.
          // Without anchoring, the trade table shows raw portfolio values ($M)
          // instead of realistic ETF prices (~$120).
          historicalEtfSymbols.add(cfg.name);
        }
      }
      const historicalEtfRequests = Array.from(historicalEtfSymbols).map((symbol) => ({ symbol }));
      if (historicalEtfRequests.length > 0) {
        setRunProgress({ pct: 55, label: "Loading ETF price history..." });
      }
      const etfRows = historicalEtfRequests.length > 0
        ? await Promise.all(
            historicalEtfRequests.map(async ({ symbol }) => {
              const cfg = resolvedEtfConfigs.find((c) => c.name === symbol || c.name.replace(/-real$/, "") === symbol);
              const res = await fetchJsonCached<PricePoint[]>(
                `/api/etf-prices?symbol=${encodeURIComponent(
                  symbol
                )}&startDate=${expandedStartDate}&endDate=${endDate}`,
                signal
              );
              if (!res.ok) {
                // Simulated ETFs may not have real price data for this date range
                // (e.g. TQQQ before 2010). Return empty — anchor will gracefully skip.
                if (cfg?.simulated) return [symbol, [] as PricePoint[]] as const;
                const payload = (res.data ?? {}) as { error?: string };
                throw new Error(payload.error ?? `Failed to load ETF price data for ${symbol}`);
              }
              return [symbol, res.data ?? []] as const;
            })
          )
        : [];

      // Keep warm-up data in base prices so SMA computation is fully warmed up.
      // The simulation's startDate parameter controls the output range.
      const simulationBasePrices = basePricesForAlignment;

      // Compute effective start date based on when all risk-off components become tradable
      // on the aligned simulation date axis (not just raw series start dates).
      let effectiveStartDate = expandedStartDate;
      if (smaMode !== 0 && Object.keys(riskOffSeriesByAsset).length > 0) {
        const alignedCloseByTicker = Object.fromEntries(
          Object.entries(riskOffSeriesByAsset)
            .filter(([, points]) => (points?.length ?? 0) > 0)
            .map(([ticker, points]) => [ticker, alignCloseSeriesToDates(simulationBasePrices, points!)])
        ) as Record<string, number[]>;
        effectiveStartDate = effectiveStartDateFromAlignedSeries({
          requestedStartDate: expandedStartDate,
          dates: simulationBasePrices.map((p) => p.date),
          closeByTicker: alignedCloseByTicker,
        });
      }
      
      // Warn if effective start date is later than requested
      if (effectiveStartDate > displayStartDate) {
        const riskOffNames = Object.keys(riskOffSeriesByAsset).join(", ");
        const lateSources = [];
        if (riskOffNames) lateSources.push(`risk-off assets: ${riskOffNames}`);
        toast.warning(
          `Some assets don't have data before ${effectiveStartDate} (${lateSources.join(", ")}). ` +
          `Results will start from ${effectiveStartDate}.`,
          { duration: Infinity }
        );
      }
      
      const etfPricePointsByName = Object.fromEntries(
        etfRows
          .filter(([, points]) => points.length > 0)
          .map(([symbol, points]) => [symbol, points])
      ) as Record<string, PricePoint[]>;

      // Include warm-up period in rates for SMA warm-up
      const filteredRates = rates;

      // Simulate per (smaIndex) because SMA signals and simulated returns must use
      // the correct underlying index series (UPRO uses sp500, TQQQ uses nasdaq100).
      const configsBySmaIndex = new Map<IndexKey, EtfConfig[]>();
      for (const cfg of effectiveConfigs) {
        const key = cfg.smaIndex;
        const bucket = configsBySmaIndex.get(key) ?? [];
        bucket.push(cfg);
        configsBySmaIndex.set(key, bucket);
      }

      // Use parallelized backtest which uses workers for multiple configs.
      // Pass full price data (including warm-up) — the startDate parameter
      // controls where the output begins.
      const canonicalRun = await runParallelBacktest({
        prices: simulationBasePrices,
        rates: filteredRates,
        startDate: effectiveStartDate > displayStartDate ? effectiveStartDate : displayStartDate,
        endDate,
        configs: effectiveConfigs,
        riskOffPricesByAsset: riskOffSeriesByAsset,
        etfPricePointsByName,
        pricesByIndex,
        onProgress: (completedUnits, totalUnits, label) => {
          const fraction = totalUnits > 0 ? completedUnits / totalUnits : 0;
          const pct = 55 + Math.max(0, Math.min(1, fraction)) * 23;
          setRunProgress({
            pct,
            label: label ?? "Running simulations...",
          });
        },
      });

      if (signal.aborted) throw new Error("Aborted");
      setRunProgress({ pct: 80, label: "Preparing results..." });

      if (!canonicalRun || canonicalRun.dates.length < 2) {
        throw new Error("No backtest results produced.");
      }

      const datesSlice = canonicalRun.dates;
      const mergedEtfResults = canonicalRun.etfResults;
      const sortedEtfResults = sortEtfResultsByConfigOrder(mergedEtfResults, effectiveConfigs);

      const normalizedEtfResults = sortedEtfResults;
      const {
        closePricesByEtfId: nextClosePricesByEtfId,
        adjustedClosePricesByEtfId: nextAdjustedClosePricesByEtfId,
        openPricesByEtfId: nextOpenPricesByEtfId,
        tradeClosePricesByEtfId: nextTradeClosePricesByEtfId,
        tradeOpenPricesByEtfId: nextTradeOpenPricesByEtfId,
        syntheticPriceScaleByEtfId: nextSyntheticPriceScaleByEtfId,
        datesByEtfId: nextDatesByEtfId,
        underlyingIndexSeries: nextUnderlyingIndexSeries
      } =
        buildBacktestChartSeries({
          pricesByIndex,
          requiredIndexes: availableIndexes,
          primaryIndex: effectivePrimaryIndex,
          resolvedEtfConfigs: effectiveConfigs,
          result: {
            dates: datesSlice,
            nonLeveragedValues: canonicalRun.nonLeveragedValues,
            investedValues: canonicalRun.investedValues,
            etfResults: normalizedEtfResults,
          },
          initialInvestment,
          etfPricePointsByName,
          rates: filteredRates,
        });

      if (smaMode !== 0) {
        setUnderlyingIndexSeries(nextUnderlyingIndexSeries);
      }

      setClosePricesByEtfId(nextClosePricesByEtfId);
      setAdjustedClosePricesByEtfId(nextAdjustedClosePricesByEtfId);
      setOpenPricesByEtfId(nextOpenPricesByEtfId);
      setTradeClosePricesByEtfId(nextTradeClosePricesByEtfId);
      setTradeOpenPricesByEtfId(nextTradeOpenPricesByEtfId);
      setSyntheticPriceScaleByEtfId(nextSyntheticPriceScaleByEtfId);
      setDatesByEtfId(nextDatesByEtfId);

      setResult({
        dates: datesSlice,
        nonLeveragedValues: canonicalRun.nonLeveragedValues,
        investedValues: canonicalRun.investedValues,
        etfResults: normalizedEtfResults,
      });

      const effectiveStart = startDate;
      const resultEndDate = datesSlice[datesSlice.length - 1] ?? endDate;
      const nextRunSummary = buildRunSummary({
        startDate: effectiveStart,
        endDate: resultEndDate,
        letf: getValidPresetKey(letf, DEFAULT_COMBO_PRESET),
        windowLength,
        smaSpPeriod,
        smaSpUpperBuffer, smaSpLowerBuffer,
        smaNqPeriod,
        smaNqUpperBuffer, smaNqLowerBuffer,
        riskOffAsset,
      });
      setRunSummary(nextRunSummary);

      save({
        letf,
        index,
        startDate: effectiveStart,
        endDate,
        windowLength,
        smaSpPeriod,
        smaNqPeriod,
        smaSpUpperBuffer, smaSpLowerBuffer, smaNqUpperBuffer, smaNqLowerBuffer,
        riskOffAsset,
        etfConfigs,
        result: {
          dates: datesSlice,
          nonLeveragedValues: canonicalRun.nonLeveragedValues,
          investedValues: canonicalRun.investedValues,
          etfResults: normalizedEtfResults,
        },
        annualizedInflation: inflationData.annualizedInflation,
        monthlyCpi: inflationData.monthlyCpi,
        closePricesByEtfId: nextClosePricesByEtfId,
        adjustedClosePricesByEtfId: nextAdjustedClosePricesByEtfId,
        openPricesByEtfId: nextOpenPricesByEtfId,
        tradeClosePricesByEtfId: nextTradeClosePricesByEtfId,
        tradeOpenPricesByEtfId: nextTradeOpenPricesByEtfId,
        syntheticPriceScaleByEtfId: nextSyntheticPriceScaleByEtfId,
        datesByEtfId: nextDatesByEtfId,
        riskOffPricesByTicker: riskOffByTicker,
        underlyingIndexSeries: nextUnderlyingIndexSeries,
        expandedSmaCharts,
        smaMode,
        runSummaryInputs: nextRunSummary,
      });

      // Validate results and show warnings via toast
      if (inflationWarning) {
        toast.warning("Inflation data unavailable — Real CAGR may be inaccurate.", { duration: Infinity });
      }
      for (const etf of normalizedEtfResults) {
        if (!isFinite(etf.cagr)) {
          toast.warning(`${etf.id}: CAGR is non-finite — results may be unreliable.`, { duration: Infinity });
        }
        if (!isFinite(etf.finalValue) || etf.finalValue <= 0) {
          toast.warning(`${etf.id}: Final value is ${etf.finalValue} — check input data.`, { duration: Infinity });
        }
        if (etf.dailyValues.some((v) => !isFinite(v))) {
          toast.warning(`${etf.id}: NaN/Infinity detected in daily values.`, { duration: Infinity });
        }
        if (Math.abs(etf.cagr) > 500) {
          toast.warning(`${etf.id}: CAGR of ${etf.cagr.toFixed(1)}% seems unusually large.`, { duration: Infinity });
        }
      }
      if (datesSlice.length < 10) {
        toast.warning("Very short time period — metrics may not be statistically meaningful.", { duration: Infinity });
      }
      setError(null);
      setRunProgress({ pct: 100, label: "Done" });

      if (normalizedEtfResults.length > 0) {
        const historyParams = new URLSearchParams();
        historyParams.set("letf", getValidPresetKey(letf, DEFAULT_COMBO_PRESET));
        historyParams.set("sd", effectiveStart);
        historyParams.set("ed", endDate);
        historyParams.set("smaPsp", String(smaSpPeriod));
        historyParams.set("smaPnq", String(smaNqPeriod));
        historyParams.set("smatsp", String(smaSpUpperBuffer));
        historyParams.set("smatnq", String(smaNqUpperBuffer));
        historyParams.set("ro", riskOffAsset);
        if (smaMode === 0) historyParams.set("sma", "0");
        etfConfigs.forEach((cfg, i) => {
          historyParams.set(`e${i}_n`, cfg.name);
        });
        recordSuccessfulToolRun({
          tab: "backtest",
          tabLabel: "Backtest",
          href: buildToolsUrl("backtest", historyParams),
          summary: {
            startDate: effectiveStart,
            endDate,
            windowLength: windowLength,
            smaSpPeriod,
            smaSpUpperBuffer, smaSpLowerBuffer,
            smaNqPeriod,
            smaNqUpperBuffer, smaNqLowerBuffer,
            letf: getValidPresetKey(letf, DEFAULT_COMBO_PRESET),
            riskOffAsset,
            tradeAfterHours: false,
            } satisfies RunSummary,
        });
      }

    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return;
      }
      console.error("Backtest failed:", error);
      setResult(null);
      clearRunSummary();
      setError(error instanceof Error ? error.message : "Backtest failed");
      setUnderlyingIndexSeries([]);
    } finally {
      if (abortControllerRef.current === controller) {
        setLoading(false);
        setRunProgress(null);
        abortControllerRef.current = null;
      }
    }
  }, [
    clearRunSummary,
    endDate,
    etfConfigs,
    expandedSmaCharts,
    index,
    initialInvestment,
    letf,
    resolvedEtfConfigs,
    riskOffAsset,
    save,
    setRunSummary,
    smaNqUpperBuffer, smaNqLowerBuffer,
    smaNqPeriod,
    smaSpUpperBuffer, smaSpLowerBuffer,
    smaSpPeriod,
    smaMode,
    startDate,
    updateUrl,
    windowLength,
    setRunProgress,
  ]);

  // Auto-run backtest when pendingRun is set (e.g. from URL params or button click).
  // No `!loading` guard: handleRun aborts any in-flight controller, and onRun pre-sets
  // `loading` so the button flips to "Cancel" before the heavy render runs.
  useEffect(() => {
    if (pendingRun && initialized) {
      Promise.resolve().then(() => {
        setPendingRun(false);
        handleRun();
      });
    }
  }, [pendingRun, initialized, handleRun]);

  const addEtf = () => {
    setEtfConfigs([...etfConfigs, createDefaultEtfConfig(`etf${resolvedEtfConfigs.length + 1}`)]);
  };

  const removeEtf = (i: number) => {
    setEtfConfigs(etfConfigs.filter((_, idx) => idx !== i));
  };

  const removeAllEtfs = () => {
    setEtfConfigs([]);
  };

  const updateEtf = (i: number, config: EtfConfig) => {
    const updated = [...etfConfigs];
    updated[i] = config;
    setEtfConfigs(updated);
  };

  const dateRange = {
    min: INDEX_DATE_RANGES.sp500.min < INDEX_DATE_RANGES.nasdaq100.min ? INDEX_DATE_RANGES.sp500.min : INDEX_DATE_RANGES.nasdaq100.min,
    max: INDEX_DATE_RANGES.sp500.max < INDEX_DATE_RANGES.nasdaq100.max ? INDEX_DATE_RANGES.sp500.max : INDEX_DATE_RANGES.nasdaq100.max,
  };

  const displayResult = result;

  const handleCheckSimulations = useCallback(() => {
    setSmaMode(0);
    setEndDate(getIsoDate(new Date()));
    setLetf("UPRO+TQQQ");

    // Base preset provides UPRO + TQQQ; extra cards add the remaining comparisons.
    const etfs = [
      { name: "QLD", leverage: 2, expenseRatio: 0.95, simulated: true, smaIndex: "nasdaq100" as IndexKey },
      { name: "SSO", leverage: 2, expenseRatio: 0.91, simulated: true, smaIndex: "sp500" as IndexKey },
      { name: "UPRO-real", leverage: 3, expenseRatio: 0.91, simulated: false, smaIndex: "sp500" as IndexKey },
      { name: "TQQQ-real", leverage: 3, expenseRatio: 0.88, simulated: false, smaIndex: "nasdaq100" as IndexKey },
      { name: "QLD-real", leverage: 2, expenseRatio: 0.95, simulated: false, smaIndex: "nasdaq100" as IndexKey },
      { name: "SSO-real", leverage: 2, expenseRatio: 0.91, simulated: false, smaIndex: "sp500" as IndexKey },
    ];

    const nextEtfConfigs = etfs.map((etf, i) => ({
      id: `etf${i + 1}`,
      ...etf,
      smaEnabled: false,
      smaPeriod: 0,
      smaUpperBuffer: 0, smaLowerBuffer: 0,
      riskOffAsset: DEFAULT_RISK_OFF_ASSET,
    }));

    const launchAnchoredConfigs = nextEtfConfigs.filter((config) => !config.simulated);
    const earliestStartDate = (launchAnchoredConfigs.length > 0 ? launchAnchoredConfigs : nextEtfConfigs).reduce((earliest, config) => {
      const configStartDate = getLaunchDateForPresetName(config.name, etfLaunchDates)
        || getConfigDefaultStartDate(config);
      return configStartDate < earliest ? configStartDate : earliest;
    }, (launchAnchoredConfigs[0] ?? nextEtfConfigs[0])
      ? (getLaunchDateForPresetName((launchAnchoredConfigs[0] ?? nextEtfConfigs[0])!.name, etfLaunchDates)
        || getConfigDefaultStartDate((launchAnchoredConfigs[0] ?? nextEtfConfigs[0])!))
      : dateRange.min);

    setStartDate(earliestStartDate);
    setEtfConfigs(nextEtfConfigs);

    setPendingRun(true);
  }, [dateRange.min, etfLaunchDates, setEndDate, setLetf, setStartDate]);
  // Allow start dates earlier than launch date, but warn users if data won't be available
  const effectiveMinDate = dateRange.min;

  return (
    <>
      <RunSpinnerOverlay active={loading} label={runProgress?.label} pct={runProgress?.pct} />
      <div className="min-h-screen bg-background text-foreground p-3 md:p-6" suppressHydrationWarning>
      <div className="max-w-7xl mx-auto space-y-4 md:space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl md:text-4xl font-bold">Backtest</h1>
          <Button onClick={handleCheckSimulations} disabled={loading} variant="secondary">
            Check Simulations
          </Button>
        </div>

        <SharedToolInputs
          values={{
            letf,
            startDate,
            endDate,
            windowLength,
            smaSpPeriod,
            smaNqPeriod,
            smaSpUpperBuffer, smaSpLowerBuffer, smaNqUpperBuffer, smaNqLowerBuffer,
            riskOffAsset,
          }}
          onChange={handleFieldChange}
          dateRange={{ min: effectiveMinDate, max: dateRange.max }}
          presetOptions={PRESET_SELECT_OPTIONS}
          onRun={() => {
            // Commit "loading" first so the button paints as "Cancel"…
            flushSync(() => { setLoading(true); });
            // …then yield to the browser so it can actually paint before the
            // heavier render triggered by setSmaMode/setPendingRun runs.
            requestAnimationFrame(() => {
              setSmaMode(1);
              setPendingRun(true);
            });
          }}
          onCancel={handleCancel}
          loading={loading}
          runLabel="Run Backtest"
          progress={runProgress}
          error={error}
          showRollingFields={false}
        />

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {etfConfigs.map((config, i) => (
            <EtfConfigCard
              key={config.id}
              config={config}
              index={i}
              onChange={(c) => updateEtf(i, c)}
              onRemove={() => removeEtf(i)}
              canRemove
            />
          ))}
          <button
            onClick={addEtf}
            className="flex flex-col items-center justify-center min-h-[120px] border-2 border-dashed border-card-border rounded-lg text-muted hover:text-foreground hover:border-foreground/50 transition-colors"
          >
            <span className="text-2xl font-light">+</span>
            <span className="text-sm">Add ETF</span>
          </button>
          {etfConfigs.length > 0 && (
            <Button
              onClick={removeAllEtfs}
              variant="secondary"
              className="h-10 self-center text-red-400 hover:text-red-300"
            >
              Remove All ETFs
            </Button>
          )}
        </div>

        {displayResult && display && (
          <SimulationRunSummary
            summary={display.summary}
            showWindow={false}
          />
        )}

        {/* Results */}
        {displayResult && (
          <div className="space-y-6">
            <ValueChart
              result={displayResult}
              annualizedInflation={annualizedInflation}
              monthlyCpi={monthlyCpi}
              underlyingIndexSeries={smaMode !== 0 ? underlyingIndexSeries : EMPTY_UNDERLYING_INDEX_SERIES}
            />
            <ResultsTable
              result={displayResult}
              indexLabel={resolvedEtfConfigs[0]?.smaIndex === "nasdaq100" ? LABEL_INDEX_NASDAQ100_TR : LABEL_INDEX_SP500_TR}
              annualizedInflation={annualizedInflation}
              monthlyCpi={monthlyCpi}
              underlyingIndexSeries={smaMode !== 0 ? underlyingIndexSeries : EMPTY_UNDERLYING_INDEX_SERIES}
              resultTableTestId="snapshot-tool-sweep-backtest"
            />
            {smaMode !== 0 && displayResult.etfResults
              .map((etf, i) => ({ etf, i }))
              .filter(({ etf }) => etf.smaPrices.length > 0)
              .map(({ etf, i }) => {
              const isExpanded = expandedSmaCharts.includes(etf.id);
              return (
                <div key={etf.id} className="rounded-lg border border-card-border bg-card-bg">
                  <button
                    type="button"
                    onClick={() => toggleSmaChart(etf.id)}
                    className="flex w-full items-center justify-between px-4 py-3 text-left text-sm transition-colors hover:bg-white/5"
                  >
                    <span className="font-medium text-foreground">{shortBacktestAssetLabel(etf.name)}</span>
                    <span className="text-xs text-muted">
                      {isExpanded ? "Hide SMA Details" : "Show SMA Details"}
                    </span>
                  </button>
                  {isExpanded && (
                    <div className="border-t border-card-border px-4 py-4">
                      <SmaChart
                        result={displayResult}
                        etfIndex={i}
                        etfDates={datesByEtfId[etf.id] ?? etf.dates}
                        closePrices={closePricesByEtfId[etf.id] ?? []}
                        adjustedClosePrices={adjustedClosePricesByEtfId[etf.id] ?? []}
                        openPrices={openPricesByEtfId[etf.id] ?? []}
                        tradeClosePrices={tradeClosePricesByEtfId[etf.id] ?? []}
                        tradeOpenPrices={tradeOpenPricesByEtfId[etf.id] ?? []}
                        syntheticPriceScale={syntheticPriceScaleByEtfId[etf.id] ?? 1}
                        etfConfigs={resolvedEtfConfigs}
                        annualizedInflation={annualizedInflation}
                        riskOffPricesByTicker={riskOffPricesByTicker}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
    </>
  );
}

function sortEtfResultsByConfigOrder(
  results: BacktestResult["etfResults"],
  configs: EtfConfig[]
) {
  const order = new Map(configs.map((c, i) => [c.id, i]));
  return [...results].sort((a, b) => {
    const aBase = baseId(a.id);
    const bBase = baseId(b.id);
    const aOrder = order.get(aBase) ?? Number.MAX_SAFE_INTEGER;
    const bOrder = order.get(bBase) ?? Number.MAX_SAFE_INTEGER;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return variantRank(a.id) - variantRank(b.id);
  });
}

function baseId(id: string): string {
  if (id.endsWith("-base")) return id.slice(0, -5);
  if (id.endsWith("-smaClose")) return id.slice(0, -6);
  if (id.endsWith("-sma")) return id.slice(0, -4);
  return id;
}

function variantRank(id: string): number {
  if (id.endsWith("-base")) return 0;
  if (id.endsWith("-sma")) return 1;
  if (id.endsWith("-smaClose")) return 2;
  return 0;
}
