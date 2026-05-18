import {
  readSnapshot,
  buildToolUrl,
} from "../snapshot-params.mjs";
import { gotoUi, waitForRunSummaryStable, normalizedRunSummaryText } from "../config.mjs";

export const name = "compare-letfs-run-summary-date-range";

/** @param {{ baseUrl: string; page: import('puppeteer').Page }} ctx */
export async function run(ctx) {
  const snapshot = readSnapshot("compare-letfs");
  const { startDate, endDate } = snapshot.pageState;
  const url = buildToolUrl(ctx.baseUrl, "strategies", new URLSearchParams());

  await gotoUi(ctx.page, url);
  await waitForRunSummaryStable(ctx.page);

  const text = await normalizedRunSummaryText(ctx.page);
  if (!text.includes(startDate) || !text.includes(endDate)) {
    throw new Error(
      `Expected run summary to include snapshot start/end (${startDate} … ${endDate}).\n${text.slice(0, 600)}`
    );
  }
}
