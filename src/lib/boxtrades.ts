const BOXTRADES_BASE_URL = "https://www.boxtrades.com";
const SPX_PATH_PATTERN = /\/SPX\/(\d{2}[A-Z]{3}\d{2})/g;
const NEXT_DATA_PATTERN =
  /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/;
const DTE_PATTERN = /id="dte"[^>]*value="([^"]+)"/;
const SUMMARY_RATE_PATTERN = /average rate was around ([0-9.]+)%/i;
const AS_OF_PATTERN = /As of ([^,]+, \d{4})/i;
const DEFAULT_SIZE_MODEL_CONFIG = {
  lookbackDays: 365,
  benchmarkNotional: 1_000_000,
  exampleNotionals: [50_000, 200_000],
  minTradeNotional: 25_000,
  minRecentTradeVolume: 3,
  recentTradingDays: 2,
  microReceivedAmountMax: 75_000,
  smallReceivedAmountMax: 250_000,
  largeReceivedAmountMin: 750_000,
};
const MARKET_HOLIDAYS_2026 = new Set([
  "2026-01-01",
  "2026-01-19",
  "2026-02-16",
  "2026-04-03",
  "2026-05-25",
  "2026-06-19",
  "2026-07-03",
  "2026-09-07",
  "2026-11-26",
  "2026-12-25",
]);
const FIDELITY_SPX_FOUR_LEG_COST = {
  optionCommissionPerContract: 0.65,
  spxIndexFeePerContract: 0.5,
  legs: 4,
  contracts: 1,
  estimatedCost: 4 * (0.65 + 0.5),
};

export type BoxtradesContractApy = {
  expiry: string;
  expFormat: string;
  daysToExpiry: number;
  asOf: string | null;
  boxtradesYieldPercent: number | null;
  apyPercent: number;
  sizeAdjustedApyPercent: Record<string, number | null>;
  fidelityAndSpreadAdjustedApyPercent: Record<string, number | null>;
  sizePremiumVsBenchmarkBps: Record<string, number | null>;
};

type ParsedBoxtradesContractApy = Omit<BoxtradesContractApy, "apyPercent"> & {
  apyPercent: number | null;
};

export type BoxtradesSizeModel = {
  method: string;
  lookbackDays: number;
  benchmarkNotional: number;
  exampleNotionals: number[];
  observations: number;
  microObservations: number;
  smallObservations: number;
  largeObservations: number;
  yieldPenaltyBpsPer10xSmallerNotional: number | null;
  targetAmountDescription: string;
  fidelityFourLegCost: typeof FIDELITY_SPX_FOUR_LEG_COST;
};

export type BoxtradesApyReport = {
  asOf: string | null;
  contracts: BoxtradesContractApy[];
  sizeModel: BoxtradesSizeModel;
};

type BoxtradesPageProps = {
  description?: string;
  expiry?: number;
  data?: Array<{
    rate?: number | null;
    spread?: number | null;
    last?: number | null;
    volume?: number | null;
    ts?: number | null;
  }>;
};

type BoxtradesNextData = {
  props?: {
    pageProps?: BoxtradesPageProps;
  };
};

export function effectiveYieldToApyPercent(
  yieldPercent: number,
  daysToExpiry: number,
): number {
  return (
    100 *
    (Math.pow(1 + (yieldPercent / 100) * (daysToExpiry / 365), 365 / daysToExpiry) -
      1)
  );
}

function simpleYieldPercentFromRepay(
  receivedAmount: number,
  repayAmount: number,
  daysToExpiry: number,
): number {
  return 365 * (repayAmount / receivedAmount - 1) / daysToExpiry * 100;
}

function roundPercent(value: number | null): number | null {
  if (value === null) return null;
  return Math.round(value * 10_000) / 10_000;
}

function roundBps(value: number | null): number | null {
  if (value === null) return null;
  return Math.round(value * 10) / 10;
}

function parseDateFromExpiry(expiry: number): string {
  return new Date(expiry).toISOString().slice(0, 10);
}

function fallbackDaysToExpiry(expiry: number, now = new Date()): number {
  const millisPerDay = 24 * 60 * 60 * 1000;
  return Math.ceil((expiry - now.getTime()) / millisPerDay);
}

export function parseSpxExpiryFormats(html: string): string[] {
  const formats = new Set<string>();
  for (const match of html.matchAll(SPX_PATH_PATTERN)) {
    formats.add(match[1]);
  }
  return [...formats];
}

