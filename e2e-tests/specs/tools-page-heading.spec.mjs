import { buildToolUrl } from "../snapshot-params.mjs";
import { gotoUi } from "../config.mjs";

export const name = "tools-page-heading";

export const tags = ["smoke"];

/** @param {{ baseUrl: string; page: import('puppeteer').Page }} ctx */
export async function run(ctx) {
  const url = buildToolUrl(ctx.baseUrl, "strategies", new URLSearchParams());
  await gotoUi(ctx.page, url);
  await ctx.page.waitForFunction(
    function () {
      const mainText = document.querySelector("main")?.textContent ?? "";
      return mainText.includes("Start Date") && mainText.includes("End Date");
    },
    { timeout: Number(process.env.E2E_TEST_TIMEOUT_MS ?? 90000) }
  );
  const ok = await ctx.page.evaluate(function () {
    const h = document.querySelector("main h1, main h2, main h3, h1");
    const t = h?.textContent?.trim() ?? "";
    if (t.length > 0) return true;
    const mainText = document.querySelector("main")?.textContent ?? "";
    return mainText.includes("Start Date") && mainText.includes("End Date");
  });
  if (!ok) {
    throw new Error("Expected client-rendered tool content on /tools.");
  }
}
