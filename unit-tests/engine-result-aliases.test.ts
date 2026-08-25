import test from "node:test";
import assert from "node:assert/strict";
import { simulateBacktest } from "../src/lib/simulation/engine";
import { findEtfResult } from "../src/lib/simulation/result-lookup";
import type { EtfConfig, PricePoint, RatePoint } from "../src/lib/simulation/types";

const rates: RatePoint[] = [{ date: "1900-01-01", rateValue: 0.05, rateType: "borrow" }];

function prices(n: number): PricePoint[] {
  const out: PricePoint[] = [];
  let v = 100;
  for (let i = 0; i < n; i++) {
    v *= 1 + (i % 9 === 0 ? -0.01 : 0.004);
    out.push({
      date: new Date(Date.UTC(2000, 0, 3) + i * 86400000).toISOString().slice(0, 10),
      adj_close: v,
      close: v,
    });
  }
  return out;
}

function smaConfig(id: string, smaPeriod: number): EtfConfig {
  return {
    id, name: "UPRO", leverage: 3, expenseRatio: 0.91, simulated: true,
    smaEnabled: true, smaPeriod, smaUpperBuffer: 0, smaLowerBuffer: 0,
    smaIndex: "sp500", riskOffAsset: "SGOV",
  };
}

test("every requested -base id resolves, even when the computation was shared", () => {
  // Two SMA configs on the same LETF expand to two IDENTICAL no-SMA baselines.
  // Only one is simulated; the other id used to be absent entirely, so the
  // mandated find-by-id selection returned undefined.
  const result = simulateBacktest(prices(400), rates, [
    smaConfig("a", 50),
    smaConfig("b", 100),
  ]);

  for (const id of ["a-base", "b-base", "a-sma", "b-sma"]) {
    assert.notEqual(findEtfResult(result, id), undefined, `${id} should resolve`);
  }

  // Both -base ids must land on the same computed series.
  assert.equal(
    findEtfResult(result, "a-base")!.dailyValues.at(-1),
    findEtfResult(result, "b-base")!.dailyValues.at(-1)
  );
});

test("shared computations are still emitted once, so charts draw no duplicates", () => {
  const result = simulateBacktest(prices(400), rates, [
    smaConfig("a", 50),
    smaConfig("b", 100),
  ]);

  const baseResults = result.etfResults.filter((r) => r.id.endsWith("-base"));
  assert.equal(
    baseResults.length,
    1,
    "the identical baseline must be emitted once; a second entry would render a duplicate line"
  );
  assert.equal(result.etfResultIdAliases?.["b-base"], "a-base");
});

test("distinct configs are not aliased together", () => {
  const result = simulateBacktest(prices(400), rates, [
    smaConfig("a", 50),
    smaConfig("b", 100),
  ]);
  // The SMA legs differ (different periods), so both must be real entries.
  assert.equal(result.etfResults.filter((r) => r.id.endsWith("-sma")).length, 2);
  assert.equal(result.etfResultIdAliases?.["b-sma"], undefined);
});
