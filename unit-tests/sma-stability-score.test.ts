import test from "node:test";
import assert from "node:assert/strict";
import { rankStableSmaCandidates, stabilityAdjustedSmaScore } from "../src/lib/simulation/sma-stability-score";
import { comboKey, type SmaCombo } from "../src/lib/simulation/sma-search";

test("stability score caps a spike without inflating a stable band", () => {
  assert.equal(stabilityAdjustedSmaScore(14904, 5826), 5826);
  assert.equal(stabilityAdjustedSmaScore(14790, 14790), 14790);
  assert.equal(stabilityAdjustedSmaScore(100, 200), 100);
  assert.equal(stabilityAdjustedSmaScore(-100, -200), -200);
});

const center = { combo: { smaPeriod: 125, smaUpperBuffer: 19.5, smaLowerBuffer: 17.9 }, score: 14790 };
const spike = { combo: { smaPeriod: 127, smaUpperBuffer: 19.3, smaLowerBuffer: 17.8 }, score: 14904 };
const evaluate = (combos: SmaCombo[]) => combos.map((combo) => ({
  combo,
  score: comboKey(combo) === comboKey(spike.combo) ? 14904
    : combo.smaPeriod >= 127 && combo.smaUpperBuffer < 19.4 ? 5826 : 14790,
})).reverse();

test("complete neighborhoods put the plateau center above a higher raw-score spike", () => {
  const { ranked } = rankStableSmaCandidates([spike, center, center], center, evaluate);
  assert.deepEqual(ranked[0].entry.combo, center.combo);
  assert.equal(ranked[0].score, 14790);
  assert.equal(ranked[0].neighborCount, 26, "duplicates cannot weight the diagnostics");
  const penalized = ranked.find((rank) => comboKey(rank.entry.combo) === comboKey(spike.combo))!;
  assert.equal(penalized.score, 5826);
  assert.equal(penalized.stabilityPenalty, 14904 - 5826);
});

test("missing or nonfinite engine neighbors fail instead of hiding a cliff", () => {
  assert.throws(() => rankStableSmaCandidates([center], center, () => []), /every neighboring result/);
  assert.throws(() => rankStableSmaCandidates([center], center,
    (combos) => combos.map((combo) => ({ combo, score: NaN }))), /finite neighboring scores/);
});
