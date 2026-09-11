import type { FuturesStrategyParams, FuturesStrategyResult } from "@/lib/simulation/futures";
import { simulateFuturesSmaStrategy } from "@/lib/simulation/futures";
import type { DualSleeveFuturesParams } from "@/lib/simulation/futures-dual-sleeve";
import { simulateDualSleeveFuturesStrategy } from "@/lib/simulation/futures-dual-sleeve";

/**
 * One entry in the futures ladder: a lone strategy, or a fund holding two sleeves.
 * Tagged rather than inferred so the worker boundary stays a plain structural check.
 */
export type FuturesRunPlan =
  | { kind: "single"; single: FuturesStrategyParams }
  | { kind: "dual"; dual: DualSleeveFuturesParams };

export function runFuturesPlan(plan: FuturesRunPlan): FuturesStrategyResult {
  return plan.kind === "dual"
    ? simulateDualSleeveFuturesStrategy(plan.dual)
    : simulateFuturesSmaStrategy(plan.single);
}
