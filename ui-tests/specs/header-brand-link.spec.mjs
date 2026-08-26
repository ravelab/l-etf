import { gotoUi } from "../config.mjs";

export const name = "header-brand-link";

export const tags = ["smoke"];

/** @param {{ baseUrl: string; page: import('puppeteer').Page }} ctx */
export async function run(ctx) {
  await gotoUi(ctx.page, ctx.baseUrl);
  // The Header component bails out to client-side rendering (uses useSearchParams),
  // so wait for hydration to insert the brand link before asserting.
  await ctx.page.waitForSelector('header a[href="/"]', { timeout: 10000 });
  const href = await ctx.page.evaluate(function () {
    const a = document.querySelector('header a[href="/"]');
    return a?.getAttribute("href") ?? "";
  });
  if (href !== "/") {
    throw new Error(`Expected header home link href="/", got "${href}"`);
  }
}
