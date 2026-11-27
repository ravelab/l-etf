import { NextRequest, NextResponse } from "next/server";
import { z } from "zod/v4";
import { loadCurrentSmaSignals, SmaMarketDataUnavailable } from "@/lib/sma-status";

const querySchema = z.object({
  smaSpPeriod: z.coerce.number().min(5).max(500).optional(),
  smaSpUpperBuffer: z.coerce.number().min(0).max(30).optional(),
  smaSpLowerBuffer: z.coerce.number().min(0).max(30).optional(),
  smaNqPeriod: z.coerce.number().min(5).max(500).optional(),
  smaNqUpperBuffer: z.coerce.number().min(0).max(30).optional(),
  smaNqLowerBuffer: z.coerce.number().min(0).max(30).optional(),
  smaSpHigherTurnover: z.literal("1").transform(() => true).optional(),
  smaNqHigherTurnover: z.literal("1").transform(() => true).optional(),
  smaVolGate: z.enum(["0", "1"]).transform(value => value === "1").optional(),
  smaInflationAdjusted: z.enum(["0", "1"]).transform(value => value === "1").optional(),
});

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const parsed = querySchema.safeParse(Object.fromEntries(
    Object.keys(querySchema.shape).flatMap(key => {
      const value = params.get(key);
      return value ? [[key, value]] : [];
    }),
  ));

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid parameters", details: parsed.error.issues },
      { status: 400 },
    );
  }

  try {
    const { signals } = await loadCurrentSmaSignals(parsed.data);
    return NextResponse.json(signals, {
      headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=3600" },
    });
  } catch (error) {
    const status = error instanceof SmaMarketDataUnavailable ? 503 : 500;
    if (status === 500) console.error("SMA signals API error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to compute SMA signals" },
      { status },
    );
  }
}
