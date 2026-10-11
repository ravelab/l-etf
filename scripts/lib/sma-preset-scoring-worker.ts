import { buildSmaEraContexts, evaluateCombosAcrossEras, type SmaEraContexts } from "./sma-sweep-context";
import { getDefaultWindowLength } from "../../src/lib/simulation/defaults";
import { SMA_SEARCH_MAX_PERIOD } from "../../src/lib/simulation/sma-search-bounds";
import type { SmaCombo } from "../../src/lib/simulation/sma-search";
import type { IndexKey } from "../../src/lib/simulation/types";

const contexts = new Map<string, SmaEraContexts>();
process.on("message", async ({ indexKey, endDate, combos }: { indexKey: IndexKey; endDate: string; combos: SmaCombo[] }) => {
  try {
    const key = `${indexKey}|${endDate}`;
    let context = contexts.get(key);
    if (!context) {
      context = await buildSmaEraContexts({ indexKey, endDate, windowLength: getDefaultWindowLength(), maxPeriod: SMA_SEARCH_MAX_PERIOD });
      contexts.set(key, context);
    }
    process.send?.({ rows: evaluateCombosAcrossEras(context, combos) });
  } catch (error) { process.send?.({ error: String(error) }); }
});
