import { buildToolUrl } from "../snapshot-params.mjs";
import { gotoUi } from "../config.mjs";

export const name = "futures-tab-loads";

/** @param {{ baseUrl: string; page: import('puppeteer').Page }} ctx */
export async function run(ctx) {
  const url = buildToolUrl(ctx.baseUrl, "futures", new URLSearchParams());
  await gotoUi(ctx.page, url);

  await ctx.page.waitForFunction(
    function () {
      const text = document.querySelector("main")?.textContent ?? document.body?.innerText ?? "";
      return text.includes("Futures") && text.includes("Run Futures");
    },
    { timeout: Number(process.env.E2E_TEST_TIMEOUT_MS ?? 90000) }
  );
}

