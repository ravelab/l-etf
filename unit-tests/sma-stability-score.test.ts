import test from "node:test";
import assert from "node:assert/strict";
import { rankStableSmaCandidates, stabilityAdjustedSmaScore } from "../src/lib/simulation/sma-stability-score";
import { comboKey, type SmaCombo } from "../src/lib/simulation/sma-search";

test("stability tolerates small neighborhood losses and penalizes large cliffs without inflating scores", () => {
  assert.equal(stabilityAdjustedSmaScore(14904, 5826), 10737.6);
  assert.equal(stabilityAdjustedSmaScore(14790, 14790), 14790);
  assert.equal(stabilityAdjustedSmaScore(100, 200), 100);
  assert.equal(stabilityAdjustedSmaScore(100, 95), 100);
  assert.equal(stabilityAdjustedSmaScore(100, 94), 99.5);
  assert.equal(stabilityAdjustedSmaScore(0, -100), -50);
  assert.equal(stabilityAdjustedSmaScore(-100, -200), -150);
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
  assert.equal(penalized.score, 10737.6);
  assert.equal(penalized.stabilityPenalty, (14904 - 5826 - 14904 * 0.05) / 2);
});

test("missing or nonfinite engine neighbors fail instead of hiding a cliff", () => {
  assert.throws(() => rankStableSmaCandidates([center], center, () => []), /every neighboring result/);
  assert.throws(() => rankStableSmaCandidates([center], center,
    (combos) => combos.map((combo) => ({ combo, score: NaN }))), /finite neighboring scores/);
});

test("the selected default wins exact score ties but cannot override stronger candidates", () => {
  const selected = { combo: { smaPeriod: 182, smaUpperBuffer: 6.9, smaLowerBuffer: 18.1 }, score: 100 };
  const plateauCenter = { combo: { smaPeriod: 180, smaUpperBuffer: 7.4, smaLowerBuffer: 18 }, score: 100 };
  const same = (combos: SmaCombo[]) => combos.map((combo) => ({ combo, score: 100 }));
  const tied = rankStableSmaCandidates([selected, plateauCenter], plateauCenter, same, selected.combo);
  assert.deepEqual(tied.ranked[0].entry.combo, selected.combo);
  const stronger = { combo: { smaPeriod: 200, smaUpperBuffer: 5, smaLowerBuffer: 12 }, score: 120 };
  const ranked = rankStableSmaCandidates([selected, plateauCenter, stronger], plateauCenter,
    (combos) => combos.map((combo) => ({ combo, score: combo.smaPeriod >= 199 ? 120 : 100 })), selected.combo);
  assert.deepEqual(ranked.ranked[0].entry.combo, stronger.combo);
});

// Same neighborhood strength, different base performance: the stronger base
// must contribute to rank rather than disappear behind a hard minimum.
test("higher base performance wins when neighboring performance is comparable", () => {
  const band199 = stabilityAdjustedSmaScore(12804.101357086627, 12804.101357086589);
  const band200 = stabilityAdjustedSmaScore(13146.278967401253, 12801.715006717783);
  assert.ok(band200 > band199);
  assert.ok(Math.abs(band200 - 13146.278967401253) < 1e-8);
  assert.ok(stabilityAdjustedSmaScore(14904, 5826) < stabilityAdjustedSmaScore(14790, 14790),
    "a small base advantage cannot outweigh a severe neighboring cliff");
});
