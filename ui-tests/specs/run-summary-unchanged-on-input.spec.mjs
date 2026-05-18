import { buildToolUrl } from "../snapshot-params.mjs";
import { gotoUi, waitForRunSummaryStable, normalizedRunSummaryText } from "../config.mjs";

export const name = "run-summary-unchanged-on-input";

/**
 * Change start date without clicking Run — run summary must stay frozen.
 * @param {{ baseUrl: string; page: import('puppeteer').Page }} ctx
 */
export async function run(ctx) {
  const url = buildToolUrl(ctx.baseUrl, "riskoff", new URLSearchParams());

  await gotoUi(ctx.page, url);
  await waitForRunSummaryStable(ctx.page);

  const before = await normalizedRunSummaryText(ctx.page);
  if (!before) {
    throw new Error("Run summary text was empty after stabilization.");
  }

  await ctx.page.click('[data-testid="shared-tool-start-date"]', { clickCount: 3 });
  await ctx.page.keyboard.press("Backspace");
  await ctx.page.keyboard.type("20000115");
  await ctx.page.keyboard.press("Tab");

  await new Promise((r) => setTimeout(r, 450));

  const after = await normalizedRunSummaryText(ctx.page);
  if (after !== before) {
    throw new Error(
      `Run summary changed after editing start date without re-run.\nBefore: ${before}\nAfter: ${after}`
    );
  }
}
