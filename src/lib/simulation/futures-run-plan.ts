import type { FuturesStrategyParams, FuturesStrategyResult } from "@/lib/simulation/futures";
import { simulateFuturesSmaStrategy } from "@/lib/simulation/futures";
import type { DualSleeveFuturesParams } from "@/lib/simulation/futures-dual-sleeve";
import { simulateDualSleeveFuturesStrategy } from "@/lib/simulation/futures-dual-sleeve";
import type { FuturesLadderStep, SmaBand } from "@/lib/simulation/futures-plan";
import type { IndexKey } from "@/lib/simulation/types";

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

/**
 * Everything a sleeve needs that does not depend on which rung asked for it.
 * The equity split and the row label belong to the rung, not the sleeve: a
 * two-sleeve fund names the fund once and hands each sleeve half the money.
 */
type FuturesSleeveParams = Omit<FuturesStrategyParams, "initialEquity" | "displayName">;

/**
 * Turn ladder steps into run plans, so "this step has a secondary sleeve" is
 * decided in exactly one place.
 *
 * It used to be decided in three: the futures page, the MCP ladder tool, and
 * snapshot generation — and the third never learned about `secondary`. It ran
 * the two-sleeve fund through the single-sleeve engine, so the canned futures
 * snapshot reported a second copy of the plain 4.5x SPX rung under the fund's
 * name while a live run of the same page reported the fund.
 *
 * Callers supply `sleeveParams` because only they know where the price, rate
 * and risk-off series came from.
 */
export function buildFuturesRunPlans(params: {
  steps: readonly FuturesLadderStep[];
  /** Whole-rung equity at inception; a two-sleeve fund halves it internally. */
  initialEquity: number;
  sleeveParams: (
    index: IndexKey,
    leverage: number,
    maxLeverage: number | undefined,
    sma: SmaBand
  ) => FuturesSleeveParams;
}): FuturesRunPlan[] {
  const { steps, initialEquity, sleeveParams } = params;
  return steps.map((step) =>
    step.secondary
      ? {
          kind: "dual" as const,
          dual: {
            displayName: step.displayName ?? "Dual sleeve SMA",
            initialEquity,
            primary: sleeveParams(step.index, step.leverage, step.maxLeverage, step.sma),
            secondary: sleeveParams(
              step.secondary.index,
              step.secondary.leverage,
              step.secondary.maxLeverage,
              step.secondary.sma
            ),
          },
        }
      : {
          kind: "single" as const,
          single: {
            ...sleeveParams(step.index, step.leverage, step.maxLeverage, step.sma),
            initialEquity,
            displayName: step.displayName,
          },
        }
  );
}
