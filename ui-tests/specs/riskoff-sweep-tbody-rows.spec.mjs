import { buildToolUrl } from "../snapshot-params.mjs";
import { gotoUi, waitForRunSummaryStable } from "../config.mjs";

export const name = "riskoff-sweep-tbody-rows";

/** @param {{ baseUrl: string; page: import('puppeteer').Page }} ctx */
export async function run(ctx) {
  const url = buildToolUrl(ctx.baseUrl, "riskoff", new URLSearchParams());

  await gotoUi(ctx.page, url);
  await waitForRunSummaryStable(ctx.page);

  const n = await ctx.page.evaluate(function () {
    let total = 0;
    for (const table of document.querySelectorAll('table[data-testid^="snapshot-tool-sweep"]')) {
      total += table.querySelectorAll("tbody tr").length;
    }
    return total;
  });

  if (n < 1) {
    throw new Error(`Expected at least one risk-off sweep row; got ${n}`);
  }
}
