import { buildToolUrl } from "../snapshot-params.mjs";
import { gotoUi } from "../config.mjs";

export const name = "header-nav-to-sma-period";

/** @param {{ baseUrl: string; page: import('puppeteer').Page }} ctx */
export async function run(ctx) {
  const url = buildToolUrl(ctx.baseUrl, "strategies", new URLSearchParams());

  await gotoUi(ctx.page, url);

  const link = await ctx.page.waitForSelector('a[href*="tab=sma-period"]');
  await link.click();
  await ctx.page.waitForFunction(function () {
    return new URLSearchParams(window.location.search).get("tab") === "sma-period";
  });

  const u = ctx.page.url();
  if (!u.includes("tab=sma-period")) {
    throw new Error(`Expected navigation to SMA Period tab. URL: ${u}`);
  }
}
