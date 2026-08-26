import { gotoUi } from "../config.mjs";

export const name = "tools-page-loads";

export const tags = ["smoke"];

/** @param {{ baseUrl: string; page: import('puppeteer').Page }} ctx */
export async function run(ctx) {
  const url = `${ctx.baseUrl.replace(/\/$/, "")}/tools`;
  await gotoUi(ctx.page, url);
  await ctx.page.waitForFunction(
    function () {
      const t = document.querySelector("main")?.textContent ?? document.body?.innerText ?? "";
      return t.includes("Start Date") && t.includes("End Date");
    },
    { timeout: Number(process.env.UI_TEST_TIMEOUT_MS ?? 90000) }
  );
  const ok = await ctx.page.evaluate(function () {
    const t = document.querySelector("main")?.textContent ?? document.body?.innerText ?? "";
    return t.includes("Start Date") && t.includes("End Date");
  });
  if (!ok) {
    throw new Error("Expected tools page to load and display common tool text.");
  }
}
