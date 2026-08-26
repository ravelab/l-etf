import { fetchWithVercelBypass } from "../config.mjs";

export const name = "boxtrades-spx-apy-api-json";

/** @param {{ baseUrl: string }} ctx */
export async function run(ctx) {
  const base = ctx.baseUrl.replace(/\/$/, "");
  const r = await fetchWithVercelBypass(`${base}/api/boxtrades/spx-apy?minDays=365`);
  if (!r.ok) {
    throw new Error(`Boxtrades SPX APY API failed: ${r.status}`);
  }
  const j = await r.json();
  if (j.symbol !== "SPX") {
    throw new Error("Expected SPX symbol.");
  }
  if (!Array.isArray(j.contracts) || j.contracts.length === 0) {
    throw new Error("Expected non-empty contracts array.");
  }
  if (!j.sizeModel || typeof j.sizeModel !== "object") {
    throw new Error("Expected sizeModel object.");
  }
  if (
    j.sizeModel.yieldPenaltyBpsPer10xSmallerNotional !== null &&
    typeof j.sizeModel.yieldPenaltyBpsPer10xSmallerNotional !== "number"
  ) {
    throw new Error("Expected size model coefficient number or null.");
  }
  for (const contract of j.contracts) {
    if (typeof contract.expFormat !== "string") {
      throw new Error("Expected expFormat string.");
    }
    if (!(contract.daysToExpiry > 365)) {
      throw new Error("Expected daysToExpiry > 365.");
    }
    if (
      contract.boxtradesYieldPercent !== null &&
      typeof contract.boxtradesYieldPercent !== "number"
    ) {
      throw new Error("Expected boxtradesYieldPercent number or null.");
    }
    if (typeof contract.apyPercent !== "number") {
      throw new Error("Expected apyPercent number.");
    }
    if (
      contract.sizeAdjustedApyPercent?.["200000"] !== null &&
      typeof contract.sizeAdjustedApyPercent?.["200000"] !== "number"
    ) {
      throw new Error("Expected 200K size-adjusted APY number or null.");
    }
    if (
      contract.sizeAdjustedApyPercent?.["50000"] !== null &&
      typeof contract.sizeAdjustedApyPercent?.["50000"] !== "number"
    ) {
      throw new Error("Expected 50K size-adjusted APY number or null.");
    }
    if (
      contract.fidelityAndSpreadAdjustedApyPercent?.["50000"] !== null &&
      typeof contract.fidelityAndSpreadAdjustedApyPercent?.["50000"] !== "number"
    ) {
      throw new Error("Expected 50K Fidelity/spread APY number or null.");
    }
  }
}
