import { NextRequest, NextResponse } from "next/server";
import { z } from "zod/v4";
import { buildApiCacheHeaders } from "@/lib/api/cache-headers";
import { withCsvCacheDiagnostics } from "@/lib/data/storage/local";
import { getPriceDateBounds, getPrices } from "@/lib/db/queries";
import { isSupportedEtfTicker } from "@/lib/data/fetcher";

const querySchema = z.object({
  symbol: z.string().trim().toUpperCase(),
  startDate: z.iso.date(),
  endDate: z.iso.date(),
});

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;

  const parsed = querySchema.safeParse({
    symbol: searchParams.get("symbol"),
    startDate: searchParams.get("startDate"),
    endDate: searchParams.get("endDate"),
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid parameters", details: parsed.error.issues },
      { status: 400 }
    );
  }

  const { symbol, startDate, endDate } = parsed.data;
  if (!isSupportedEtfTicker(symbol)) {
    return NextResponse.json(
      { error: "Unsupported symbol. Allowed: UPRO, TQQQ, SSO, QLD" },
      { status: 400 }
    );
  }

  const { value: prices, sources } = await withCsvCacheDiagnostics(() =>
    getPrices(`etf:${symbol}`, startDate, endDate)
  );
  
  if (prices.length === 0) {
    const bounds = await getPriceDateBounds(`etf:${symbol}`);
    const rangeMessage = bounds
      ? `No ${symbol} ETF data in ${startDate} to ${endDate}. Available range: ${bounds.minDate} to ${bounds.maxDate}.`
      : `ETF price data unavailable for ${symbol}. Make sure the cron job has run.`;
    return NextResponse.json(
      {
        error: rangeMessage,
      },
      { status: 404 }
    );
  }

  return NextResponse.json(prices, {
    headers: buildApiCacheHeaders({ dataCacheSources: sources }),
  });
}
