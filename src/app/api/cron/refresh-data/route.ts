import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import {
  clearCronTriggeredBuildMarker,
  markNextBuildAsCronTriggered,
  readLastCronTriggerNyDate,
  recordCronTriggerNyDate,
} from "@/lib/cron-build-marker";
import { fetchYahooDailyLatestClose } from "@/lib/data/fetcher";
import { getNewYorkIsoDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

const DATA_DIR = join(process.cwd(), "data");

function authorizeCronRequest(request: NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { success: false, error: "Cron authentication is not configured" },
      { status: 503 },
    );
  }

  const expected = `Bearer ${secret}`;
  if (request.headers.get("authorization") !== expected) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  return null;
}

async function readLastCsvDate(filename: string): Promise<string | null> {
  try {
    const raw = await readFile(join(DATA_DIR, filename), "utf8");
    const lines = raw.split(/\r?\n/).filter((line) => line.trim() !== "");
    if (lines.length < 2) return null;
    return lines[lines.length - 1].split(",")[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Cron endpoint that checks recent SPX/NDX closes against the bundled CSVs.
 * If Yahoo is ahead of the current bundled `index-sp.csv` / `index-nq.csv`,
 * it triggers a Vercel build so `npm run fetch-data` can append close-only rows
 * and later backfill adjusted values from Tiingo.
 */
export async function GET(request: NextRequest) {
  const unauthorized = authorizeCronRequest(request);
  if (unauthorized) return unauthorized;

  try {
    console.log("[refresh-data] Checking recent SPX/NDX closes...");

    const currentNyDate = getNewYorkIsoDate();
    const lastTriggerNyDate = await readLastCronTriggerNyDate();
    if (lastTriggerNyDate && lastTriggerNyDate >= currentNyDate) {
      console.log(
        `[refresh-data] Already triggered a build today (NY ${currentNyDate}, last trigger ${lastTriggerNyDate}); skipping`
      );
      return NextResponse.json({
        success: true,
        triggered: false,
        reason: "Already triggered a build for the current NY date",
        currentNyDate,
        lastTriggerNyDate,
      });
    }

    const [lastSpDate, lastNqDate, spQuote, nqQuote] = await Promise.all([
      readLastCsvDate("index-sp.csv"),
      readLastCsvDate("index-nq.csv"),
      fetchYahooDailyLatestClose("^GSPC"),
      fetchYahooDailyLatestClose("^NDX"),
    ]);

    console.log(
      `[refresh-data] Last bundled dates: SP500=${lastSpDate ?? "none"} NASDAQ100=${lastNqDate ?? "none"}`
    );
    console.log(
      `[refresh-data] Recent closes: SP500=${spQuote ? `${spQuote.date} (${spQuote.close})` : "unavailable"} NASDAQ100=${nqQuote ? `${nqQuote.date} (${nqQuote.close})` : "unavailable"}`
    );
    console.log(
      `[refresh-data] Close fetch outcomes: SP500=${spQuote ? "ok" : "missing"} NASDAQ100=${nqQuote ? "ok" : "missing"}`
    );

    const newer = {
      sp500: Boolean(spQuote && (!lastSpDate || spQuote.date > lastSpDate)),
      nasdaq100: Boolean(nqQuote && (!lastNqDate || nqQuote.date > lastNqDate)),
    };

    console.log(
      `[refresh-data] Freshness result: SP500=${newer.sp500 ? "newer" : "current"} NASDAQ100=${newer.nasdaq100 ? "newer" : "current"}`
    );

    if (!newer.sp500 && !newer.nasdaq100) {
      console.log("[refresh-data] No newer closes yet; skipping deployment");
      return NextResponse.json({
        success: true,
        triggered: false,
        reason: "No newer index closes yet",
        sp500: { lastCsvDate: lastSpDate, yahoo: spQuote },
        nasdaq100: { lastCsvDate: lastNqDate, yahoo: nqQuote },
      });
    }

    const deployHookUrl = process.env.VERCEL_DEPLOYMENT_HOOK_URL;
    if (!deployHookUrl) {
      console.warn("[refresh-data] VERCEL_DEPLOYMENT_HOOK_URL is not configured; cannot trigger deployment");
      return NextResponse.json({
        success: true,
        triggered: false,
        reason: "Deploy hook URL not configured",
        newer,
        sp500: { lastCsvDate: lastSpDate, yahoo: spQuote },
        nasdaq100: { lastCsvDate: lastNqDate, yahoo: nqQuote },
      });
    }

    console.log(
      `[refresh-data] Triggering Vercel deployment because ${[
        newer.sp500 ? `SP500=${spQuote?.date ?? "unknown"}` : null,
        newer.nasdaq100 ? `NASDAQ100=${nqQuote?.date ?? "unknown"}` : null,
      ].filter(Boolean).join(", ")}`
    );

    const markedCronBuild = await markNextBuildAsCronTriggered({
      source: "refresh-data-cron",
      newer,
      sp500Date: spQuote?.date ?? null,
      nasdaq100Date: nqQuote?.date ?? null,
    });
    if (!markedCronBuild) {
      console.warn("[refresh-data] Cron build marker was not stored; SMA push alerts will be skipped for the triggered build");
    }

    const deployResponse = await fetch(deployHookUrl, {
      method: "POST",
      signal: AbortSignal.timeout(30000),
    });

    if (!deployResponse.ok) {
      const deployBody = await deployResponse.text().catch(() => "");
      console.error(`[refresh-data] Deployment trigger failed: ${deployResponse.status}`, deployBody);
      console.error("[refresh-data] Deployment was not triggered; will retry on the next cron run");
      if (markedCronBuild) {
        await clearCronTriggeredBuildMarker();
      }
      return NextResponse.json({
        success: true,
        triggered: false,
        error: `Failed to trigger deployment (${deployResponse.status})`,
        newer,
        sp500: { lastCsvDate: lastSpDate, yahoo: spQuote },
        nasdaq100: { lastCsvDate: lastNqDate, yahoo: nqQuote },
      });
    }

    const recordedDailyLock = await recordCronTriggerNyDate(currentNyDate);
    if (!recordedDailyLock) {
      console.warn("[refresh-data] Daily trigger lock was not recorded; subsequent crons today will not be deduplicated");
    }

    return NextResponse.json({
      success: true,
      triggered: true,
      message: "New index close detected and deployment triggered",
      markedCronBuild,
      recordedDailyLock,
      currentNyDate,
      newer,
      sp500: { lastCsvDate: lastSpDate, yahoo: spQuote },
      nasdaq100: { lastCsvDate: lastNqDate, yahoo: nqQuote },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[refresh-data] Fatal error:", err);
    return NextResponse.json(
      {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }
}