function parseBoxtradesPageProps(html: string, expFormat: string): BoxtradesPageProps {
  const nextDataMatch = html.match(NEXT_DATA_PATTERN);
  if (!nextDataMatch) {
    throw new Error(`Missing Boxtrades page data for SPX ${expFormat}`);
  }

  const nextData = JSON.parse(nextDataMatch[1]) as BoxtradesNextData;
  const pageProps = nextData.props?.pageProps;
  if (!pageProps?.expiry) {
    throw new Error(`Missing Boxtrades expiry for SPX ${expFormat}`);
  }
  return pageProps;
}

export function parseBoxtradesSpxContractPage(
  html: string,
  expFormat: string,
  now = new Date(),
): ParsedBoxtradesContractApy {
  const pageProps = parseBoxtradesPageProps(html, expFormat);
  const expiry = pageProps.expiry;
  if (expiry === undefined) {
    throw new Error(`Missing Boxtrades expiry for SPX ${expFormat}`);
  }

  const description = pageProps.description ?? "";
  const dteValue = html.match(DTE_PATTERN)?.[1];
  const daysToExpiry =
    dteValue && Number.isFinite(Number(dteValue))
      ? Number(dteValue)
      : fallbackDaysToExpiry(expiry, now);

  const boxtradesYieldPercent = description.match(SUMMARY_RATE_PATTERN)?.[1];
  const parsedBoxtradesYield =
    boxtradesYieldPercent === undefined ? null : Number(boxtradesYieldPercent);

  return {
    expiry: parseDateFromExpiry(expiry),
    expFormat,
    daysToExpiry,
    asOf: description.match(AS_OF_PATTERN)?.[1] ?? null,
    boxtradesYieldPercent: parsedBoxtradesYield,
    apyPercent:
      parsedBoxtradesYield === null
        ? null
        : roundPercent(effectiveYieldToApyPercent(parsedBoxtradesYield, daysToExpiry)),
    sizeAdjustedApyPercent: {},
    fidelityAndSpreadAdjustedApyPercent: {},
    sizePremiumVsBenchmarkBps: {},
  };
}

type SizeObservation = {
  log10Notional: number;
  residualYieldPercent: number;
  receivedAmount: number;
  ageDays: number;
};

type TradePoint = {
  rate: number;
  receivedAmount: number;
  ts: number;
  volume: number;
};

