import { gotoUi } from "../config.mjs";

export const name = "signals-page-loads";

/** @param {{ baseUrl: string; page: import('puppeteer').Page }} ctx */
export async function run(ctx) {
  const url = `${ctx.baseUrl.replace(/\/$/, "")}/signals`;
  await gotoUi(ctx.page, url);
  const ok = await ctx.page.evaluate(function () {
    const t = document.body?.innerText ?? "";
    return t.length > 80;
  });
  if (!ok) {
    throw new Error("Expected body text on /signals.");
  }
}
