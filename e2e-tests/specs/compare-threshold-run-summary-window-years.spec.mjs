import {
  readSnapshot,
  buildToolUrl,
} from "../snapshot-params.mjs";
import { gotoUi, waitForRunSummaryStable, normalizedRunSummaryText } from "../config.mjs";

export const name = "compare-threshold-run-summary-window-years";

/** @param {{ baseUrl: string; page: import('puppeteer').Page }} ctx */
export async function run(ctx) {
  const snapshot = readSnapshot("compare-threshold");
  const py = snapshot.pageState.windowLength;
  const url = buildToolUrl(ctx.baseUrl, "sma-buffer", new URLSearchParams());

  await gotoUi(ctx.page, url);
  await waitForRunSummaryStable(ctx.page);

  const text = await normalizedRunSummaryText(ctx.page);
  if (!text.includes(String(py))) {
    throw new Error(`Expected window length ${py} in run summary.\n${text.slice(0, 500)}`);
  }
}
