import { buildToolUrl } from "../snapshot-params.mjs";
import { gotoUi, waitForRunSummaryStable } from "../config.mjs";

export const name = "tr-benchmark-labels";

const SP500_TR = "VOO";
const NASDAQ_TR = "QQQ";

/** @param {{ baseUrl: string; page: import('puppeteer').Page }} ctx */
export async function run(ctx) {
  const url = buildToolUrl(ctx.baseUrl, "strategies", new URLSearchParams());

  await gotoUi(ctx.page, url);
  await waitForRunSummaryStable(ctx.page);

  const sweepRows = await ctx.page.evaluate(function () {
    const table = document.querySelector('[data-testid="snapshot-tool-sweep-main"]');
    return table ? table.querySelectorAll("tbody tr").length : 0;
  });
  if (sweepRows < 1) {
    throw new Error(`Expected at least one strategies sweep table row; got ${sweepRows}`);
  }

  const scoped = await ctx.page.evaluate(function (a, b) {
    const summary = document.querySelector('[data-testid="simulation-run-summary"]');
    const root =
      summary?.closest(".max-w-7xl") ?? document.querySelector(".max-w-7xl") ?? document.body;
    const text = root?.innerText ?? "";
    return { hasSp: text.includes(a), hasNq: text.includes(b), snippet: text.slice(0, 2000) };
  }, SP500_TR, NASDAQ_TR);

  if (!scoped.hasSp || !scoped.hasNq) {
    throw new Error(
      `Expected "${SP500_TR}" and "${NASDAQ_TR}" in main tool area.\nSnippet:\n${scoped.snippet}`
    );
  }
}
