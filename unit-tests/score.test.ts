import test from "node:test";
import assert from "node:assert/strict";
import { scoreRow } from "../src/lib/simulation/score";
import type { SmaComparisonRow } from "../src/lib/simulation/types";

const mockRow = (overrides: Partial<SmaComparisonRow> = {}): SmaComparisonRow => ({
  parameterValue: 10,
  avgFinalRealValue: 1100,
  avgReturn: 15,
  bestReturn: 20,
  worstReturn: 5,
  avgMaxDrawdown: 10,
  biggestMaxDrawdown: 15,
  avgTrades: 1,
  avgTradingCostPct: 0.1,
  ...overrides,
});

test("scoreRow rewards higher returns", () => {
  const row1 = mockRow({ avgReturn: 15 });
  const row2 = mockRow({ avgReturn: 20 });
  assert.equal(scoreRow(row2, 0) > scoreRow(row1, 0), true);
});

test("scoreRow penalizes drawdowns", () => {
  const row1 = mockRow({ avgMaxDrawdown: 10 });
  const row2 = mockRow({ avgMaxDrawdown: 20 });
  assert.equal(scoreRow(row1, 0) > scoreRow(row2, 0), true);
});

test("scoreRow penalizes excessive trades", () => {
  const row1 = mockRow({ avgTrades: 1 });
  const row2 = mockRow({ avgTrades: 10 });
  assert.equal(scoreRow(row1, 0) > scoreRow(row2, 0), true);
});

test("scoreRow applies capitulation penalty for >80% drawdown", () => {
  const row1 = mockRow({ biggestMaxDrawdown: 79 });
  const row2 = mockRow({ biggestMaxDrawdown: 81 });
  const row3 = mockRow({ biggestMaxDrawdown: 85 });
  
  const score1 = scoreRow(row1, 0);
  const score2 = scoreRow(row2, 0);
  const score3 = scoreRow(row3, 0);
  
  // Large jump in penalty between 79 and 81
  assert.equal(score1 - score2 > 2, true);
  // Even larger jump for 85
  assert.equal(score2 - score3 > 10, true);
});

test("scoreRow handles hateDrawdown option", () => {
  const row = mockRow({ avgMaxDrawdown: 30 });
  const scoreNormal = scoreRow(row, 0, 1, { hateDrawdown: false });
  const scoreHate = scoreRow(row, 0, 1, { hateDrawdown: true });
  assert.equal(scoreNormal > scoreHate, true);
});

test("scoreRow adjusts real CAGR based on inflationPct", () => {
  const row = mockRow({ avgReturn: 15 });
  // inflationPct = 0 treats avgReturn as already real
  const score1 = scoreRow(row, 0);
  // inflationPct = 5 treats avgReturn as nominal, real = 10
  const score2 = scoreRow(row, 5);
  assert.equal(score1 > score2, true);
});
