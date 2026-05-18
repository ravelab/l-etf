import type { PricePoint, RatePoint, EtfConfig } from "@/lib/simulation/types";
import { alignCloseSeriesToDates, alignOpenSeriesToDates, validateSimulationReadyPrices } from "@/lib/utils";
import { getRiskOffFetchTickers, LABEL_INDEX_NASDAQ100_TR, LABEL_INDEX_SP500_TR } from "@/lib/constants";

interface MarketData {
  rates: RatePoint[];
  pricesByIndex: Record<string, PricePoint[]>;
  annualizedInflation: number;
  monthlyCpi: Array<{ date: string; value: number }>;
  inflationWarning: boolean;
}

type LoaderProgress = {
  completed: number;
  total: number;
  label: string;
};

type CachedJsonResponse<T> = {
  ok: boolean;
  status: number;
  statusText: string;
  data: T | null;
};

type FetchMarketDataOptions = {
  allowMissingPrices?: boolean;
  rateStartDate?: string;
  warmUpTradingDays?: number;
};

type CachedJsonEntry = {
  response: CachedJsonResponse<unknown>;
  expiresAt: number;
};

type CachedRiskOffSeriesEntry = {
  points: PricePoint[];
  expiresAt: number;
};

export const MARKET_DATA_EARLIEST_START = "1885-01-01";
const DATA_LATEST_END = "9999-12-31";
const DEFAULT_WARM_UP_TRADING_DAYS = 280;
const TRADING_DAY_TO_CALENDAR_DAY_BUFFER = 1.6;
const MARKET_DATA_CACHE_TTL_MS = 60 * 60 * 1000;
const apiJsonCache = new Map<string, CachedJsonEntry>();

function addDaysIso(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function getMarketDataWarmUpStartDate(
  startDate: string,
  warmUpTradingDays = DEFAULT_WARM_UP_TRADING_DAYS,
): string {
  const calendarDays = Math.max(0, Math.ceil(warmUpTradingDays * TRADING_DAY_TO_CALENDAR_DAY_BUFFER + 14));
  const warmUpStart = addDaysIso(startDate, -calendarDays);
  return warmUpStart < MARKET_DATA_EARLIEST_START ? MARKET_DATA_EARLIEST_START : warmUpStart;
}

export async function fetchJsonCached<T>(url: string, signal?: AbortSignal): Promise<CachedJsonResponse<T>> {
  const now = Date.now();
  const entry = apiJsonCache.get(url);
  if (entry && entry.expiresAt > now) {
    return entry.response as CachedJsonResponse<T>;
  }

  const response = await fetch(url, { signal }).then(async (res) => {
    const data = (await res.json().catch(() => null)) as unknown;
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      data,
    };
  });
  if (response.ok) {
    apiJsonCache.set(url, {
      response,
      expiresAt: now + MARKET_DATA_CACHE_TTL_MS,
    });
  }
  return response as CachedJsonResponse<T>;
}

