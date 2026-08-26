import { gotoUi } from "../config.mjs";

export const name = "theme-toggle-present";

export const tags = ["smoke"];

/** @param {{ baseUrl: string; page: import('puppeteer').Page }} ctx */
export async function run(ctx) {
  await gotoUi(ctx.page, ctx.baseUrl);
  await ctx.page.waitForFunction(
    function () {
      const btn = [...document.querySelectorAll("header button")].find(
        (b) => b.getAttribute("aria-label") === "Toggle dark mode"
      );
      return Boolean(btn);
    },
    { timeout: Number(process.env.UI_TEST_TIMEOUT_MS ?? 90000) }
  );
}
