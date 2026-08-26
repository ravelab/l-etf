import {
  readSnapshot,
  buildToolUrl,
} from "../snapshot-params.mjs";
import { gotoUi, waitForRunSummaryStable, normalizedRunSummaryText } from "../config.mjs";

export const name = "compare-sma-run-summary-window-years";

/** @param {{ baseUrl: string; page: import('puppeteer').Page }} ctx */
export async function run(ctx) {
  const snapshot = readSnapshot("compare-sma");
  const py = snapshot.pageState.windowLength;
  const url = buildToolUrl(ctx.baseUrl, "sma-period", new URLSearchParams());

  await gotoUi(ctx.page, url);
  await waitForRunSummaryStable(ctx.page);

  const text = await normalizedRunSummaryText(ctx.page);
  if (!text.includes(String(py))) {
    throw new Error(`Expected window length ${py} in run summary.\n${text.slice(0, 500)}`);
  }
}
