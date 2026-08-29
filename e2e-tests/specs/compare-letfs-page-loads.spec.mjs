import { gotoUi } from "../config.mjs";

export const name = "compare-letfs-page-loads";

export const tags = ["smoke"];

/**
 * Guards the standalone /compare-letfs route in production.
 *
 * The tools-page specs only reach this panel through /tools?tab=strategies, so a
 * break confined to the standalone route ships silently. Both routes render the
 * same component and both white-screened on 2026-08-29, when a close-less index
 * row made the engine throw during render — hence the assertion is that main has
 * content, which is exactly what a render-time throw takes away.
 *
 * @param {{ baseUrl: string; page: import('puppeteer').Page }} ctx
 */
export async function run(ctx) {
  const url = `${ctx.baseUrl.replace(/\/$/, "")}/compare-letfs`;
  await gotoUi(ctx.page, url);

  const hasContent = function () {
    const root = document.querySelector("main") ?? document.body;
    const text = root?.textContent ?? "";
    const heading = document.querySelector("h1")?.textContent?.trim() ?? "";
    return heading === "Strategies" && text.includes("Start Date") && text.includes("End Date");
  };

  await ctx.page.waitForFunction(hasContent, {
    timeout: Number(process.env.E2E_TEST_TIMEOUT_MS ?? 90000),
  });

  if (!(await ctx.page.evaluate(hasContent))) {
    throw new Error("Expected /compare-letfs to render the Strategies panel and its date inputs.");
  }
}
