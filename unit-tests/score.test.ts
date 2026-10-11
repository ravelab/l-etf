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

test("scoreRow prefers 0.5 over 0.75 and 1 trades/year", () => {
  const scores = [0.5, 0.75, 1].map((avgTrades) => scoreRow(mockRow({ avgTrades }), 0));
  assert.ok(scores[0] > scores[1]);
  assert.ok(scores[1] > scores[2]);
  assert.ok(Math.abs(scores[0] - scores[2] - 100) < 1e-9);
});

test("scoreRow penalizes both sparse and frequent switching progressively", () => {
  const score = (avgTrades: number) => scoreRow(mockRow({ avgTrades }), 0);
  assert.ok(score(0.5) > score(0.25));
  assert.ok(score(0.25) > score(0.1));
  assert.ok(score(0.1) > score(0));
  assert.ok(Number.isFinite(score(0)));
  assert.ok(score(1) > score(1.5));
  assert.ok(score(1.5) > score(2));
  assert.ok(score(2) > score(5));
  assert.ok(Math.abs(score(0.5) - score(0.25) - (2000 + 14000 * (1 - 0.25 / 0.35) ** 2)) < 1e-9);
  assert.ok(Math.abs(score(1) - score(2) - 3927) < 1e-9);
});

test("scoreRow annualizes trade frequency across different window lengths", () => {
  for (const frequency of [0, 0.1, 0.25, 0.5, 0.75, 1, 2, 5]) {
    const yearly = scoreRow(mockRow({ avgTrades: frequency }), 0, 1);
    const decade = scoreRow(mockRow({ avgTrades: frequency * 10 }), 0, 10);
    assert.ok(Math.abs(yearly - decade) < 1e-9);
  }
});

test("low-evidence surcharge leaves scores at 0.35 switches/year and above unchanged", () => {
  // Pin the pre-change score across the sparse boundary, optimum and churn.
  const expected = [
    [0.35, 1834.2138461538034],
    [0.5, 2554.2138461538034],
    [0.75, 2529.2138461538034],
    [1, 2454.2138461538034],
    [2, -1472.7861538461966],
  ];
  for (const [avgTrades, previousScore] of expected) {
    assert.ok(Math.abs(scoreRow(mockRow({ avgTrades }), 0) - previousScore) < 1e-9);
  }
});

test("eight switches in 41 years receive an additional low-evidence penalty", () => {
  const base = scoreRow(mockRow({ avgTrades: 0.5 }), 0);
  const score = scoreRow(mockRow({ avgTrades: 8 }), 0, 41);
  // Very sparse rules pay both the original frequency penalty and evidence surcharge.
  assert.ok(base - score > 5700);
  assert.ok(base - score < 5800);
});

test("NDX 125-day rule no longer beats the better-evidenced 200-day rule", () => {
  // Real 10-year rolling metrics through 2026-10-02, weighted proto/start 5/95.
  // Columns: real CAGR, worst real CAGR, average/worst drawdown, switches/window.
  const scoreEra = ([avgReturn, worstReturn, avgMaxDrawdown, biggestMaxDrawdown, avgTrades]: number[]) =>
    scoreRow(mockRow({ avgReturn, worstReturn, avgMaxDrawdown, biggestMaxDrawdown, avgTrades }), 0, 10);
  const sparse = 0.05 * scoreEra([5.469680291925574, -12.561201873710349, 71.29503612935875, 74.11114772880227, 1.437125748502994])
    + 0.95 * scoreEra([31.07348663109914, -4.790593062665449, 66.13827360904261, 80.7797666964451, 1.4422310756972112]);
  const supported = 0.05 * scoreEra([20.762875369133006, 2.662383796170941, 59.306680175769024, 60.046881949038955, 5.712574850299402])
    + 0.95 * scoreEra([27.88173240915138, -4.55462497966127, 72.00455813612002, 81.295617305736, 3.8406374501992033]);
  assert.ok(sparse < supported, "six historical switches carry less evidence");
  assert.ok(Math.abs(supported - 13146.278967401253) < 1e-9, "200-day score remains unchanged");
});

test("NDX 183-day rule narrowly beats both the 125-day and 148-day rules", () => {
  // Real 10-year rolling metrics through 2026-10-09; proto/start weights 5/95.
  const era = ([avgReturn, worstReturn, avgMaxDrawdown, biggestMaxDrawdown, avgTrades]: number[]) =>
    scoreRow(mockRow({ avgReturn, worstReturn, avgMaxDrawdown, biggestMaxDrawdown, avgTrades }), 0, 10);
  const fewer = 0.05 * era([18.403552670264098, 0.20914114844821086, 71.29503612935913, 74.1111477288023, 1.4311377245508983])
    + 0.95 * era([29.255567203000854, -10.36818237988486, 75.68373868152547, 84.51623794513209, 2.404382470119522]);
  const more = 0.05 * era([18.858375124502555, 2.9339227467124473, 60.29190128945049, 61.36245106621032, 5.712574850299402])
    + 0.95 * era([27.23503941145315, -3.894558154499217, 70.21901151477108, 85.61964552067106, 3.8406374501992033]);
  const previousDefault = 0.05 * era([5.469680291925574, -12.561201873710349, 71.29503612935875, 74.11114772880227, 1.437125748502994])
    + 0.95 * era([31.040811494927215, -4.790593062665449, 66.13827360904261, 80.7797666964451, 1.4402390438247012]);
  for (const competitor of [more, previousDefault]) {
    assert.ok(fewer > competitor);
    assert.ok((fewer - competitor) / competitor < 0.02, "183-day rule retains only a narrow lead");
  }
});

test("scoreRow's trading penalty is continuous at the preferred rate and the excessive-trading threshold", () => {
  const score = (avgTrades: number) => scoreRow(mockRow({ avgTrades }), 0);
  for (const boundary of [0.175, 0.35, 0.5, 1]) {
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
