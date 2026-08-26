import { gotoUi } from "../config.mjs";

export const name = "home-page-loads";

export const tags = ["smoke"];

/** @param {{ baseUrl: string; page: import('puppeteer').Page }} ctx */
export async function run(ctx) {
  await gotoUi(ctx.page, ctx.baseUrl);
  const title = await ctx.page.title();
  if (!title || title.length < 2) {
    throw new Error("Expected document title on home page.");
  }
  const hasMain = await ctx.page.evaluate(function () {
    return Boolean(document.querySelector("main") || document.querySelector("h1"));
  });
  if (!hasMain) {
    throw new Error("Expected main landmark or h1 on home page.");
  }
}