export async function fetchMarketData(
  indices: string[],
  startDate: string,
  endDate: string,
  signal?: AbortSignal,
  onProgress?: (progress: LoaderProgress) => void,
  options?: FetchMarketDataOptions,
): Promise<MarketData> {
  const errors: string[] = [];
  const allowMissingPrices = options?.allowMissingPrices ?? false;
  const warmUpTradingDays = options?.warmUpTradingDays ?? DEFAULT_WARM_UP_TRADING_DAYS;
  const priceWarnings: string[] = [];

  // Keep enough pre-start rows to seed SMA state without downloading the full history.
  const priceStartDate = getMarketDataWarmUpStartDate(startDate, warmUpTradingDays);
  const rateStartDate = options?.rateStartDate ?? priceStartDate;

  const totalRequests = 2 + indices.length;
  let completedRequests = 0;
  const markProgress = (label: string) => {
    completedRequests += 1;
    onProgress?.({ completed: completedRequests, total: totalRequests, label });
  };

  const [ratesRes, inflationRes, ...priceResponses] = await Promise.all([
    fetchJsonCached<Array<{ date: string; rateType: string; rateValue: number }>>(`/api/interest-rates?startDate=${rateStartDate}&endDate=${endDate}`, signal).then((res) => {
      markProgress("Loaded borrow rates");
      return res;
    }),
    fetchJsonCached<{ annualizedInflation: number; monthlyCpi: Array<{ date: string; value: number }> }>(`/api/inflation?startDate=${startDate}&endDate=${endDate}`, signal).then((res) => {
      markProgress("Loaded inflation data");
      return res;
    }),
    ...indices.map((idx) =>
      fetchJsonCached<Array<PricePoint | { date: string; adj_close?: number; close?: number }>>(`/api/prices?index=${idx}&startDate=${priceStartDate}&endDate=${endDate}`, signal).then((res) => {
        markProgress(`Loaded ${idx === "sp500" ? LABEL_INDEX_SP500_TR : idx === "nasdaq100" ? LABEL_INDEX_NASDAQ100_TR : idx} prices`);
        return res;
      })
    ),
  ]);

  // Rates are required for simulations.
  let rates: RatePoint[] = [];
  if (ratesRes.ok) {
    rates = ratesRes.data as RatePoint[];
  } else {
    errors.push(`Interest rates: ${((ratesRes.data ?? {}) as { error?: string }).error || ratesRes.statusText}`);
  }

  const pricesByIndex: Record<string, PricePoint[]> = {};
  for (let i = 0; i < indices.length; i++) {
    const index = indices[i];
    const res = priceResponses[i];
    if (!res?.ok) {
      let detail = res?.statusText ?? "Unknown error";
      detail = ((res?.data ?? {}) as { error?: string }).error || detail;

      if (allowMissingPrices) {
        pricesByIndex[index] = [];
        priceWarnings.push(`${index.toUpperCase()} prices: ${detail}`);
      } else {
        errors.push(`${index.toUpperCase()} prices: ${detail}`);
      }
      continue;
    }

    const rows = res.data ?? [];
    pricesByIndex[index] = validateSimulationReadyPrices(index, rows, endDate);
  }

  if (priceWarnings.length > 0) {
    console.warn("[fetchMarketData] partial price data:", priceWarnings.join("; "));
  }

  const hasAnyPrices = Object.values(pricesByIndex).some((rows) => rows.length > 0);
  if (errors.length > 0 || !hasAnyPrices) {
    const allErrors = errors.length > 0 ? errors : priceWarnings;
    throw new Error(`Failed to fetch historical data: ${allErrors.join("; ")}`);
  }

  let inflationWarning = false;
  let annualizedInflation = 0;
  let monthlyCpi: Array<{ date: string; value: number }> = [];
  
  if (inflationRes.ok) {
    const inflationData = inflationRes.data as { annualizedInflation: number; monthlyCpi: Array<{ date: string; value: number }> };
    annualizedInflation = inflationData.annualizedInflation;
    monthlyCpi = inflationData.monthlyCpi;
  } else {
    inflationWarning = true;
    console.warn(`Inflation data unavailable: ${((inflationRes.data ?? {}) as { error?: string }).error || inflationRes.statusText}`);
  }

  return {
    rates,
    pricesByIndex,
    annualizedInflation,
    monthlyCpi,
    inflationWarning,
  };
}

export async function fetchLatestIndexPriceAnchors(
  indices: string[],
  signal?: AbortSignal
): Promise<Record<string, number>> {
  const responses = await Promise.all(
    indices.map((idx) =>
      fetchJsonCached<Array<PricePoint | { date: string; adj_close?: number; close?: number }>>(
        `/api/prices?index=${idx}&startDate=2020-01-01&endDate=${DATA_LATEST_END}`,
        signal
      )
    )
  );

  const anchors: Record<string, number> = {};
  for (let i = 0; i < indices.length; i++) {
    const index = indices[i];
    const res = responses[i];
    if (!index || !res?.ok || !Array.isArray(res.data) || res.data.length === 0) continue;
    for (let j = res.data.length - 1; j >= 0; j--) {
      const point = res.data[j];
      const close = point?.close ?? point?.adj_close;
      if (Number.isFinite(close) && (close as number) > 0) {
        anchors[index] = close as number;
        break;
      }
    }
  }
  return anchors;
}

