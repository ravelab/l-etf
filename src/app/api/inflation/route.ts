import { NextRequest, NextResponse } from "next/server";
import { z } from "zod/v4";
import { buildApiCacheHeaders } from "@/lib/api/cache-headers";
import { withCsvCacheDiagnostics } from "@/lib/data/storage/local";
import { getInflation } from "@/lib/db/queries";

const querySchema = z.object({
  startDate: z.iso.date(),
  endDate: z.iso.date(),
});

/**
 * Compute annualized inflation between two dates using CPI observations.
 * Uses the last observation <= startDate and last observation <= endDate.
 */
function computeAnnualizedInflation(
  observations: Array<{ date: string; value: number }>,
  startDate: string,
  endDate: string,
): number {
  if (observations.length < 2) return 0;
  let startCpi = NaN;
  let endCpi = NaN;
  for (const obs of observations) {
    if (obs.date <= startDate) startCpi = obs.value;
    if (obs.date <= endDate) endCpi = obs.value;
  }
  if (isNaN(startCpi) || isNaN(endCpi) || startCpi <= 0) return 0;
  const years =
    (new Date(endDate).getTime() - new Date(startDate).getTime()) /
    (365.25 * 24 * 60 * 60 * 1000);
  if (years <= 0) return 0;
  return Math.pow(endCpi / startCpi, 1 / years) - 1;
}

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

  try {
    // We need all observations to find the start/end CPI accurately, 
    // but we'll also fetch a filtered range for the chart.
    const { value: allObservations, sources } = await withCsvCacheDiagnostics(() =>
      getInflation("1800-01-01", endDate)
    );

    // Filter to range for display: include observations from 2 months before startDate
    // so annualizedInflationForRange() has a CPI value before the start
    const rangeStartDate = new Date(`${startDate}T00:00:00Z`);
    rangeStartDate.setUTCMonth(rangeStartDate.getUTCMonth() - 2);
    const rangeStart = rangeStartDate.toISOString().slice(0, 10);

    const filtered = allObservations.filter(
      (o) => o.date >= rangeStart && o.date <= endDate
    );

    const annualizedInflation = computeAnnualizedInflation(
      allObservations,
      startDate,
      endDate,
    );

    const monthlyCpi = filtered.map((o) => ({ date: o.date, value: o.value }));

    return NextResponse.json(
      { annualizedInflation, monthlyCpi },
      {
        headers: buildApiCacheHeaders({
          maxAgeSeconds: 60 * 60 * 24,
          staleWhileRevalidateSeconds: 60 * 60 * 24 * 7,
          dataCacheSources: sources,
        }),
      }
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to load inflation data";
    console.error("Inflation API error:", message);
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
