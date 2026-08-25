import test from "node:test";
import assert from "node:assert/strict";
import { joinSweepRowsToConfigs } from "../src/lib/mcp/sweep-core";
import type { EtfConfig, SmaComparisonRow } from "../src/lib/simulation/types";

function makeConfig(id: string, name: string): EtfConfig {
  return {
    id,
    name,
    leverage: 3,
    expenseRatio: 0.91,
    simulated: true,
    smaEnabled: false,
    smaPeriod: 200,
    smaUpperBuffer: 0,
    smaLowerBuffer: 0,
    smaIndex: "sp500",
    riskOffAsset: "SGOV",
  };
}

function makeRow(parameterValue: number, avgReturn: number): SmaComparisonRow {
  return {
    parameterValue,
    avgFinalRealValue: 0,
    avgReturn,
    bestReturn: 0,
    worstReturn: 0,
    avgMaxDrawdown: 0,
    biggestMaxDrawdown: 0,
    avgTrades: 0,
    avgTradingCostPct: 0,
  } as SmaComparisonRow;
}

test("sweep rows are joined to configs by parameterValue, not array position", () => {
  const configs = [
    makeConfig("a", "A"),
    makeConfig("b", "B"),
    makeConfig("c", "C"),
    makeConfig("d", "D"),
  ];
  // Config "b" (index 1) was wiped out, so mode "sweep" dropped its bucket.
  // The surviving rows still carry their owning config's index.
  const rows = [makeRow(0, 10), makeRow(2, 30), makeRow(3, 40)];

  const joined = joinSweepRowsToConfigs(configs, rows);

  assert.deepEqual(
    joined.map((r) => [r.id, r.stats.avgReturn]),
    [["a", 10], ["c", 30], ["d", 40]],
    "each surviving config must keep its own statistics"
  );
});

test("sweep join tolerates rows arriving out of config order", () => {
  const configs = [makeConfig("a", "A"), makeConfig("b", "B")];
  const rows = [makeRow(1, 20), makeRow(0, 10)];

  const joined = joinSweepRowsToConfigs(configs, rows);

  assert.deepEqual(
    joined.map((r) => [r.id, r.stats.avgReturn]),
    [["a", 10], ["b", 20]]
  );
});
