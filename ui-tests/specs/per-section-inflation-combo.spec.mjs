import { buildToolUrl } from "../snapshot-params.mjs";
import { gotoUi, waitForRunSummaryStable } from "../config.mjs";

export const name = "per-section-inflation-combo";

/**
 * Combo risk-off mode renders one section per LETF. Each section title carries a
 * Start Date and Avg Inflation. When index data histories differ those values
 * diverge; when the shared run start binds both (e.g. both clamp to 1988-04-06)
 * they may match — still require two labeled sections with both fields present.
 * @param {{ baseUrl: string; page: import('puppeteer').Page }} ctx
 */
export async function run(ctx) {
  const url = buildToolUrl(ctx.baseUrl, "riskoff", new URLSearchParams());

  await gotoUi(ctx.page, url);
  await waitForRunSummaryStable(ctx.page, { timeoutMs: 90000 });

  const parsed = await ctx.page.evaluate(function () {
    const h2Texts = [...document.querySelectorAll("h2")]
      .map((h) => (h.textContent ?? "").replace(/\s+/g, " ").trim())
      .filter((t) => t.includes("Performance by Risk-Off Asset"));
    const startDates = h2Texts
      .map((t) => {
        const m = t.match(/Start Date:\s*(\d{4}-\d{2}-\d{2})/);
        return m ? m[1] : null;
      })
      .filter(Boolean);
    const inflPercents = h2Texts
      .map((t) => {
        const m = t.match(/Avg Inflation:\s*([\d,.]+%)/);
        return m ? m[1] : null;
      })
      .filter(Boolean);
    return { h2Texts, startDates, inflPercents };
  });

  if (parsed.h2Texts.length < 2) {
    throw new Error(
      `Expected two combo Risk-Off section titles, got ${parsed.h2Texts.length}: ${JSON.stringify(parsed.h2Texts)}`,
    );
  }
  if (parsed.startDates.length < 2) {
    throw new Error(
      `Expected Start Date on each combo section, got ${JSON.stringify(parsed.startDates)} from ${JSON.stringify(parsed.h2Texts)}`,
    );
  }
  if (parsed.inflPercents.length < 2) {
    throw new Error(
      `Expected Avg Inflation on each combo section, got ${JSON.stringify(parsed.inflPercents)} from ${JSON.stringify(parsed.h2Texts)}`,
    );
  }
}
