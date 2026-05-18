import { buildToolUrl } from "../snapshot-params.mjs";
import { gotoUi, waitForRunSummaryStable } from "../config.mjs";

export const name = "per-section-inflation-combo";

/** @param {{ baseUrl: string; page: import('puppeteer').Page }} ctx */
export async function run(ctx) {
  const url = buildToolUrl(ctx.baseUrl, "riskoff", new URLSearchParams());

  await gotoUi(ctx.page, url);
  await waitForRunSummaryStable(ctx.page, { timeoutMs: 90000 });

  const parsed = await ctx.page.evaluate(function () {
    const body = document.body?.innerText ?? "";
    const h2Texts = [...document.querySelectorAll("h2")]
      .map((h) => (h.textContent ?? "").replace(/\s+/g, " ").trim())
      .filter((t) => t.includes("Performance by Risk-Off Asset"));
    const startDates = h2Texts
      .map((t) => {
        const m = t.match(/Start Date:\s*(\d{4}-\d{2}-\d{2})/);
        return m ? m[1] : null;
      })
      .filter(Boolean);

    const inflRe = /Avg Inflation:\s*([\d,.]+%)/g;
    const inflPercents = [];
    let m;
    while ((m = inflRe.exec(body)) !== null) inflPercents.push(m[1]);

    return { h2Texts, startDates, inflPercents, preview: body.slice(0, 2200) };
  });

  const uniqStarts = [...new Set(parsed.startDates)];
  if (uniqStarts.length >= 2) {
    return;
  }

  const uniqInfl = [...new Set(parsed.inflPercents)];
  if (parsed.inflPercents.length >= 2 && uniqInfl.length >= 2) {
    return;
  }

  throw new Error(
    `Combo sections should show two distinct section Start Dates (per-index effective range), or two distinct Avg Inflation lines when wrap applies.\n` +
      `Section h2: ${JSON.stringify(parsed.h2Texts)}\n` +
      `Start dates: ${JSON.stringify(parsed.startDates)}\n` +
      `Avg Inflation matches: ${JSON.stringify(parsed.inflPercents)}\n` +
      parsed.preview
  );
}
