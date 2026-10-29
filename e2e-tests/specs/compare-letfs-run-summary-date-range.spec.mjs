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

  // With the vol gate on by default the page runs live instead of showing the
  // snapshot, so its end date is the latest market day rather than the snapshot's.
  const text = await normalizedRunSummaryText(ctx.page);
  const datesInText = text.match(/\d{4}-\d{2}-\d{2}/g) ?? [];
  const endsOnOrAfter = datesInText.some((date) => date >= endDate);
  if (!text.includes(startDate) || !endsOnOrAfter) {
    throw new Error(
      `Expected run summary to start at ${startDate} and end on or after ${endDate}.\n${text.slice(0, 600)}`
    );
  }
}
