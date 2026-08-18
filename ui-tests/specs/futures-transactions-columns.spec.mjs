import { buildToolUrl } from "../snapshot-params.mjs";
import { gotoUi } from "../config.mjs";

export const name = "futures-transactions-columns";

/** @param {{ baseUrl: string; page: import('puppeteer').Page }} ctx */
export async function run(ctx) {
  // Use a modest range to keep runtime reasonable.
  const params = new URLSearchParams();
  params.set("sd", "2015-01-02");
  params.set("ed", "2016-12-30");
  params.set("smaPsp", "200");
  params.set("smaPnq", "200");
  params.set("smatspU", "0");
  params.set("smatspL", "0");
  params.set("smatnqU", "0");
  params.set("smatnqL", "0");
  params.set("ro", "SGOV");
  params.set("amt", "30000");
  params.set("autorun", "1");

  const url = buildToolUrl(ctx.baseUrl, "futures", params);
  await gotoUi(ctx.page, url);

  // Wait for the autorun simulation to render the Transactions section.
  await ctx.page.waitForFunction(
    function () {
      const text = document.querySelector("main")?.textContent ?? "";
      return text.includes("Transactions");
    },
    { timeout: Number(process.env.UI_TEST_TIMEOUT_MS ?? 90000) }
  );
}
