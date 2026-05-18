import { NextRequest, NextResponse } from "next/server";
import { z } from "zod/v4";
import { buildApiCacheHeaders } from "@/lib/api/cache-headers";
import { fetchSpxBoxtradesApyReport } from "@/lib/boxtrades";

const querySchema = z.object({
  minDays: z.coerce.number().int().nonnegative().default(365),
});

const BOX_TRADES_ENABLED = process.env.NEXT_PUBLIC_DISPLAY_BOX_TRADES === "true";

export async function GET(request: NextRequest) {
  if (!BOX_TRADES_ENABLED) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const parsed = querySchema.safeParse({
    minDays: request.nextUrl.searchParams.get("minDays") ?? undefined,
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid parameters", details: parsed.error.issues },
      { status: 400 },
    );
  }

  const { minDays } = parsed.data;

  try {
    const { asOf, contracts, sizeModel } = await fetchSpxBoxtradesApyReport(minDays);
    return NextResponse.json(
      {
        symbol: "SPX",
        source: "https://www.boxtrades.com/",
        minDays,
        asOf,
        fetchedAt: new Date().toISOString(),
        formula:
          "apy = (1 + yieldPercent / 100 * daysToExpiry / 365) ** (365 / daysToExpiry) - 1",
        sizeModel,
        contracts,
      },
      {
        headers: buildApiCacheHeaders({
          maxAgeSeconds: 60 * 10,
          staleWhileRevalidateSeconds: 60 * 10,
        }),
      },
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to load Boxtrades data";
    console.error("Boxtrades SPX APY API error:", message);
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
