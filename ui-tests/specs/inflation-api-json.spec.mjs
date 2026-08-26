import { fetchWithVercelBypass } from "../config.mjs";

export const name = "inflation-api-json";

export const tags = ["smoke"];

/** @param {{ baseUrl: string; page: import('puppeteer').Page }} ctx */
export async function run(ctx) {
  const base = ctx.baseUrl.replace(/\/$/, "");
  const r = await fetchWithVercelBypass(
    `${base}/api/inflation?startDate=2000-01-01&endDate=2020-01-01`,
  );
  if (!r.ok) {
    throw new Error(`Inflation API failed: ${r.status}`);
  }
  const j = await r.json();
  if (typeof j.annualizedInflation !== "number") {
    throw new Error("Expected annualizedInflation number in inflation JSON.");
  }
  if (!Array.isArray(j.monthlyCpi)) {
    throw new Error("Expected monthlyCpi array in inflation JSON.");
  }
}