function utcDateKey(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function previousUtcDateKey(dateKey: string): string {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function isMarketTradingDay(dateKey: string): boolean {
  const day = new Date(`${dateKey}T00:00:00.000Z`).getUTCDay();
  return day !== 0 && day !== 6 && !MARKET_HOLIDAYS_2026.has(dateKey);
}

function recentMarketTradingDays(
  latestDateKey: string,
  count = DEFAULT_SIZE_MODEL_CONFIG.recentTradingDays,
): string[] {
  const dates: string[] = [];
  let dateKey = latestDateKey;
  while (dates.length < count) {
    if (isMarketTradingDay(dateKey)) {
      dates.push(dateKey);
    }
    dateKey = previousUtcDateKey(dateKey);
  }
  return dates.reverse();
}

export function fitYieldPenaltyBpsPer10xSmallerNotional(
  observations: SizeObservation[],
): number | null {
  if (observations.length < 30) return null;

  const meanX =
    observations.reduce((sum, observation) => sum + observation.log10Notional, 0) /
    observations.length;
  const meanY =
    observations.reduce(
      (sum, observation) => sum + observation.residualYieldPercent,
      0,
    ) / observations.length;
  const varianceX = observations.reduce(
    (sum, observation) => sum + (observation.log10Notional - meanX) ** 2,
    0,
  );
  if (varianceX === 0) return null;

  const slopeYieldPercentPer10x = observations.reduce(
    (sum, observation) =>
      sum +
      (observation.log10Notional - meanX) *
        (observation.residualYieldPercent - meanY),
    0,
  ) / varianceX;

  return Math.max(0, -slopeYieldPercentPer10x * 100);
}

export function sizePremiumBps(
  yieldPenaltyBpsPer10xSmallerNotional: number | null,
  targetNotional: number,
  benchmarkNotional = DEFAULT_SIZE_MODEL_CONFIG.benchmarkNotional,
): number | null {
  if (yieldPenaltyBpsPer10xSmallerNotional === null || targetNotional <= 0) {
    return null;
  }
  const logDifference = Math.log10(benchmarkNotional / targetNotional);
  return roundBps(Math.max(0, yieldPenaltyBpsPer10xSmallerNotional * logDifference));
}

function tradePointFromChartPoint(
  point: NonNullable<BoxtradesPageProps["data"]>[number],
): TradePoint | null {
  const rate = point.rate;
  const last = point.last;
  const volume = point.volume ?? 1;
  const ts = point.ts;
  if (
    typeof rate !== "number" ||
    typeof last !== "number" ||
    typeof volume !== "number" ||
    typeof ts !== "number" ||
    !Number.isFinite(rate) ||
    !Number.isFinite(last) ||
    !Number.isFinite(volume) ||
    !Number.isFinite(ts)
  ) {
    return null;
  }

  const receivedAmount = last * 100 * volume;
  if (receivedAmount <= 0) return null;
  return { rate, receivedAmount, ts, volume };
}

export function recentSizeAdjustedYieldPercent(
  pageProps: BoxtradesPageProps,
  yieldPenaltyBpsPer10xSmallerNotional: number | null,
  benchmarkNotional = DEFAULT_SIZE_MODEL_CONFIG.benchmarkNotional,
  recentDates?: Set<string>,
): number | null {
  const recentTrades = recentTradePoints(pageProps, recentDates).slice(-3);

  if (recentTrades.length === 0) return null;

  const totalReceivedAmount = recentTrades.reduce(
    (sum, trade) => sum + trade.receivedAmount,
    0,
  );
  if (totalReceivedAmount <= 0) return null;

  const totalAdjustedYield = recentTrades.reduce((sum, trade) => {
    const premiumBps =
      sizePremiumBps(
        yieldPenaltyBpsPer10xSmallerNotional,
        trade.receivedAmount,
        benchmarkNotional,
      ) ?? 0;
    return sum + (trade.rate - premiumBps / 100) * trade.receivedAmount;
  }, 0);

  return roundPercent(totalAdjustedYield / totalReceivedAmount);
}

function recentTradePoints(
  pageProps: BoxtradesPageProps,
  recentDates?: Set<string>,
): TradePoint[] {
  const trades = (pageProps.data ?? [])
    .map(tradePointFromChartPoint)
    .filter((point): point is TradePoint => point !== null)
    .sort((a, b) => a.ts - b.ts);
  if (recentDates !== undefined) {
    return trades.filter((trade) => recentDates.has(utcDateKey(trade.ts)));
  }

  const latestTrade = trades.at(-1);
  if (latestTrade === undefined) return [];
  return recentTradePoints(
    pageProps,
    new Set(recentMarketTradingDays(utcDateKey(latestTrade.ts))),
  );
}

function recentTradeCount(pageProps: BoxtradesPageProps, recentDates: Set<string>): number {
  return recentTradePoints(pageProps, recentDates).length;
}

function recentTradeVolume(
  pageProps: BoxtradesPageProps,
  recentDates: Set<string>,
): number {
  return recentTradePoints(pageProps, recentDates)
    .slice(-3)
    .reduce((sum, trade) => sum + trade.volume, 0);
}

function latestTradeDateKey(pages: Array<{ pageProps: BoxtradesPageProps }>): string | null {
  const latestTs = Math.max(
    ...pages.flatMap((page) =>
      (page.pageProps.data ?? [])
        .map(tradePointFromChartPoint)
        .filter((point): point is TradePoint => point !== null)
        .map((trade) => trade.ts),
    ),
  );
  return Number.isFinite(latestTs) ? utcDateKey(latestTs) : null;
}

export function applySizeAdjustedApys(
  contract: ParsedBoxtradesContractApy,
  yieldPenaltyBpsPer10xSmallerNotional: number | null,
  exampleNotionals = DEFAULT_SIZE_MODEL_CONFIG.exampleNotionals,
  benchmarkNotional = DEFAULT_SIZE_MODEL_CONFIG.benchmarkNotional,
  fidelityCost = FIDELITY_SPX_FOUR_LEG_COST.estimatedCost,
): ParsedBoxtradesContractApy {
  const sizeAdjustedApyPercent: Record<string, number | null> = {};
  const fidelityAndSpreadAdjustedApyPercent: Record<string, number | null> = {};
  const sizePremiumVsBenchmarkBps: Record<string, number | null> = {};

  for (const receivedAmount of exampleNotionals) {
    const key = String(receivedAmount);
    const premiumBps = sizePremiumBps(
      yieldPenaltyBpsPer10xSmallerNotional,
      receivedAmount,
      benchmarkNotional,
    );
    sizePremiumVsBenchmarkBps[key] = premiumBps;
    if (contract.boxtradesYieldPercent === null || premiumBps === null) {
      sizeAdjustedApyPercent[key] = null;
      fidelityAndSpreadAdjustedApyPercent[key] = null;
      continue;
    }

    const spreadAdjustedYieldPercent =
      contract.boxtradesYieldPercent + premiumBps / 100;
    sizeAdjustedApyPercent[key] = roundPercent(
      effectiveYieldToApyPercent(spreadAdjustedYieldPercent, contract.daysToExpiry),
    );

    const grossReceivedBeforeFidelityCost = receivedAmount + fidelityCost;
    const repayAmount =
      grossReceivedBeforeFidelityCost *
      (1 + (spreadAdjustedYieldPercent / 100) * (contract.daysToExpiry / 365));
    const fidelityAdjustedYieldPercent = simpleYieldPercentFromRepay(
      receivedAmount,
      repayAmount,
      contract.daysToExpiry,
    );
    fidelityAndSpreadAdjustedApyPercent[key] = roundPercent(
      effectiveYieldToApyPercent(
        fidelityAdjustedYieldPercent,
        contract.daysToExpiry,
      ),
    );
  }

  return {
    ...contract,
    sizeAdjustedApyPercent,
    fidelityAndSpreadAdjustedApyPercent,
    sizePremiumVsBenchmarkBps,
  };
}

function buildSizeObservations(
  pages: Array<{ contract: ParsedBoxtradesContractApy; pageProps: BoxtradesPageProps }>,
): SizeObservation[] {
  const observations: SizeObservation[] = [];
  const millisPerDay = 24 * 60 * 60 * 1000;

  for (const page of pages) {
    if (page.contract.boxtradesYieldPercent === null) continue;

    const data = page.pageProps.data ?? [];
    const maxTs = Math.max(
      ...data
        .map((point) => point.ts)
        .filter((ts): ts is number => typeof ts === "number" && Number.isFinite(ts)),
    );
    if (!Number.isFinite(maxTs)) continue;

    for (const point of data) {
      const trade = tradePointFromChartPoint(point);
      if (trade === null) continue;
      const { rate, receivedAmount, ts } = trade;
      if (receivedAmount < DEFAULT_SIZE_MODEL_CONFIG.minTradeNotional) continue;
      observations.push({
        log10Notional: Math.log10(receivedAmount),
        residualYieldPercent: rate - page.contract.boxtradesYieldPercent,
        receivedAmount,
        ageDays: (maxTs - ts) / millisPerDay,
      });
    }
  }

  return observations;
}

export function buildSizeModel(observations: SizeObservation[]): BoxtradesSizeModel {
  const selected = observations.filter(
    (observation) => observation.ageDays <= DEFAULT_SIZE_MODEL_CONFIG.lookbackDays,
  );
  const smallObservations = selected.filter(
    (observation) =>
      observation.receivedAmount <= DEFAULT_SIZE_MODEL_CONFIG.smallReceivedAmountMax,
  ).length;
  const microObservations = selected.filter(
    (observation) =>
      observation.receivedAmount <= DEFAULT_SIZE_MODEL_CONFIG.microReceivedAmountMax,
  ).length;
  const largeObservations = selected.filter(
    (observation) =>
      observation.receivedAmount >= DEFAULT_SIZE_MODEL_CONFIG.largeReceivedAmountMin,
  ).length;

  return {
    method:
      "365-day equal-weight linear regression of trade yield minus Boxtrades yield vs log10(total received cash)",
    lookbackDays: DEFAULT_SIZE_MODEL_CONFIG.lookbackDays,
    benchmarkNotional: DEFAULT_SIZE_MODEL_CONFIG.benchmarkNotional,
    exampleNotionals: DEFAULT_SIZE_MODEL_CONFIG.exampleNotionals,
    observations: selected.length,
    microObservations,
    smallObservations,
    largeObservations,
    yieldPenaltyBpsPer10xSmallerNotional: roundBps(
      fitYieldPenaltyBpsPer10xSmallerNotional(selected),
    ),
    targetAmountDescription:
      "Example sizes and trade-size penalties use total cash received today after Fidelity cost, not per-contract size or maturity repayment amount.",
    fidelityFourLegCost: FIDELITY_SPX_FOUR_LEG_COST,
  };
}

/** Upstream is a third party; never hold a request open indefinitely. */
const BOXTRADES_FETCH_TIMEOUT_MS = 30_000;

/**
 * One assembled report is reused for this long. A single report costs one
 * request per SPX expiry, so without a cache the public MCP tool fans every
 * inbound call out into 10-30 outbound requests against boxtrades.com from our
 * egress IPs. Matches the CDN cache on /api/boxtrades/spx-apy.
 */
const BOXTRADES_REPORT_TTL_MS = 10 * 60 * 1000;

const reportCache = new Map<number, { expiresAt: number; report: Promise<BoxtradesApyReport> }>();

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { "User-Agent": "l-etf/boxtrades-apy" },
    cache: "no-store",
    signal: AbortSignal.timeout(BOXTRADES_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Boxtrades request failed for ${url}: ${response.status}`);
  }
  return response.text();
}

export async function fetchSpxBoxtradesApyReport(
  minDays: number,
): Promise<BoxtradesApyReport> {
  const now = Date.now();
  const cached = reportCache.get(minDays);
  if (cached && cached.expiresAt > now) return cached.report;

  // Cache the in-flight promise so concurrent callers collapse into one fetch
  // fan-out; drop it on failure so an error is never cached.
  const report = buildSpxBoxtradesApyReport(minDays);
  reportCache.set(minDays, { expiresAt: now + BOXTRADES_REPORT_TTL_MS, report });
  report.catch(() => reportCache.delete(minDays));
  return report;
}

async function buildSpxBoxtradesApyReport(
  minDays: number,
): Promise<BoxtradesApyReport> {
  const indexHtml = await fetchText(`${BOXTRADES_BASE_URL}/`);
  const expFormats = parseSpxExpiryFormats(indexHtml);
  const pages = await Promise.all(
    expFormats.map(async (expFormat) => {
      const html = await fetchText(`${BOXTRADES_BASE_URL}/SPX/${expFormat}`);
      return {
        contract: parseBoxtradesSpxContractPage(html, expFormat),
        pageProps: parseBoxtradesPageProps(html, expFormat),
      };
    }),
  );

  const latestDateKey = latestTradeDateKey(pages);
  const recentDateSet =
    latestDateKey === null
      ? new Set<string>()
      : new Set(recentMarketTradingDays(latestDateKey));
  const longDatedPages = pages.filter(
    (page) =>
      page.contract.daysToExpiry > minDays &&
      page.contract.apyPercent !== null &&
      recentTradeCount(page.pageProps, recentDateSet) >= 3 &&
      recentTradeVolume(page.pageProps, recentDateSet) >=
        DEFAULT_SIZE_MODEL_CONFIG.minRecentTradeVolume,
  );
  const sizeModel = buildSizeModel(buildSizeObservations(longDatedPages));
  const contracts = longDatedPages
    .map((page) => {
      const boxtradesYieldPercent =
        recentSizeAdjustedYieldPercent(
          page.pageProps,
          sizeModel.yieldPenaltyBpsPer10xSmallerNotional,
          sizeModel.benchmarkNotional,
          recentDateSet,
        ) ?? page.contract.boxtradesYieldPercent;
      return applySizeAdjustedApys(
        {
          ...page.contract,
          boxtradesYieldPercent,
          apyPercent:
            boxtradesYieldPercent === null
              ? null
              : roundPercent(
                  effectiveYieldToApyPercent(
                    boxtradesYieldPercent,
                    page.contract.daysToExpiry,
                  ),
                ),
        },
        sizeModel.yieldPenaltyBpsPer10xSmallerNotional,
        sizeModel.exampleNotionals,
        sizeModel.benchmarkNotional,
      );
    })
    .filter(
      (contract): contract is ParsedBoxtradesContractApy & { apyPercent: number } =>
        contract.daysToExpiry > minDays && contract.apyPercent !== null,
    )
    .sort((a, b) => a.daysToExpiry - b.daysToExpiry);

  return { asOf: latestDateKey, contracts, sizeModel };
}
