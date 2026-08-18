/**
 * Build `data/index-ndx-1985.csv` — real Nasdaq-100 daily closes for the window
 * between the index's launch (1985-01-31) and the first date Yahoo's `^NDX`
 * covers (1985-10-01).
 *
 * Without this, `fetch-data.ts` backfills those 167 sessions from the Nasdaq
 * *Composite* scaled onto the NDX price level, which is a different basket: it
 * differs from the real index by 0.28%/day at the median and drifts 12.96% over
 * the window.
 *
 * Source is the index owner's own Global Index Watch history endpoint, the same
 * one indexes.nasdaqomx.com/Index/History/NDX drives. It is unauthenticated and
 * free. Beware third-party "NDX" history for this era: vendor files that appear
 * to reach back further are Composite back-propagation, not archive (Stooq's
 * `^ndx` export starts in 1938, decades before the Composite itself existed, and
 * reproduces our Composite proxy to 0.0045%).
 *
 * The endpoint publishes closes only. Its start-of-day series is just the prior
 * close, so no genuine opening print exists for this era — `fetch-data.ts`
 * carries the prior close forward as the open, which is what Yahoo's own early
 * `^NDX` rows do.
 *
 * Usage:
 *   npx tsx scripts/build-ndx-1985.ts
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

const GIW_HISTORY_URL = "https://indexes.nasdaqomx.com/Index/HistoryData";
const OUTPUT_PATH = join(process.cwd(), "data", "index-ndx-1985.csv");

/** Nasdaq-100 launch. The index's own history starts here, at a base of 125. */
const NDX_LAUNCH_DATE = "1985-01-31";
/** Pull through year end so the splice seam can be validated against Yahoo `^NDX`. */
const FETCH_END_DATE = "1985-12-31";
const SOURCE_TAG = "nasdaq-giw(close)";

type GiwRow = { TimeStamp: string; Value: number | null };

/** `/Date(504853200000)/` in US/Eastern -> `YYYY-MM-DD`. */
function parseGiwTimestamp(stamp: string): string {
  const ms = Number(stamp.replace(/[^0-9-]/g, ""));
  if (!Number.isFinite(ms)) throw new Error(`Unparseable GIW timestamp: ${stamp}`);
  // The feed stamps midnight Eastern; shift onto UTC before taking the date part.
  return new Date(ms + 5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function fetchNdxHistory(startDate: string, endDate: string): Promise<Array<{ date: string; close: number }>> {
  const body = new URLSearchParams({
    id: "NDX",
    startDate: `${startDate}T00:00:00.000`,
    endDate: `${endDate}T00:00:00.000`,
    timeOfDay: "EOD",
  });
  const res = await fetch(GIW_HISTORY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      Referer: "https://indexes.nasdaqomx.com/Index/History/NDX",
    },
    body,
  });
  if (!res.ok) throw new Error(`GIW history request failed: ${res.status} ${res.statusText}`);

  const payload = (await res.json()) as { aaData?: GiwRow[] };
  const rows = (payload.aaData ?? [])
    .map((row) => ({ date: parseGiwTimestamp(row.TimeStamp), close: Number(row.Value) }))
    .filter((row) => Number.isFinite(row.close) && row.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (rows.length === 0) throw new Error("GIW returned no usable NDX rows");
  return rows;
}

async function main() {
  const rows = await fetchNdxHistory(NDX_LAUNCH_DATE, FETCH_END_DATE);

  if (rows[0].date !== NDX_LAUNCH_DATE) {
    throw new Error(`Expected history to start at the ${NDX_LAUNCH_DATE} launch, got ${rows[0].date}`);
  }
  // The launch base is 125; a different value means the feed rebased under us and
  // the spliced levels would no longer meet Yahoo's series at the seam.
  if (Math.abs(rows[0].close - 125) > 0.01) {
    throw new Error(`Expected a launch base of 125.00, got ${rows[0].close}`);
  }

  const header = "date,close,name,source";
  const lines = rows.map((row) => `${row.date},${row.close},NDX,${SOURCE_TAG}`);
  writeFileSync(OUTPUT_PATH, `${[header, ...lines].join("\n")}\n`);
  console.log(`  ✓ index-ndx-1985: wrote ${rows.length} rows (${rows[0].date}..${rows[rows.length - 1].date}) to ${OUTPUT_PATH}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
