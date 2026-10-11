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

test("scoreRow prefers 0.3 switches/year when the other metrics match", () => {
  const score = (avgTrades: number) => scoreRow(mockRow({ avgTrades }), 0);
  for (const frequency of [0, 0.1, 0.25, 0.5, 0.75, 1, 2]) assert.ok(score(0.3) > score(frequency));
  assert.ok(Math.abs(score(0.3) - score(1) - 98) < 1e-9);
});

test("scoreRow penalizes sparse evidence and excessive switching progressively", () => {
  const score = (avgTrades: number) => scoreRow(mockRow({ avgTrades }), 0);
  assert.ok(score(0.3) > score(0.25));
  assert.ok(score(0.25) > score(0.1));
  assert.ok(score(0.1) > score(0));
  assert.ok(Number.isFinite(score(0)));
  assert.ok(score(0.3) > score(0.5));
  assert.ok(score(0.5) > score(1));
  assert.ok(score(1) > score(1.5));
  assert.ok(score(1.5) > score(2));
  assert.ok(score(2) > score(5));
  assert.ok(Math.abs(score(0.3) - score(0.15) - 4875) < 1e-9);
  assert.ok(Math.abs(score(1) - score(2) - 3607) < 1e-9);
});

test("scoreRow annualizes trade frequency across different window lengths", () => {
  for (const frequency of [0, 0.1, 0.25, 0.5, 0.75, 1, 2, 5]) {
    const yearly = scoreRow(mockRow({ avgTrades: frequency }), 0, 1);
    const decade = scoreRow(mockRow({ avgTrades: frequency * 10 }), 0, 10);
    assert.ok(Math.abs(yearly - decade) < 1e-9);
  }
});

test("higher real CAGR can outweigh fewer switches", () => {
  const supported = mockRow({ avgReturn: 15, avgTrades: 0.3 });
  const higherReturn = mockRow({ avgReturn: 25, avgTrades: 0.15 });
  assert.ok(scoreRow(higherReturn, 0) > scoreRow(supported, 0));
  assert.ok(scoreRow({ ...higherReturn, avgReturn: 15 }, 0) < scoreRow(supported, 0));
});

test("eight switches in 41 years still pay a substantial evidence penalty", () => {
  const base = scoreRow(mockRow({ avgTrades: 0.3 }), 0);
  const sparse = scoreRow(mockRow({ avgTrades: 8 }), 0, 41);
  assert.ok(base - sparse > 2300);
  assert.ok(base - sparse < 2400);
});

test("scoreRow's trading penalty is continuous at its preferred rate and churn threshold", () => {
  const score = (avgTrades: number) => scoreRow(mockRow({ avgTrades }), 0);
  for (const boundary of [0.3, 1]) {
    assert.ok(Math.abs(score(boundary) - score(boundary - 1e-9)) < 1e-4);
    assert.ok(Math.abs(score(boundary) - score(boundary + 1e-9)) < 1e-4);
  }
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
