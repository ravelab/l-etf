import type { FuturesStrategyParams, FuturesStrategyResult } from "@/lib/simulation/futures";
import { simulateFuturesSmaStrategy } from "@/lib/simulation/futures";
import type { DualSleeveFuturesParams } from "@/lib/simulation/futures-dual-sleeve";
import { simulateDualSleeveFuturesStrategy } from "@/lib/simulation/futures-dual-sleeve";
import type { FuturesLadderStep, SmaBand } from "@/lib/simulation/futures-plan";
import type { IndexKey, RiskOffAsset } from "@/lib/simulation/types";
import { getRiskOffFetchTickers } from "@/lib/constants";

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
/**
 * A sleeve's own params with its step's risk-off override applied. Sleeves of one
 * fund that hold different baskets must each be able to hold the other's
 * tickers, because the fund's 50/50 reset hands basket shares between them.
 */
function withRiskOffAssets(
  primary: FuturesSleeveParams,
  secondary: FuturesSleeveParams,
  assets: { primary?: RiskOffAsset; secondary?: RiskOffAsset }
): { primary: FuturesSleeveParams; secondary: FuturesSleeveParams } {
  const a = { ...primary, riskOffAsset: assets.primary ?? primary.riskOffAsset };
  const b = { ...secondary, riskOffAsset: assets.secondary ?? secondary.riskOffAsset };
  if (a.riskOffAsset === b.riskOffAsset) return { primary: a, secondary: b };
  const held = [...new Set([...getRiskOffFetchTickers(a.riskOffAsset), ...getRiskOffFetchTickers(b.riskOffAsset)])];
  return { primary: { ...a, riskOffHeldTickers: held }, secondary: { ...b, riskOffHeldTickers: held } };
}

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
            ...withRiskOffAssets(
              sleeveParams(step.index, step.leverage, step.maxLeverage, step.sma),
              sleeveParams(
                step.secondary.index,
                step.secondary.leverage,
                step.secondary.maxLeverage,
                step.secondary.sma
              ),
              { primary: step.riskOffAsset, secondary: step.secondary.riskOffAsset }
            ),
          },
        }
      : {
          kind: "single" as const,
          single: {
            ...sleeveParams(step.index, step.leverage, step.maxLeverage, step.sma),
            ...(step.riskOffAsset ? { riskOffAsset: step.riskOffAsset } : {}),
            initialEquity,
            displayName: step.displayName,
          },
        }
  );
}
