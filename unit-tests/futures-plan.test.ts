import test from "node:test";
import assert from "node:assert/strict";
import {
  buildEmulationEtfConfigs,
  buildFuturesLadderPlan,
  type SmaBandsByIndex,
} from "@/lib/simulation/futures-plan";

// Deliberately asymmetric, and deliberately the shape that broke: the exit
// buffer differs from the re-entry buffer, so a builder that reuses one value
// for both sides produces a materially different strategy.
const BANDS: SmaBandsByIndex = {
  sp500: { period: 186, upperBuffer: 3, lowerBuffer: 3.3 },
  nasdaq100: { period: 150, upperBuffer: 20.4, lowerBuffer: 17.6 },
};

test("futures plan: every emulation rung matches its LETF twin's SMA rule", () => {
  // The whole point of the emulation view is that the two engines run the *same*
  // strategy and differ only in cost model. Any drift here is a silent lie.
  const plan = buildFuturesLadderPlan({
    showEmulations: true,
    hasNasdaqData: true,
    yearSpan: 20,
    bands: BANDS,
  });
  const configs = buildEmulationEtfConfigs({
    hasNasdaqData: true,
    bands: BANDS,
    riskOffAsset: "SGOV",
  });

  assert.equal(plan.length, configs.length, "each ladder rung needs exactly one LETF twin");
  assert.equal(plan.length, 4);

  for (const step of plan) {
    const twin = configs.find((c) => c.smaIndex === step.index && c.leverage === step.leverage);
    assert.ok(twin, `no LETF twin for ${step.leverage}x ${step.index}`);
    assert.equal(twin.smaPeriod, step.sma.period, `${twin.name}: SMA period drifted`);
    assert.equal(twin.smaUpperBuffer, step.sma.upperBuffer, `${twin.name}: re-entry buffer drifted`);
    assert.equal(twin.smaLowerBuffer, step.sma.lowerBuffer, `${twin.name}: exit buffer drifted`);
  }
});

test("futures plan: bands are carried asymmetrically, never collapsed to one side", () => {
  // The original bug assigned the upper buffer to both sides, which left the
  // band's width unchanged in the tests that only checked the upper edge.
  for (const showEmulations of [true, false]) {
    const plan = buildFuturesLadderPlan({
      showEmulations,
      hasNasdaqData: true,
      yearSpan: 20,
      bands: BANDS,
    });
    assert.equal(plan.length > 0, true);
    for (const step of plan) {
      const expected = BANDS[step.index as keyof SmaBandsByIndex];
      assert.equal(step.sma.upperBuffer, expected.upperBuffer, `${step.leverage}x ${step.index} upper`);
      assert.equal(step.sma.lowerBuffer, expected.lowerBuffer, `${step.leverage}x ${step.index} lower`);
      assert.notEqual(
        step.sma.lowerBuffer,
        step.sma.upperBuffer,
        `${step.leverage}x ${step.index}: band collapsed to a single buffer`
      );
    }
  }
});

test("futures plan: Nasdaq rungs and twins both drop when NDX data is missing", () => {
  const plan = buildFuturesLadderPlan({
    showEmulations: true,
    hasNasdaqData: false,
    yearSpan: 20,
    bands: BANDS,
  });
  const configs = buildEmulationEtfConfigs({
    hasNasdaqData: false,
    bands: BANDS,
    riskOffAsset: "SGOV",
  });
  assert.equal(plan.every((s) => s.index === "sp500"), true);
  assert.equal(configs.every((c) => c.smaIndex === "sp500"), true);
  assert.equal(plan.length, configs.length, "the two sides must drop the same rungs");
});

test("futures plan: long windows trim the mid ladder rungs", () => {
  const short = buildFuturesLadderPlan({ showEmulations: false, hasNasdaqData: true, yearSpan: 20, bands: BANDS });
  const long = buildFuturesLadderPlan({ showEmulations: false, hasNasdaqData: true, yearSpan: 140, bands: BANDS });
  assert.equal(long.length < short.length, true, "a 140-year window should run fewer sims");
  assert.equal(long.some((s) => s.maxLeverage === 4.5), true, "the capped rung always runs");
});
