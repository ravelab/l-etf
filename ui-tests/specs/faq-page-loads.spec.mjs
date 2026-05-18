import { gotoUi } from "../config.mjs";

export const name = "faq-page-loads";

/** @param {{ baseUrl: string; page: import('puppeteer').Page }} ctx */
export async function run(ctx) {
  const url = `${ctx.baseUrl.replace(/\/$/, "")}/faq`;
  await gotoUi(ctx.page, url);
  const ok = await ctx.page.evaluate(function () {
    const t = document.body?.innerText ?? "";
    return t.length > 200 && /leveraged etf/i.test(t);
  });
  if (!ok) {
    throw new Error("Expected FAQ body content on /faq.");
  }
}
