import { NextResponse } from "next/server";
import { getPriceDateBounds } from "@/lib/db/queries";

const ETF_SYMBOLS = ["UPRO", "TQQQ", "SSO", "QLD"] as const;

export async function GET() {
  const launchDateEntries = await Promise.all(
    ETF_SYMBOLS.map(async (symbol) => {
      const bounds = await getPriceDateBounds(`etf:${symbol}`);
      return [symbol, bounds?.minDate ?? ""] as const;
    })
  );

  return NextResponse.json(Object.fromEntries(launchDateEntries), {
    headers: {
      "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
