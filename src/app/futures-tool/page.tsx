"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { flushSync } from "react-dom";
import { SharedToolInputs } from "@/components/tools/SharedToolInputs";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { RunSpinnerOverlay } from "@/components/ui/RunSpinnerOverlay";
import { appendSmaBufferUrlParams, parseSmaBufferUrlParams } from "@/lib/sma-buffer-url-params";
import { buildToolsUrl, shouldQueueToolAutorun } from "@/lib/tools-route";
import { useToolForm } from "@/lib/hooks/use-tool-form";
import { useToolSnapshot } from "@/lib/hooks/use-tool-snapshot";
import { useSearchSyncRunGuard } from "@/lib/hooks/use-search-sync-run-guard";
import { normalizeDateString, normalizeNumberValue, normalizeRiskOffAsset } from "@/lib/input-normalization";
import { CONSTANT_INITIAL_INVESTMENT, INDEX_DATE_RANGES } from "@/lib/constants";
import { DEFAULT_FUTURES_AMOUNT, DEFAULT_LEVERAGE_TOLERANCE_PCT } from "@/lib/simulation/defaults";
import type { BacktestResult, EtfResult, IndexKey, PricePoint, RatePoint } from "@/lib/simulation/types";
import {
  fetchLatestIndexPriceAnchors,
  fetchMarketData,
  getMarketDataWarmUpStartDate,
  loadAllRiskOffPricePoints,
} from "@/lib/fetch-market-data";
import { runParallelBacktest } from "@/lib/simulation/parallel";
import {
  buildEmulationEtfConfigs,
  buildFuturesLadderPlan,
  type SmaBandsByIndex,
} from "@/lib/simulation/futures-plan";
import { ValueChart } from "@/components/tools/backtest/ValueChart";
import { ResultsTable } from "@/components/tools/backtest/ResultsTable";
import { getRiskOffFetchTickers } from "@/lib/constants";
import { alignCloseSeriesToDates, alignOpenSeriesToDates, validateSimulationReadyPrices } from "@/lib/utils";
import {
  DEFAULT_FUTURES_ROLL_CALENDAR_DAYS_BEFORE_EXPIRY,
  type FuturesStrategyResult,
} from "@/lib/simulation/futures";
import { runParallelFuturesStrategies } from "@/lib/simulation/futures-parallel";
// (effective start-date helper is used by other pages; futures emulations start at requested sd)
import { FuturesSmaDetails } from "@/components/tools/futures/FuturesSmaDetails";
import { shortBacktestAssetLabel } from "@/lib/strategy-page-data";
import { SimulationRunSummary } from "@/components/tools/SimulationRunSummary";
import { buildRunSummary, type RunSummary } from "@/lib/run-summary";
import { useRunSummary } from "@/lib/hooks/use-run-summary-inputs";

const EMPTY_UNDERLYING_INDEX_SERIES: Array<{
  index: IndexKey;
  label: string;
  dates: string[];
  values: number[];
}> = [];

function getFuturesDefaultStartDate(endDate: string, minDate: string, maxDate: string): string {
  const end = normalizeDateString(endDate, maxDate);
  const d = new Date(`${end}T00:00:00Z`);
  if (!Number.isFinite(d.getTime())) return minDate;
  d.setUTCFullYear(d.getUTCFullYear() - 20);
  const candidate = d.toISOString().slice(0, 10);
  if (candidate < minDate) return minDate;
  if (candidate > maxDate) return maxDate;
  return candidate;
}

function scaleEtfResult(result: EtfResult, scale: number): EtfResult {
  if (!Number.isFinite(scale) || scale <= 0 || scale === 1) return result;
  return {
    ...result,
    dailyValues: result.dailyValues.map((value) => value * scale),
    finalValue: result.finalValue * scale,
    maxDrawdownDollar: result.maxDrawdownDollar * scale,
  };
}

function latestClosePrice(prices: PricePoint[]): number {
  for (let i = prices.length - 1; i >= 0; i--) {
    const price = prices[i];
    const close = price?.close ?? price?.adj_close;
    if (Number.isFinite(close) && (close as number) > 0) return close as number;
  }
  return NaN;
}

export default function FuturesPage() {
  return (
    <Suspense fallback={null}>
      <FuturesPageContent active />
    </Suspense>
  );
}

