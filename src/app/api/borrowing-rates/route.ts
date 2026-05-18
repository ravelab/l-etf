import { NextRequest, NextResponse } from "next/server";
import { z } from "zod/v4";
import { buildApiCacheHeaders } from "@/lib/api/cache-headers";
import { withCsvCacheDiagnostics } from "@/lib/data/storage/local";
import { getBorrowRate } from "@/lib/db/queries";

const querySchema = z.object({
  startDate: z.iso.date(),
  endDate: z.iso.date(),
});

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;

  const parsed = querySchema.safeParse({
    startDate: searchParams.get("startDate"),
    endDate: searchParams.get("endDate"),
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid parameters", details: parsed.error.issues },
      { status: 400 }
    );
  }

  const { startDate, endDate } = parsed.data;
  const { value: rates, sources } = await withCsvCacheDiagnostics(() =>
    getBorrowRate(startDate, endDate)
  );

  const response = rates.map((r) => ({
    date: r.date,
    rateType: "borrow",
    rateValue: r.value,
  }));

  return NextResponse.json(response, {
    headers: buildApiCacheHeaders({ dataCacheSources: sources }),
  });
}
