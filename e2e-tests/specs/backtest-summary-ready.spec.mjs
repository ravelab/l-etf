import { readSnapshot, buildToolUrl } from "../snapshot-params.mjs";
import { gotoUi, fetchWithVercelBypass } from "../config.mjs";

export const name = "backtest-summary-ready";

/**
 * Backtest summaries are backed by the snapshot API. Validate the API payload
 * directly, then verify the client tab renders enough controls to use it.
 * @param {{ baseUrl: string; page: import('puppeteer').Page }} ctx
 */
export async function run(ctx) {
  const snapshot = readSnapshot("backtesting");
  const apiUrl = `${ctx.baseUrl.replace(/\/$/, "")}/api/tool-snapshots?pageKey=backtesting`;
  console.log(`[FETCH] ${apiUrl}`);
  const payload = await fetchWithVercelBypass(apiUrl).then((res) => {
    if (!res.ok) throw new Error(`Snapshot API returned ${res.status} ${res.statusText}`);
    return res.json();
  });
  const result = payload?.pageState?.result;
  if (!result || !Array.isArray(result.etfResults) || result.etfResults.length === 0) {
    throw new Error("Expected backtesting snapshot API to include result.etfResults.");
  }

  const url = buildToolUrl(ctx.baseUrl, "backtest", new URLSearchParams());

  await gotoUi(ctx.page, url);
  await ctx.page.waitForFunction(
    function () {
      const text = document.querySelector("main")?.textContent ?? "";
      return text.includes("Run Backtest") && text.includes("LETF");
    },
    { timeout: Number(process.env.E2E_TEST_TIMEOUT_MS ?? 90000) }
  );

  const preset = snapshot.pageState.preset;
  const apiPreset = payload?.pageState?.preset;
  if (apiPreset !== preset) {
    throw new Error(`Expected backtesting snapshot preset ${preset}, got ${apiPreset}`);
  }
}