export function FuturesPageContent({
  active = true,
}: {
  active?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { markNextSearchAsInternal, shouldAutoRunFromSearch } = useSearchSyncRunGuard();

  const form = useToolForm("futures", {
    result: null as BacktestResult | null,
    annualizedInflation: 0,
    monthlyCpi: [] as Array<{ date: string; value: number }>,
    runSummaryInputs: null as RunSummary | null,
  }, {
    persistKeys: ["runSummaryInputs"],
  });

  const {
    startDate,
    endDate,
    windowLength,
    smaSpPeriod,
    smaNqPeriod,
    smaSpUpperBuffer, smaSpLowerBuffer, smaNqUpperBuffer, smaNqLowerBuffer,
    riskOffAsset,
    handleFieldChange,
    initial,
    save,
    restoredFromCache,
  } = form;

  const persistedInitial = initial as Record<string, unknown>;

  const [amount, setAmount] = useState<number>(
    normalizeNumberValue(persistedInitial.amount as number | undefined, DEFAULT_FUTURES_AMOUNT, { min: 0 })
  );
  const [result, setResult] = useState<BacktestResult | null>(
    (persistedInitial.result as BacktestResult | null) ?? null
  );
  const [annualizedInflation, setAnnualizedInflation] = useState<number>(
    (persistedInitial.annualizedInflation as number | undefined) ?? 0
  );
  const [monthlyCpi, setMonthlyCpi] = useState<Array<{ date: string; value: number }>>(
    (persistedInitial.monthlyCpi as Array<{ date: string; value: number }> | undefined) ?? []
  );
  const [leverageTolerancePct, setLeverageTolerancePct] = useState<number>(
    normalizeNumberValue(
      persistedInitial.leverageTolerancePct as number | undefined,
      DEFAULT_LEVERAGE_TOLERANCE_PCT,
      { min: 0 }
    )
  );
  const [showEmulations, setShowEmulations] = useState<boolean>(false);
  const [futuresDetails, setFuturesDetails] = useState<FuturesStrategyResult[] | null>(null);
  const [expandedFuturesSma, setExpandedFuturesSma] = useState<string[]>([]);
  const { runSummary, setRunSummary } = useRunSummary(
    (persistedInitial.runSummaryInputs as RunSummary | null) ?? null
  );

  const [loading, setLoading] = useState(false);
  const [runProgress, setRunProgress] = useState<{ pct: number; label: string } | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const lastHydratedSearchRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingRun, setPendingRun] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const hasCachedResults = Boolean(persistedInitial.result);
  const shouldHydrateSnapshot = !hasCachedResults && !restoredFromCache;
  const resultRef = useRef<BacktestResult | null>(result);
  useEffect(() => {
    resultRef.current = result;
  }, [result]);
  const avgActualLeverageById = useMemo(() => {
    const byId: Record<string, number> = {};
    for (const strategy of futuresDetails ?? []) {
      const v = strategy.avgActualLeverageRiskOn;
      if (Number.isFinite(v)) {
        byId[strategy.etfResult.id] = v as number;
      }
    }
    return byId;
  }, [futuresDetails]);

  const maxLeverageDeltaById = useMemo(() => {
    const byId: Record<string, number> = {};
    for (const strategy of futuresDetails ?? []) {
      const v = strategy.maxAbsLeverageDeltaRiskOnPct;
      if (Number.isFinite(v)) {
        byId[strategy.etfResult.id] = v;
      }
    }
    return byId;
  }, [futuresDetails]);

  const dateRange = useMemo(() => ({
    min: INDEX_DATE_RANGES.sp500.min,
    max: INDEX_DATE_RANGES.sp500.max < INDEX_DATE_RANGES.nasdaq100.max ? INDEX_DATE_RANGES.sp500.max : INDEX_DATE_RANGES.nasdaq100.max,
  }), []);

  // URL hydration: apply explicit query params without clobbering cached values when
  // a parameter is absent.
  const searchStr = searchParams.toString();
  useEffect(() => {
    if (lastHydratedSearchRef.current === searchStr) return;
    lastHydratedSearchRef.current = searchStr;
    const params = new URLSearchParams(searchStr);
    const sd = params.get("sd");
    let effectiveEndDate = endDate;
    if (sd != null && sd !== "") {
      const normalized = normalizeDateString(sd, dateRange.min);
      handleFieldChange("startDate", normalized < dateRange.min ? dateRange.min : normalized > dateRange.max ? dateRange.max : normalized);
    }
    const ed = params.get("ed");
    if (ed != null && ed !== "") {
      const normalized = normalizeDateString(ed, dateRange.max);
      effectiveEndDate =
        normalized < dateRange.min ? dateRange.min : normalized > dateRange.max ? dateRange.max : normalized;
      handleFieldChange("endDate", effectiveEndDate);
    }
    if ((sd == null || sd === "") && !hasCachedResults && !restoredFromCache) {
      handleFieldChange(
        "startDate",
        getFuturesDefaultStartDate(effectiveEndDate, dateRange.min, dateRange.max)
      );
    }
    const smaPsp = params.get("smaPsp");
    if (smaPsp != null && smaPsp !== "") {
      handleFieldChange("smaSpPeriod", normalizeNumberValue(Number(smaPsp), 186, { integer: true, min: 1 }));
    }
    const smaPnq = params.get("smaPnq");
    if (smaPnq != null && smaPnq !== "") {
      handleFieldChange("smaNqPeriod", normalizeNumberValue(Number(smaPnq), 150, { integer: true, min: 1 }));
    }
    const smaBuffers = parseSmaBufferUrlParams(params);
    if (smaBuffers.smaSpUpperBuffer != null) {
      handleFieldChange(
        "smaSpUpperBuffer",
        normalizeNumberValue(smaBuffers.smaSpUpperBuffer, 3.6, { min: 0 })
      );
    }
    if (smaBuffers.smaSpLowerBuffer != null) {
      handleFieldChange(
        "smaSpLowerBuffer",
        normalizeNumberValue(smaBuffers.smaSpLowerBuffer, 3.6, { min: 0 })
      );
    }
    if (smaBuffers.smaNqUpperBuffer != null) {
      handleFieldChange(
        "smaNqUpperBuffer",
        normalizeNumberValue(smaBuffers.smaNqUpperBuffer, 11.9, { min: 0 })
      );
    }
    if (smaBuffers.smaNqLowerBuffer != null) {
      handleFieldChange(
        "smaNqLowerBuffer",
        normalizeNumberValue(smaBuffers.smaNqLowerBuffer, 11.9, { min: 0 })
      );
    }
    const ro = params.get("ro");
    if (ro != null && ro !== "") {
      handleFieldChange("riskOffAsset", normalizeRiskOffAsset(ro));
    }
    const amt = params.get("amt");
    const nextAmount =
      amt != null && amt !== ""
        ? normalizeNumberValue(Number(amt), DEFAULT_FUTURES_AMOUNT, { min: 0 })
        : null;
    const lt = params.get("lt");
    const nextLeverageTolerance =
      lt != null && lt !== ""
        ? normalizeNumberValue(Number(lt), DEFAULT_LEVERAGE_TOLERANCE_PCT, { min: 0 })
        : null;
    const emParam = params.get("em");
    const wantsEmulations = emParam === "1" || emParam === "true";
    Promise.resolve().then(() => {
      if (nextAmount != null) setAmount(nextAmount);
      if (nextLeverageTolerance != null) setLeverageTolerancePct(nextLeverageTolerance);
      if (wantsEmulations) setShowEmulations(true);
      setPendingRun(
        active &&
          shouldQueueToolAutorun(
            params,
            {
              allowInitialSearchAutoRun: true,
              suppressAutoRun: false,
              shouldAutoRunFromSearch,
              hasCachedResults: Boolean(resultRef.current),
            },
            pathname
          )
      );
      setInitialized(true);
    });
  }, [
    active,
    dateRange.max,
    dateRange.min,
    endDate,
    handleFieldChange,
    hasCachedResults,
    pathname,
    restoredFromCache,
    searchStr,
    shouldAutoRunFromSearch,
  ]);

  const updateUrl = useCallback(() => {
    const params = new URLSearchParams();
    params.set("sd", startDate);
    params.set("ed", endDate);
    params.set("smaPsp", String(smaSpPeriod));
    params.set("smaPnq", String(smaNqPeriod));
    appendSmaBufferUrlParams(params, {
      smaSpUpperBuffer,
      smaSpLowerBuffer,
      smaNqUpperBuffer,
      smaNqLowerBuffer,
    });
    params.set("ro", riskOffAsset);
    params.set("amt", String(amount));
    params.set("lt", String(leverageTolerancePct));
    if (showEmulations) params.set("em", "1");

    markNextSearchAsInternal();
    router.push(buildToolsUrl("futures", params));
  }, [
    amount,
    endDate,
    leverageTolerancePct,
    markNextSearchAsInternal,
    riskOffAsset,
    router,
    showEmulations,
    smaNqUpperBuffer,
    smaNqLowerBuffer,
    smaNqPeriod,
    smaSpUpperBuffer,
    smaSpLowerBuffer,
    smaSpPeriod,
    startDate,
  ]);

  const displayResult = useMemo(() => {
    if (!result) return null;
    if (showEmulations) return result;
    return {
      ...result,
      etfResults: result.etfResults.filter((r) => r.id.includes("futures-sma")),
    };
  }, [result, showEmulations]);

  const handleCheckEmulations = useCallback(() => {
    flushSync(() => setLoading(true));
    requestAnimationFrame(() => {
      setShowEmulations(true);
      setPendingRun(true);
    });
  }, []);

  useToolSnapshot({
    pageKey: "futures",
    shouldHydrate: shouldHydrateSnapshot,
    onSnapshot: (state) => {
      const snapshot = state as Record<string, unknown>;
      setAmount(normalizeNumberValue(snapshot.amount as number, DEFAULT_FUTURES_AMOUNT, { min: 0 }));
      setLeverageTolerancePct(
        normalizeNumberValue(
          snapshot.leverageTolerancePct as number | undefined,
          DEFAULT_LEVERAGE_TOLERANCE_PCT,
          { min: 0 }
        )
      );
      if (snapshot.result) {
        setResult(snapshot.result as BacktestResult);
      } else {
        setPendingRun(true);
      }
      if (Array.isArray(snapshot.futuresDetails)) {
        setFuturesDetails(snapshot.futuresDetails as FuturesStrategyResult[]);
      }
      if (snapshot.annualizedInflation != null) {
        setAnnualizedInflation(snapshot.annualizedInflation as number);
      }
      if (Array.isArray(snapshot.monthlyCpi)) {
        setMonthlyCpi(snapshot.monthlyCpi as Array<{ date: string; value: number }>);
      }
      if (snapshot.runSummaryInputs) {
        setRunSummary(snapshot.runSummaryInputs as RunSummary);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      save(snapshot as any);
    },
    onNoData: () => setPendingRun(true),
    hasPersistedResults: (state) => Boolean(state.result),
  });

  const handleCancel = useCallback(() => {
    abortControllerRef.current?.abort();
    setLoading(false);
    setRunProgress(null);
  }, []);

  const handleRun = useCallback(async () => {
    setLoading(true);
    setError(null);
    setRunProgress({ pct: 5, label: "Loading market data..." });
    updateUrl();

    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const signal = controller.signal;

    try {
      if (!Number.isFinite(amount) || amount < 0) {
        throw new Error("Amount must be a non-negative number.");
      }

      const warmUpTradingDays = Math.max(280, smaSpPeriod, smaNqPeriod);
      const market = await fetchMarketData(
        ["sp500", "nasdaq100"],
        startDate,
        endDate,
        signal,
        ({ completed, total, label }) => {
          const fraction = total > 0 ? completed / total : 1;
          setRunProgress({ pct: 5 + fraction * 20, label });
        },
        { warmUpTradingDays, allowMissingPrices: true }
      );
      const rates = market.rates as RatePoint[];
      const pricesByIndex = market.pricesByIndex as Record<IndexKey, PricePoint[]>;
      setAnnualizedInflation(market.annualizedInflation);
      setMonthlyCpi(market.monthlyCpi);

      const spPrices = pricesByIndex.sp500 ?? [];
      const nqPrices = pricesByIndex.nasdaq100 ?? [];
      if (spPrices.length < 2) throw new Error("SPX price series unavailable.");
      const hasNqData = nqPrices.length >= 2;

      setRunProgress({ pct: 28, label: "Loading current futures fee anchors..." });
      const currentPriceAnchors = await fetchLatestIndexPriceAnchors(["sp500", "nasdaq100"], signal);
      const spPriceAnchor = currentPriceAnchors.sp500 ?? latestClosePrice(spPrices);
      const nqPriceAnchor = currentPriceAnchors.nasdaq100 ?? latestClosePrice(nqPrices);

      // Load risk-off series first (needed for futures SMA transaction details + LETF SMA).
      setRunProgress({ pct: 30, label: "Loading risk-off + ETF history..." });
      const warmUpStartDate = getMarketDataWarmUpStartDate(startDate, warmUpTradingDays);
      const riskOffTickers = getRiskOffFetchTickers(riskOffAsset);
      const rawRiskOffSeriesByAsset = await loadAllRiskOffPricePoints(riskOffTickers, signal, undefined, {
        startDate: warmUpStartDate,
        endDate,
      });

      // Use the same alignment as the backtest engine so monthly proxy series
      // (e.g. 1957-era GLDM/VGSH) get interpolated to daily — otherwise the futures
      // sim falls back to cash on most days and the curve looks flat in risk-off.
      const buildRiskOffAligned = (basePrices: PricePoint[]) => {
        const closeByTicker: Record<string, number[]> = {};
        const openByTicker: Record<string, number[]> = {};
        for (const t of riskOffTickers) {
          const series = rawRiskOffSeriesByAsset[t as keyof typeof rawRiskOffSeriesByAsset];
          if (!series || series.length === 0) {
            closeByTicker[t] = new Array(basePrices.length).fill(NaN);
            openByTicker[t] = new Array(basePrices.length).fill(NaN);
            continue;
          }
          closeByTicker[t] = alignCloseSeriesToDates(basePrices, series);
          openByTicker[t] = alignOpenSeriesToDates(basePrices, series);
        }
        return { closeByTicker, openByTicker };
      };

      // Futures strategies (close execution for futures; risk-off legs execute next-day-open).
      setRunProgress({ pct: 45, label: "Simulating futures strategies..." });
      const spInRange = spPrices.filter((p) => p.date >= startDate && p.date <= endDate);
      const nqInRange = nqPrices.filter((p) => p.date >= startDate && p.date <= endDate);
      const spRiskOffAligned = buildRiskOffAligned(spInRange);
      const nqRiskOffAligned = buildRiskOffAligned(nqInRange);

      // "Check Emulations" compares LETF SMAs to the nearest futures ladders only — skip 4.5×/4× SPX
      // and 4× NDX so we do not pay for extra sims; SPX futures line is 3× (not 4×).
      const yearSpan = (new Date(`${endDate}T00:00:00Z`).getTime() - new Date(`${startDate}T00:00:00Z`).getTime()) / (1000 * 60 * 60 * 24 * 365.25);
      // One band per index feeds both the ladders and their LETF twins below, so
      // the pair cannot disagree about its own SMA rule (see futures-plan.ts).
      const smaBands: SmaBandsByIndex = {
        sp500: { period: smaSpPeriod, upperBuffer: smaSpUpperBuffer, lowerBuffer: smaSpLowerBuffer },
        nasdaq100: { period: smaNqPeriod, upperBuffer: smaNqUpperBuffer, lowerBuffer: smaNqLowerBuffer },
      };
      const futuresPlan = buildFuturesLadderPlan({
        showEmulations,
        hasNasdaqData: hasNqData,
        yearSpan,
        bands: smaBands,
      });
      const futuresRuns = await runParallelFuturesStrategies({
        signal,
        plans: futuresPlan.map((step) => ({
          index: step.index,
          prices: step.index === "sp500" ? spPrices : nqPrices,
          rates,
          startDate,
          endDate,
          initialEquity: amount,
          targetLeverage: step.leverage,
          maxLeverage: step.maxLeverage,
          displayName: step.displayName,
          smaPeriod: step.sma.period,
          smaUpperBuffer: step.sma.upperBuffer, smaLowerBuffer: step.sma.lowerBuffer,
          riskOffAsset,
          riskOffCloseByTicker: step.index === "sp500" ? spRiskOffAligned.closeByTicker : nqRiskOffAligned.closeByTicker,
          riskOffOpenByTicker: step.index === "sp500" ? spRiskOffAligned.openByTicker : nqRiskOffAligned.openByTicker,
          leverageTolerancePct,
          rollCalendarDaysBeforeExpiry: DEFAULT_FUTURES_ROLL_CALENDAR_DAYS_BEFORE_EXPIRY,
          monthlyCpi: market.monthlyCpi,
          futuresPriceAnchor: step.index === "sp500" ? spPriceAnchor : nqPriceAnchor,
        })),
        onProgress: (completed, total) => {
          const fraction = total > 0 ? completed / total : 1;
          setRunProgress({ pct: 45 + fraction * 10, label: "Simulating futures strategies..." });
        },
      });
      let uproSma = null as BacktestResult["etfResults"][number] | null;
      let tqqqSma = null as BacktestResult["etfResults"][number] | null;
      let qldSma = null as BacktestResult["etfResults"][number] | null;
      if (showEmulations) {
        // Match `fetchMarketData` / futures SMA warm-up so NDX SMA state matches 3× NQ futures (not a shorter slice).
        const emulationWarmUpStartDate = getMarketDataWarmUpStartDate(startDate, warmUpTradingDays);
        const emulationPricesByIndex = {
          sp500: spPrices.filter((p) => p.date >= emulationWarmUpStartDate),
          nasdaq100: nqPrices.filter((p) => p.date >= emulationWarmUpStartDate),
        } satisfies Record<IndexKey, PricePoint[]>;
        // ETF SMA emulation series (simulated LETFs, not real ETF price history).
        // We intentionally do NOT fetch `/api/etf-prices` here; the emulation should be
        // purely index-based (plus swap/ER model), consistent across pages.

        const etfConfigs = buildEmulationEtfConfigs({
          hasNasdaqData: hasNqData,
          bands: smaBands,
          riskOffAsset,
        });

        // Keep "Check Emulations" on the same canonical path as the backtest page
        // so UPRO/TQQQ/QLD SMA rules, warm-up, risk-off alignment, and actual ETF
        // history handling cannot drift from the main backtest implementation.
        setRunProgress({ pct: 60, label: "Simulating LETF SMA series..." });
        const etfBacktest = await runParallelBacktest({
          prices: emulationPricesByIndex.sp500,
          rates,
          startDate,
          endDate,
          configs: etfConfigs,
          riskOffPricesByAsset: rawRiskOffSeriesByAsset,
          pricesByIndex: emulationPricesByIndex,
          onProgress: (completedUnits, totalUnits, label) => {
            const fraction = totalUnits > 0 ? completedUnits / totalUnits : 1;
            setRunProgress({ pct: 60 + fraction * 15, label: label ?? "Running LETF SMA..." });
          },
        });

        // Keep only SMA variants (drop "(No SMA)" baselines).
        const emulationScale = amount / CONSTANT_INITIAL_INVESTMENT;
        const etfSmaOnly = etfBacktest.etfResults
          .filter((r) => r.id.endsWith("-sma"))
          .map((r) => scaleEtfResult(r, emulationScale));
        const pickEtfSma = (symbol: string) =>
          etfSmaOnly.find((r) => r.name.toUpperCase().includes(symbol)) ?? null;
        uproSma = pickEtfSma("UPRO");
        tqqqSma = pickEtfSma("TQQQ");
        qldSma = pickEtfSma("QLD");
      }

      // Build a global date axis as the union of SP + NQ dates in range.
      const spDisplay = validateSimulationReadyPrices("sp500", spPrices, endDate).filter((p) => p.date >= startDate && p.date <= endDate);
      const nqDisplay = validateSimulationReadyPrices("nasdaq100", nqPrices, endDate).filter((p) => p.date >= startDate && p.date <= endDate);
      const dateSet = new Set<string>([...spDisplay.map((p) => p.date), ...nqDisplay.map((p) => p.date)]);
      const globalDates = Array.from(dateSet).sort((a, b) => a.localeCompare(b));

      // Unleveraged baseline: SP500 total return scaled to amount.
      const spAdjByDate = new Map(spDisplay.map((p) => [p.date, p.adj_close] as const));
      let lastAdj = spDisplay[0]?.adj_close ?? 1;
      const nonLeveragedValues = globalDates.map((d) => {
        const v = spAdjByDate.get(d);
        if (Number.isFinite(v ?? NaN) && (v as number) > 0) {
          lastAdj = v as number;
        }
        return lastAdj;
      });
      const baseAdj = nonLeveragedValues[0] ?? 1;
      const scaledNonLeveraged = nonLeveragedValues.map((v) => (baseAdj > 0 ? (v / baseAdj) * amount : amount));
      const investedValues = new Array(globalDates.length).fill(amount);

      const futuresOnlyResults = futuresRuns.map((r) => r.etfResult);
      const pickFutures = (index: "sp500" | "nasdaq100", leverage: number) =>
        futuresRuns.find(
          (r) =>
            r.index === index &&
            r.targetLeverage === leverage
        )?.etfResult ?? null;
      const sp5 = pickFutures("sp500", 5);
      const sp4 = pickFutures("sp500", 4);
      const sp3 = pickFutures("sp500", 3);
      const nq4 = pickFutures("nasdaq100", 4);
      const nq3 = pickFutures("nasdaq100", 3);
      const nq2 = pickFutures("nasdaq100", 2);
      const combined: BacktestResult = {
        dates: globalDates,
        nonLeveragedValues: scaledNonLeveraged,
        investedValues,
        etfResults: showEmulations
          ? [
              ...(sp5 ? [sp5] : []),
              ...(sp4 ? [sp4] : []),
              ...(sp3 ? [sp3] : []),
              ...(uproSma ? [uproSma] : []),
              ...(nq4 ? [nq4] : []),
              ...(nq3 ? [nq3] : []),
              ...(nq2 ? [nq2] : []),
              ...(tqqqSma ? [tqqqSma] : []),
              ...(qldSma ? [qldSma] : []),
            ]
          : futuresOnlyResults,
      };
      setResult(combined);
      setFuturesDetails(futuresRuns);
      const nextRunSummary = buildRunSummary({
        // Use the simulation's actual first day so the Run Summary header
        // can never disagree with the table rows / chart axis (the form's
        // `startDate` can be earlier than the data we actually had).
        startDate: combined.dates[0] ?? startDate,
        endDate: combined.dates[combined.dates.length - 1] ?? endDate,
        letf: "FUTURES",
        windowLength,
        smaSpPeriod,
        smaSpUpperBuffer, smaSpLowerBuffer,
        smaNqPeriod,
        smaNqUpperBuffer, smaNqLowerBuffer,
        riskOffAsset,
        amount,
        leverageTolerance: `${leverageTolerancePct}%`,
      });
      setRunSummary(nextRunSummary);

      save({
        startDate,
        endDate,
        windowLength,
        smaSpPeriod,
        smaNqPeriod,
        smaSpUpperBuffer, smaSpLowerBuffer, smaNqUpperBuffer, smaNqLowerBuffer,
        riskOffAsset,
        amount,
        result: combined,
        annualizedInflation: market.annualizedInflation,
        monthlyCpi: market.monthlyCpi,
        leverageTolerancePct,
        runSummaryInputs: nextRunSummary,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      setRunProgress({ pct: 100, label: "Done" });
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return;
      setError(e instanceof Error ? e.message : "Run failed");
      setResult(null);
      setFuturesDetails(null);
    } finally {
      setLoading(false);
      setRunProgress(null);
      abortControllerRef.current = null;
    }
  }, [
    amount,
    endDate,
    riskOffAsset,
    save,
    leverageTolerancePct,
    setRunSummary,
    showEmulations,
    smaNqUpperBuffer, smaNqLowerBuffer,
    smaNqPeriod,
    smaSpUpperBuffer, smaSpLowerBuffer,
    smaSpPeriod,
    startDate,
    updateUrl,
    windowLength,
  ]);

  useEffect(() => {
    if (pendingRun && initialized) {
      Promise.resolve().then(() => {
        setPendingRun(false);
        handleRun();
      });
    }
  }, [pendingRun, initialized, handleRun]);

  return (
    <>
      <RunSpinnerOverlay active={loading} label={runProgress?.label} pct={runProgress?.pct} />
      <div className="min-h-screen bg-background text-foreground p-3 md:p-6">
      <div className="max-w-7xl mx-auto space-y-4 md:space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl md:text-4xl font-bold">Futures</h1>
          <Button onClick={handleCheckEmulations} disabled={loading} variant="secondary">
            Check Emulations
          </Button>
        </div>

        <SharedToolInputs
          values={{
            startDate,
            endDate,
            windowLength,
            smaSpPeriod,
            smaNqPeriod,
            smaSpUpperBuffer, smaSpLowerBuffer, smaNqUpperBuffer, smaNqLowerBuffer,
            riskOffAsset,
          }}
          onChange={handleFieldChange}
          dateRange={{ min: dateRange.min, max: dateRange.max }}
          onRun={() => {
            flushSync(() => setLoading(true));
            requestAnimationFrame(() => {
              setShowEmulations(false);
              setPendingRun(true);
            });
          }}
          onCancel={handleCancel}
          loading={loading}
          runLabel="Run Futures"
          progress={runProgress}
          error={error}
          showRollingFields={false}
        >
          <Input
            label="Amount"
            info="Starting capital (USD). Futures positions are sized to target the selected leverage based on this equity."
            type="number"
            min={0}
            suffix="$"
            value={amount}
            onChange={(e) => setAmount(normalizeNumberValue(Number(e.currentTarget.value), amount, { min: 0 }))}
          />
          <Input
            label="Leverage Tolerance"
            info="Band around target: skip routine resizes while |leverage Δ| is within ±this %, and skip resizes that would improve |Δ| by less than this. When max leverage is set, the open-session leverage peel only starts if notional/equity exceeds max × (1 + this/100); sell sizing still targets ≤ max. Larger values trade less and reduce trim↔rebuy churn when max ≈ target."
            type="number"
            min={0}
            suffix="%"
            value={leverageTolerancePct}
            onChange={(e) =>
              setLeverageTolerancePct(
                normalizeNumberValue(Number(e.currentTarget.value), leverageTolerancePct, { min: 0 })
              )
            }
          />
        </SharedToolInputs>

        {displayResult && runSummary && (
          <SimulationRunSummary
            summary={runSummary}
            showLetf={false}
            showWindow={false}
          />
        )}

        {displayResult && (() => {
          return (
            <div className="space-y-6">
              <ValueChart
                result={displayResult}
                annualizedInflation={annualizedInflation}
                monthlyCpi={monthlyCpi}
                underlyingIndexSeries={EMPTY_UNDERLYING_INDEX_SERIES}
              />
              <ResultsTable
                result={displayResult}
                indexLabel="VOO"
                annualizedInflation={annualizedInflation}
                monthlyCpi={monthlyCpi}
                underlyingIndexSeries={EMPTY_UNDERLYING_INDEX_SERIES}
                resultTableTestId="snapshot-tool-sweep-futures"
                metricLinkTab="futures"
                avgActualLeverageById={avgActualLeverageById}
                maxLeverageDeltaById={maxLeverageDeltaById}
                variant="futures"
              />

              {futuresDetails && futuresDetails.length > 0 && (
                <div className="space-y-4">
                  <h2 className="text-lg font-semibold">Transactions</h2>
                  {(() => {
                    const transactionStrategies = futuresDetails
                      .filter((strategy) =>
                        (strategy.index === "sp500" &&
                            strategy.targetLeverage === (showEmulations ? 3 : 4.5)) ||
                          (strategy.index === "nasdaq100" && strategy.targetLeverage === 3)
                      )
                      .slice()
                      .sort((a, b) => {
                        const ia = a.index === "sp500" ? 0 : 1;
                        const ib = b.index === "sp500" ? 0 : 1;
                        if (ia !== ib) return ia - ib;
                        return b.targetLeverage - a.targetLeverage;
                      });

                    return (
                      <>
                        {transactionStrategies.map((strategy) => {
                          const key = strategy.etfResult.id;
                          const isExpanded = expandedFuturesSma.includes(key);
                          return (
                            <div key={key} className="rounded-lg border border-card-border bg-card-bg">
                              <button
                                type="button"
                                onClick={() => {
                                  setExpandedFuturesSma((current) =>
                                    current.includes(key)
                                      ? current.filter((id) => id !== key)
                                      : [...current, key]
                                  );
                                }}
                                className="flex w-full items-center justify-between px-4 py-3 text-left text-sm transition-colors hover:bg-white/5"
                              >
                                <span className="font-medium text-foreground">
                                  {shortBacktestAssetLabel(strategy.etfResult.name)}
                                </span>
                                <span className="text-xs text-muted">
                                  {isExpanded ? "Hide SMA Details" : "Show SMA Details"}
                                </span>
                              </button>
                              {isExpanded && (
                                <div className="border-t border-card-border px-4 py-4">
                                  <FuturesSmaDetails
                                    strategy={strategy}
                                    annualizedInflation={annualizedInflation}
                                    monthlyCpi={monthlyCpi}
                                  />
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </>
                    );
                  })()}
                </div>
              )}
            </div>
          );
        })()}
      </div>
    </div>
    </>
  );
}
