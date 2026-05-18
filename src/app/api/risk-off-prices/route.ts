import { NextRequest, NextResponse } from "next/server";
import { z } from "zod/v4";
import { buildApiCacheHeaders } from "@/lib/api/cache-headers";
import { withCsvCacheDiagnostics } from "@/lib/data/storage/local";
import { getPrices } from "@/lib/db/queries";
import { isSupportedRiskOffAsset } from "@/lib/data/fetcher";

const querySchema = z.object({
  asset: z.string().trim().toUpperCase(),
  startDate: z.iso.date(),
  endDate: z.iso.date(),
});

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;

  const parsed = querySchema.safeParse({
    asset: searchParams.get("asset"),
    startDate: searchParams.get("startDate"),
    endDate: searchParams.get("endDate"),
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid parameters", details: parsed.error.issues },
      { status: 400 }
    );
  }

  const { asset, startDate, endDate } = parsed.data;
  if (!isSupportedRiskOffAsset(asset)) {
    return NextResponse.json(
      { error: "Unsupported asset. Allowed: SGOV, VGSH, GLDM, BRK.B, VOO, QQQ" },
      { status: 400 }
    );
  }

  const sourceKey =
    asset === "VOO"
      ? "sp500"
      : asset === "QQQ"
        ? "nasdaq100"
        : asset === "BRK.B"
          ? "risk:BRKA"
          : `risk:${asset.replace(".", "")}`;

  const { value: prices, sources } = await withCsvCacheDiagnostics(() =>
    getPrices(sourceKey, startDate, endDate)
  );
  
  if (prices.length === 0) {
    return NextResponse.json(
      {
        error: `Risk-off price data unavailable for ${asset}. Make sure the cron job has run.`,
      },
      { status: 404 }
    );
  }

  return NextResponse.json(prices, {
    headers: buildApiCacheHeaders({ dataCacheSources: sources }),
  });
}
