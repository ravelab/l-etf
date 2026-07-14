import { getNewYorkIsoDate } from "@/lib/utils";
import type { YahooQuote } from "./storage/types";

// ============================================================================
// Types and Type Guards
// Only exports type definitions and type guard functions used by API routes.
// All data fetching logic has been moved to scripts/fetch-data.ts.
// ============================================================================

const ETFS = ["UPRO", "TQQQ", "SSO", "QLD"] as const;
const RISK_OFF_ASSETS = ["SGOV", "VGSH", "GLDM", "BRK.B", "VOO", "QQQ"] as const;

type SupportedEtfTicker = (typeof ETFS)[number];
type SupportedRiskOffAsset = (typeof RISK_OFF_ASSETS)[number];

export function isSupportedEtfTicker(value: string | null): value is SupportedEtfTicker {
  return ETFS.includes(value as SupportedEtfTicker);
}

export function isSupportedRiskOffAsset(value: string | null): value is SupportedRiskOffAsset {
  return RISK_OFF_ASSETS.includes(value as SupportedRiskOffAsset);
}

type YahooDailyChartPayload = {
  chart?: {
    result?: Array<{
      meta?: {
        regularMarketTime?: number;
        currentTradingPeriod?: { regular?: { end?: number } };
      };
      timestamp?: number[];
      indicators?: {
        quote?: Array<{ open?: Array<number | null>; close?: Array<number | null> }>;
      };
    }>;
    error?: { description?: string };
  };
};

/** One regular-session bar from Yahoo's daily chart (same window as {@link fetchYahooDailyClosesByDate}). */
export type YahooDailyBar = {
  close: number;
  /** Present when Yahoo returned a valid open for that session. */
  open?: number;
};

// Pad the requested window start so the NY session bar for `startDate` is
// always inside it regardless of timezone/DST boundaries.
const YAHOO_WINDOW_MARGIN_SECONDS = 2 * 24 * 60 * 60;

function buildYahooRecentWindowQuery(startDate: string, nowSeconds: number): string {
  const parsedMs = /^\d{4}-\d{2}-\d{2}$/.test(startDate)
    ? Date.parse(`${startDate}T00:00:00Z`)
    : Number.NaN;
  if (!Number.isFinite(parsedMs)) {
    throw new Error(`Invalid Yahoo window start date "${startDate}"; expected YYYY-MM-DD`);
  }
  const period1 = Math.floor(parsedMs / 1000) - YAHOO_WINDOW_MARGIN_SECONDS;
  return `period1=${period1}&period2=${nowSeconds}&interval=1d`;
}

/**
 * Daily bars (open + close) from the Yahoo chart, keyed by NY session date.
 * Same session-boundary rules as {@link fetchYahooDailyClosesByDate}.
 *
 * Window selection: `fullHistory` fetches everything; `startDate` (YYYY-MM-DD)
 * fetches from that date to now — required when callers must bridge back to a
 * CSV tail older than Yahoo's default window; otherwise the last month.
 */
export async function fetchYahooDailyBarsByDate(
  symbol: "^GSPC" | "^NDX" | "^IXIC",
  options: { fullHistory?: boolean; startDate?: string } = {}
): Promise<Map<string, YahooDailyBar>> {
  console.log(`[yahoo] Fetching daily OHLC for ${symbol}...`);
  const encoded = encodeURIComponent(symbol);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const query = options.fullHistory
    ? `period1=0&period2=${nowSeconds}&interval=1d&events=history`
    : options.startDate
      ? buildYahooRecentWindowQuery(options.startDate, nowSeconds)
      : "interval=1d&range=1mo";
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?${query}`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept-Language": "en-US,en;q=0.9",
    },
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    console.warn(`[yahoo] Chart request failed for ${symbol}: ${response.status} ${body.slice(0, 200)}`);
    throw new Error(`Yahoo Finance daily-chart error (${response.status}) for ${symbol}: ${body.slice(0, 200)}`);
  }

  const payload = (await response.json()) as YahooDailyChartPayload;
  const result = payload.chart?.result?.[0];
  if (!result) {
    console.warn(
      `[yahoo] Yahoo response had no result for ${symbol}: ${payload.chart?.error?.description ?? "unknown error"}`
    );
    throw new Error(payload.chart?.error?.description ?? `No Yahoo Finance daily-chart result for ${symbol}`);
  }

  const regularMarketTime = result.meta?.regularMarketTime;
  const regularEnd = result.meta?.currentTradingPeriod?.regular?.end;
  const marketClosedToday =
    typeof regularMarketTime === "number" &&
    typeof regularEnd === "number" &&
    regularMarketTime >= regularEnd;

  const timestamps = result.timestamp ?? [];
  const quote = result.indicators?.quote?.[0];
  const opens = quote?.open ?? [];
  const closes = quote?.close ?? [];
  const currentNyDate = getNewYorkIsoDate();
  const byDate = new Map<string, YahooDailyBar>();

  for (let i = 0; i < timestamps.length; i += 1) {
    const close = closes[i];
    const open = opens[i];
    const timestamp = timestamps[i];
    if (!Number.isFinite(close ?? Number.NaN) || !Number.isFinite(timestamp ?? Number.NaN)) continue;

    const quoteDate = new Date((timestamp as number) * 1000).toISOString().slice(0, 10);

    if (quoteDate === currentNyDate && !marketClosedToday) {
      continue;
    }

    const roundedClose = Math.round((close as number) * 100) / 100;
    const bar: YahooDailyBar = { close: roundedClose };
    if (Number.isFinite(open ?? Number.NaN)) {
      bar.open = Math.round((open as number) * 100) / 100;
    }
    byDate.set(quoteDate, bar);
  }

  if (byDate.size === 0) {
    console.warn(`[yahoo] No usable bars returned for ${symbol}`);
  } else {
    let firstDate = "";
    let lastDate = "";
    for (const date of byDate.keys()) {
      if (!firstDate || date < firstDate) firstDate = date;
      if (!lastDate || date > lastDate) lastDate = date;
    }
    console.log(`[yahoo] ${symbol} returned ${byDate.size} bar(s) from ${firstDate} to ${lastDate}`);
  }

  return byDate;
}

/**
 * All calendar dates in the Yahoo daily chart (typically ~1 month) with a valid close,
 * keyed by NY session date. Skips today's bar until the regular session has ended (same
 * rules as {@link fetchYahooDailyLatestClose}). Use this to fill SPX/NDX index closes for
 * recent days when FRED lags - not only the single latest bar.
 */
async function fetchYahooDailyClosesByDate(symbol: "^GSPC" | "^NDX" | "^IXIC"): Promise<Map<string, number>> {
  const bars = await fetchYahooDailyBarsByDate(symbol);
  return new Map([...bars.entries()].map(([date, bar]) => [date, bar.close]));
}

export async function fetchYahooDailyLatestClose(symbol: "^GSPC" | "^NDX" | "^IXIC"): Promise<YahooQuote | null> {
  const byDate = await fetchYahooDailyClosesByDate(symbol);
  if (byDate.size === 0) {
    console.log(`[yahoo] No latest close available for ${symbol}`);
    return null;
  }
  let maxDate = "";
  for (const d of byDate.keys()) {
    if (d > maxDate) maxDate = d;
  }
  const close = byDate.get(maxDate);
  if (close === undefined) {
    console.warn(`[yahoo] Latest close missing for ${symbol} despite non-empty daily close data`);
    return null;
  }
  console.log(`[yahoo] Latest close for ${symbol}: ${maxDate} (${close})`);
  return { date: maxDate, close };
}
