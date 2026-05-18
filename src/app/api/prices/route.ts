import { NextRequest, NextResponse } from "next/server";
import { z } from "zod/v4";
import { buildApiCacheHeaders } from "@/lib/api/cache-headers";
import { withCsvCacheDiagnostics } from "@/lib/data/storage/local";
import { getPrices } from "@/lib/db/queries";

const querySchema = z.object({
  index: z.enum(["sp500", "nasdaq100"]),
  startDate: z.iso.date(),
  endDate: z.iso.date(),
});

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;

  const parsed = querySchema.safeParse({
    index: searchParams.get("index"),
    startDate: searchParams.get("startDate"),
    endDate: searchParams.get("endDate"),
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid parameters", details: parsed.error.issues },
      { status: 400 }
    );
  }

  const { index, startDate, endDate } = parsed.data;

  const { value: prices, sources } = await withCsvCacheDiagnostics(() =>
    getPrices(index, startDate, endDate)
  );
  
  if (prices.length === 0) {
    return NextResponse.json(
      {
        error: `Price data unavailable for ${index}. Make sure the cron job has run.`,
      },
      { status: 404 }
    );
  }

  return NextResponse.json(prices, {
    headers: buildApiCacheHeaders({ dataCacheSources: sources }),
  });
}
