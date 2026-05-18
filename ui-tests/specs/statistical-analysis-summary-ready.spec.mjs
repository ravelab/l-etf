import { buildToolUrl } from "../snapshot-params.mjs";
import { gotoUi, waitForRunSummaryStable } from "../config.mjs";

export const name = "statistical-analysis-summary-ready";

/**
 * Tab-only URL so the server snapshot hydrates Holding Period (same rationale as backtest-summary-ready).
 * @param {{ baseUrl: string; page: import('puppeteer').Page }} ctx
 */
export async function run(ctx) {
  const url = buildToolUrl(ctx.baseUrl, "statistics", new URLSearchParams());

  await gotoUi(ctx.page, url);
  await waitForRunSummaryStable(ctx.page, { requireSweepTable: false });

  const text = await ctx.page.evaluate(function () {
    return document.body?.innerText ?? "";
  });
  if (!text.includes("Holding Period")) {
    throw new Error("Expected Holding Period tooling on statistics tab.");
  }
  const summary = await ctx.page.evaluate(function () {
    const el = document.querySelector('[data-testid="simulation-run-summary"]');
    return el ? el.textContent ?? "" : "";
  });
  if (!summary.includes("UPRO") && !summary.includes("TQQQ")) {
    throw new Error("Expected LETF preset in run summary on Holding Period tab.");
  }
}
