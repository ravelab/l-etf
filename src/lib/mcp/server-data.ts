// Server-side market-data loading for the MCP tools.
//
// The browser code path (`fetch-market-data.ts`) loads data by fetching the
// app's own `/api/*` routes with relative URLs, which only resolves in a
// browser. MCP tools run inside a Vercel function, so they read straight from
// the same server-side query layer the API routes use (`@/lib/db/queries`),
// avoiding a self-referential HTTP round-trip. The alignment / warm-up math is
// reused from the shared pure helpers so results match the UI.

import { getBorrowRate, getInflation, getPriceDateBounds, getPrices } from "@/lib/db/queries";
import type { DailyPrice } from "@/lib/data/storage/types";
import type { PricePoint, RatePoint, EtfConfig } from "@/lib/simulation/types";
import { getRiskOffFetchTickers } from "@/lib/constants";

type RiskOffAsset = EtfConfig["riskOffAsset"];

/**
 * Coerce stored `DailyPrice` rows into the engine's `PricePoint` shape. Rows
 * without an adjusted close cannot seed a total-return simulation and are
 * dropped (matches the freshest-row handling noted in the storage types).
 */
export function coerceToPricePoints(rows: DailyPrice[]): PricePoint[] {
  const points: PricePoint[] = [];
  for (const row of rows) {
    if (row.adj_close == null) continue;
    points.push({
      date: row.date,
      adj_close: row.adj_close,
      close: row.close ?? row.adj_close,
      ...(row.adj_open != null ? { adj_open: row.adj_open } : {}),
      ...(row.open != null ? { open: row.open } : {}),
    });
  }
  return points;
}

export async function loadIndexPrices(
  index: "sp500" | "nasdaq100",
  startDate: string,
  endDate: string,
): Promise<PricePoint[]> {
  return coerceToPricePoints(await getPrices(index, startDate, endDate));
}

export async function loadBorrowRates(startDate: string, endDate: string): Promise<RatePoint[]> {
  const rows = await getBorrowRate(startDate, endDate);
  return rows.map((r) => ({ date: r.date, rateType: "borrow", rateValue: r.value }));
}

export async function loadInflation(
  startDate: string,
  endDate: string,
): Promise<Array<{ date: string; value: number }>> {
  return getInflation(startDate, endDate);
}

export async function loadIndexBounds(
  index: "sp500" | "nasdaq100",
): Promise<{ minDate: string; maxDate: string } | null> {
  return getPriceDateBounds(index);
}

/**
 * Map a single risk-off ticker to the storage source key. Mirrors the mapping
 * in `src/app/api/risk-off-prices/route.ts` so MCP results match the UI.
 */
export function riskOffSourceKey(ticker: string): string {
  if (ticker === "VOO") return "sp500";
  if (ticker === "QQQ") return "nasdaq100";
  if (ticker === "BRK.B") return "risk:BRKA";
  return `risk:${ticker.replace(".", "")}`;
}

/**
 * Load raw risk-off price series for a (possibly composite) risk-off asset,
 * keyed by constituent ticker — the same shape `loadAllRiskOffPricePoints`
 * produces in the browser, so `alignRiskOffPriceSeries` can consume it.
 */
export async function loadRiskOffRawSeries(
  asset: RiskOffAsset,
  startDate: string,
  endDate: string,
): Promise<Partial<Record<RiskOffAsset, PricePoint[]>>> {
  return loadRiskOffRawSeriesForAssets([asset], startDate, endDate);
}

/**
 * Load raw risk-off series for several (possibly composite) risk-off assets at
 * once, keyed by the union of constituent tickers. Used by the compare tools.
 */
export async function loadRiskOffRawSeriesForAssets(
  assets: RiskOffAsset[],
  startDate: string,
  endDate: string,
): Promise<Partial<Record<RiskOffAsset, PricePoint[]>>> {
  const tickers = Array.from(new Set(assets.flatMap((a) => getRiskOffFetchTickers(a))));
  const entries = await Promise.all(
    tickers.map(async (ticker) => {
      const rows = await getPrices(riskOffSourceKey(ticker), startDate, endDate);
      return [ticker as RiskOffAsset, coerceToPricePoints(rows)] as const;
    }),
  );
  return Object.fromEntries(entries) as Partial<Record<RiskOffAsset, PricePoint[]>>;
}
