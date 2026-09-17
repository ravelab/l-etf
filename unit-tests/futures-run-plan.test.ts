import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFuturesLadderPlan,
  showsFuturesTransactions,
  type SmaBand,
  type SmaBandsByIndex,
} from "@/lib/simulation/futures-plan";
import { buildFuturesRunPlans } from "@/lib/simulation/futures-run-plan";
import type { IndexKey, PricePoint, RatePoint } from "@/lib/simulation/types";

const BANDS: SmaBandsByIndex = {
  sp500: { period: 186, upperBuffer: 3, lowerBuffer: 3.3 },
  nasdaq100: { period: 150, upperBuffer: 20.4, lowerBuffer: 17.6 },
};

/** Minimal sleeve params; the builder only routes them, it never reads them. */
function sleeveParams(
  index: IndexKey,
  leverage: number,
  maxLeverage: number | undefined,
  sma: SmaBand
) {
  return {
    index,
    prices: [] as PricePoint[],
    rates: [] as RatePoint[],
    startDate: "1990-01-01",
    endDate: "2020-01-01",
    targetLeverage: leverage,
    maxLeverage,
    smaPeriod: sma.period,
    smaUpperBuffer: sma.upperBuffer,
    smaLowerBuffer: sma.lowerBuffer,
    riskOffAsset: "SGOV" as const,
  };
}

test("futures run plans: a step with a second sleeve runs as a fund, not as its primary", () => {
  // Snapshot generation used to map steps itself and ignore `secondary`, so the
  // canned futures page reported a second copy of the plain 4.5x SPX rung under
  // the fund's name. Every caller now shares this mapping.
  const steps = buildFuturesLadderPlan({
    showEmulations: false,
    hasNasdaqData: true,
    yearSpan: 20,
    bands: BANDS,
  });
  const dualSteps = steps.filter((step) => step.secondary);
  assert.equal(dualSteps.length, 1, "the ladder should carry exactly one two-sleeve fund");

  const plans = buildFuturesRunPlans({ steps, initialEquity: 100_000, sleeveParams });
  assert.equal(plans.length, steps.length);

  const dual = plans.filter((plan) => plan.kind === "dual");
  assert.equal(dual.length, 1);
  assert.equal(dual[0].kind === "dual" && dual[0].dual.displayName, "Max 4.5x SPX / Max 3x NDX SMA");
  assert.equal(dual[0].kind === "dual" && dual[0].dual.initialEquity, 100_000);
  assert.equal(dual[0].kind === "dual" && dual[0].dual.primary.index, "sp500");
  assert.equal(dual[0].kind === "dual" && dual[0].dual.primary.targetLeverage, 4.5);
  assert.equal(dual[0].kind === "dual" && dual[0].dual.secondary.index, "nasdaq100");
  assert.equal(dual[0].kind === "dual" && dual[0].dual.secondary.targetLeverage, 3);
  // Each sleeve keeps its own index's band; sharing one would re-open the bug
  // futures-plan.ts exists to prevent.
  assert.equal(dual[0].kind === "dual" && dual[0].dual.secondary.smaPeriod, BANDS.nasdaq100.period);
});

test("futures run plans: single rungs keep their label and full equity", () => {
  const steps = buildFuturesLadderPlan({
    showEmulations: false,
    hasNasdaqData: true,
    yearSpan: 20,
    bands: BANDS,
  });
  const plans = buildFuturesRunPlans({ steps, initialEquity: 100_000, sleeveParams });

  for (const [i, plan] of plans.entries()) {
    if (steps[i].secondary) continue;
    assert.equal(plan.kind, "single");
    assert.equal(plan.kind === "single" && plan.single.initialEquity, 100_000);
    assert.equal(plan.kind === "single" && plan.single.targetLeverage, steps[i].leverage);
    assert.equal(plan.kind === "single" && plan.single.displayName, steps[i].displayName);
  }
});

test("futures transactions filter: the snapshot keeps exactly what the page lists", () => {
  // The snapshot drops transactions[] for everything this returns false for, so
  // a row the page lists but the snapshot dropped renders "No transactions".
  const steps = buildFuturesLadderPlan({
    showEmulations: false,
    hasNasdaqData: true,
    yearSpan: 20,
    bands: BANDS,
  });
  const listed = steps.filter((step) =>
    showsFuturesTransactions({ index: step.index, targetLeverage: step.leverage }, false)
  );
  assert.deepEqual(
    listed.map((step) => step.displayName ?? `${step.leverage}x ${step.index}`),
    ["Max 4.5x SPX SMA", "Max 4.5x SPX / Max 3x NDX SMA", "3x nasdaq100"],
    "the two-sleeve fund is SPX at 4.5x, so it is listed alongside the plain rung"
  );

  // Emulation view swaps the SPX rung for the 3x one it can compare to UPRO.
  assert.equal(showsFuturesTransactions({ index: "sp500", targetLeverage: 3 }, true), true);
  assert.equal(showsFuturesTransactions({ index: "sp500", targetLeverage: 4.5 }, true), false);
  assert.equal(showsFuturesTransactions({ index: "sp500", targetLeverage: 5 }, false), false);
});
