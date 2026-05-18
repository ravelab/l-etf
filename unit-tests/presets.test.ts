import test from "node:test";
import assert from "node:assert/strict";
import {
  getValidPresetKey,
  isComboPreset,
  getComboSubPresets,
  resolvePresetContext,
  resolvePresetSelection,
  getActivePreset,
  getComboEffectiveDateRange,
  getConfigDefaultStartDate,
  createDefaultEtfConfig,
  applyPreset
} from "../src/lib/simulation/presets";

test("getValidPresetKey returns key if valid, else fallback", () => {
  assert.equal(getValidPresetKey("UPRO"), "UPRO");
  assert.equal(getValidPresetKey("UPRO+TQQQ"), "UPRO+TQQQ");
  assert.equal(getValidPresetKey("INVALID", "SSO"), "SSO");
});

test("isComboPreset detects combos", () => {
  assert.equal(isComboPreset("UPRO+TQQQ"), true);
  assert.equal(isComboPreset("UPRO"), false);
});

test("getComboSubPresets returns sub-presets", () => {
  const subs = getComboSubPresets("UPRO+TQQQ");
  assert.equal(subs.length, 2);
  assert.equal(subs[0].name, "UPRO");
  assert.equal(subs[1].name, "TQQQ");
});

test("resolvePresetContext builds context object", () => {
  const ctx = resolvePresetContext("UPRO+TQQQ");
  assert.equal(ctx.isCombo, true);
  assert.equal(ctx.selectedPreset.name, "UPRO"); // defaults to first in combo
  assert.equal(ctx.comboSubs?.length, 2);
  assert.deepEqual(ctx.comboLabels, ["UPRO", "TQQQ"]);
  
  const ctxSingle = resolvePresetContext("TQQQ");
  assert.equal(ctxSingle.isCombo, false);
  assert.equal(ctxSingle.selectedPreset.name, "TQQQ");
  assert.equal(ctxSingle.comboSubs, null);
});

test("resolvePresetSelection handles null/invalid", () => {
  assert.equal(resolvePresetSelection(null), null);
  const res = resolvePresetSelection("UPRO");
  assert.equal(res?.key, "UPRO");
  assert.equal(res?.isCombo, false);
});

test("getActivePreset handles sub-presets", () => {
  const ctx = resolvePresetContext("UPRO+TQQQ");
  const p1 = getActivePreset(ctx.selectedPreset, ctx.comboSubs!, 1);
  assert.equal(p1.name, "TQQQ");
  const p0 = getActivePreset(ctx.selectedPreset, ctx.comboSubs!, 0);
  assert.equal(p0.name, "UPRO");
});

test("getComboEffectiveDateRange returns common range", () => {
  const range = getComboEffectiveDateRange("UPRO+TQQQ");
  // UPRO is sp500 (1885), TQQQ is nasdaq100 (1971)
  // Min should be earliest (1885)
  assert.equal(range.min.startsWith("188"), true);
});

test("getConfigDefaultStartDate finds correct date", () => {
  const date = getConfigDefaultStartDate({ name: "TQQQ", simulated: true, smaIndex: "nasdaq100" });
  assert.equal(date, "1971-02-05");
});

test("createDefaultEtfConfig creates valid config", () => {
  const cfg = createDefaultEtfConfig("id1");
  assert.equal(cfg.id, "id1");
  assert.equal(cfg.name, "UPRO");
});

test("applyPreset updates config", () => {
  const cfg = createDefaultEtfConfig("id1");
  const updated = applyPreset(cfg, "TQQQ");
  assert.equal(updated.name, "TQQQ");
  assert.equal(updated.leverage, 3);
  assert.equal(updated.smaIndex, "nasdaq100");
});
