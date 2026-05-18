import {
  readSnapshot,
  buildCompareLetfsParams,
  buildToolUrl,
} from "../snapshot-params.mjs";

export const name = "tools-compare-url-includes-tab";

/** @param {{ baseUrl: string; page: import('puppeteer').Page }} ctx */
export async function run(ctx) {
  const snapshot = readSnapshot("compare-letfs");
  const params = buildCompareLetfsParams(snapshot.pageState);
  const url = buildToolUrl(ctx.baseUrl, "strategies", params);

  const u = new URL(url);
  if (u.searchParams.get("tab") !== "strategies") {
    throw new Error(`Expected tab=strategies in tools URL, got ${u.search}`);
  }
  if (u.searchParams.get("autorun") !== "1") {
    throw new Error("Expected autorun=1 for snapshot-based tools URL.");
  }
}
