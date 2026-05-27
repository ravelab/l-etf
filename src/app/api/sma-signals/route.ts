import { NextRequest, NextResponse } from "next/server";
import { z } from "zod/v4";
import storage from "@/lib/data/storage";
import { computeSmaSignalSnapshot, getDefaultSmaSignalConfig } from "@/lib/sma-status";
import type { SmaSignalResult } from "@/lib/sma-signals";

const querySchema = z.object({
  smaSpPeriod: z.coerce.number().min(5).max(500),
  smaSpUpperBuffer: z.coerce.number().min(0).max(30),
  smaSpLowerBuffer: z.coerce.number().min(0).max(30),
  smaNqPeriod: z.coerce.number().min(5).max(500),
  smaNqUpperBuffer: z.coerce.number().min(0).max(30),
  smaNqLowerBuffer: z.coerce.number().min(0).max(30),
});

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const defaults = getDefaultSmaSignalConfig();

  const parsed = querySchema.safeParse({
    smaSpPeriod: searchParams.get("smaSpPeriod") || String(defaults.smaSpPeriod),
    smaSpUpperBuffer: searchParams.get("smaSpUpperBuffer") || String(defaults.smaSpUpperBuffer),
    smaSpLowerBuffer: searchParams.get("smaSpLowerBuffer") || String(defaults.smaSpLowerBuffer),
    smaNqPeriod: searchParams.get("smaNqPeriod") || String(defaults.smaNqPeriod),
    smaNqUpperBuffer: searchParams.get("smaNqUpperBuffer") || String(defaults.smaNqUpperBuffer),
    smaNqLowerBuffer: searchParams.get("smaNqLowerBuffer") || String(defaults.smaNqLowerBuffer),
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid parameters", details: parsed.error.issues },
      { status: 400 }
    );
  }

  const { smaSpPeriod, smaSpUpperBuffer, smaSpLowerBuffer, smaNqPeriod, smaNqUpperBuffer, smaNqLowerBuffer } = parsed.data;

  try {
    // Fetch latest prices for both indexes (last 2 years of data for SMA calculation)
    const endDate = new Date().toISOString().slice(0, 10);
    const startDate = new Date(Date.now() - 2 * 365.25 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const [sp500Prices, nasdaqPrices] = await Promise.all([
      storage.getPrices("sp500", startDate, endDate),
      storage.getPrices("nasdaq100", startDate, endDate),
    ]);

    if (sp500Prices.length === 0) {
      return NextResponse.json(
        {
          error: `SPX price data unavailable for ${startDate} to ${endDate}. The cron job may not have completed successfully. Check Vercel function logs at /api/cron/refresh-data`,
          details: {
            requestedRange: { startDate, endDate },
            sp500Rows: 0,
            nasdaq100Rows: nasdaqPrices.length,
            troubleshooting: [
              "Run npm run fetch-data to refresh CSV files in ./data",
              "Check that CSV files exist in ./data",
              "Or trigger the cron endpoint: curl -H \"Authorization: Bearer $CRON_SECRET\" $YOUR_HOST/api/cron/refresh-data"
            ]
          }
        },
        { status: 503 }
      );
    }

    if (nasdaqPrices.length === 0) {
      return NextResponse.json(
        {
          error: `NDX price data unavailable for ${startDate} to ${endDate}. The cron job may not have completed successfully. Check Vercel function logs at /api/cron/refresh-data`,
          details: {
            requestedRange: { startDate, endDate },
            sp500Rows: sp500Prices.length,
            nasdaq100Rows: 0,
            troubleshooting: [
              "Run npm run fetch-data to refresh CSV files in ./data",
              "Check that CSV files exist in ./data",
              "Or trigger the cron endpoint: curl -H \"Authorization: Bearer $CRON_SECRET\" $YOUR_HOST/api/cron/refresh-data"
            ]
          }
        },
        { status: 503 }
      );
    }

    // Compute signals (pass full price objects with dates)
    const result = computeSmaSignalSnapshot({
      sp500Prices,
      nasdaqPrices,
      config: {
        ...getDefaultSmaSignalConfig(),
        smaSpPeriod,
        smaSpUpperBuffer, smaSpLowerBuffer,
        smaNqPeriod,
        smaNqUpperBuffer, smaNqLowerBuffer,
      },
    }) satisfies {
      sp500: SmaSignalResult;
      nasdaq100: SmaSignalResult;
      timestamp: string;
    };

    return NextResponse.json(result, {
      headers: {
        "Cache-Control": "public, s-maxage=300, stale-while-revalidate=3600",
      },
    });
  } catch (error) {
    console.error("SMA signals API error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to compute SMA signals" },
      { status: 500 }
    );
  }
}