export async function loadRiskOffPriceSeries(
  riskOffAsset: EtfConfig["riskOffAsset"],
  referencePrices: PricePoint[],
  startDate: string,
  endDate: string,
  signal?: AbortSignal,
): Promise<{ closeValuesByAsset: Partial<Record<EtfConfig["riskOffAsset"], number[]>>; openValuesByAsset: Partial<Record<EtfConfig["riskOffAsset"], number[]>> }> {
  const tickers = getRiskOffFetchTickers(riskOffAsset);
  const riskStartDate = referencePrices[0]?.date ?? startDate;
  const riskEndDate = referencePrices[referencePrices.length - 1]?.date ?? endDate;
  const rawSeriesByAsset = await loadAllRiskOffPricePoints(tickers, signal, undefined, {
    startDate: riskStartDate,
    endDate: riskEndDate,
  });
  return alignRiskOffPriceSeries(referencePrices, rawSeriesByAsset);
}


const rawRiskOffSeriesCache = new Map<string, CachedRiskOffSeriesEntry>();

async function fetchRiskOffPricePoints(
  ticker: string,
  startDate: string,
  endDate: string,
  signal?: AbortSignal,
): Promise<PricePoint[]> {
  const cacheKey = `${ticker}|${startDate}|${endDate}`;
  const cached = rawRiskOffSeriesCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.points;

  const riskRes = await fetchJsonCached<PricePoint[]>(
    `/api/risk-off-prices?asset=${encodeURIComponent(ticker)}&startDate=${startDate}&endDate=${endDate}`,
    signal
  );
  if (!riskRes.ok) {
    const payload = (riskRes.data ?? {}) as { error?: string };
    throw new Error(payload.error ?? `Failed to load risk-off data for ${ticker}`);
  }
  const riskPoints = riskRes.data ?? [];
  rawRiskOffSeriesCache.set(cacheKey, {
    points: riskPoints,
    expiresAt: Date.now() + MARKET_DATA_CACHE_TTL_MS,
  });
  return riskPoints;
}

export async function loadAllRiskOffPricePoints(
  allTickers: string[],
  signal?: AbortSignal,
  onProgress?: (progress: LoaderProgress) => void,
  options?: { startDate?: string; endDate?: string },
): Promise<Partial<Record<EtfConfig["riskOffAsset"], PricePoint[]>>> {
  const rawSeriesByAsset: Partial<Record<EtfConfig["riskOffAsset"], PricePoint[]>> = {};
  const startDate = options?.startDate ?? MARKET_DATA_EARLIEST_START;
  const endDate = options?.endDate ?? DATA_LATEST_END;
  let completed = 0;
  const riskRows = await Promise.all(
    allTickers.map(async (ticker) => {
      const points = await fetchRiskOffPricePoints(ticker, startDate, endDate, signal);
      completed += 1;
      onProgress?.({
        completed,
        total: allTickers.length,
        label: `Loaded risk-off ${ticker}`,
      });
      return [ticker, points] as const;
    })
  );

  for (const [ticker, riskPoints] of riskRows) {
    rawSeriesByAsset[ticker as EtfConfig["riskOffAsset"]] = riskPoints;
  }

  return rawSeriesByAsset;
}

export function alignRiskOffPriceSeries(
  referencePrices: PricePoint[],
  rawSeriesByAsset: Partial<Record<EtfConfig["riskOffAsset"], PricePoint[]>>,
): { closeValuesByAsset: Partial<Record<EtfConfig["riskOffAsset"], number[]>>; openValuesByAsset: Partial<Record<EtfConfig["riskOffAsset"], number[]>> } {
  const closeValuesByAsset: Partial<Record<EtfConfig["riskOffAsset"], number[]>> = {};
  const openValuesByAsset: Partial<Record<EtfConfig["riskOffAsset"], number[]>> = {};

  for (const [ticker, riskPoints] of Object.entries(rawSeriesByAsset)) {
    closeValuesByAsset[ticker as EtfConfig["riskOffAsset"]] = alignCloseSeriesToDates(referencePrices, riskPoints);
    openValuesByAsset[ticker as EtfConfig["riskOffAsset"]] = alignOpenSeriesToDates(referencePrices, riskPoints);
  }

  return { closeValuesByAsset, openValuesByAsset };
}
