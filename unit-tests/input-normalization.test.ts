import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizePresetKey,
  normalizeIndexKey,
  normalizeRiskOffAsset,
  normalizeDateString,
  normalizeNumberValue,
  normalizeBooleanValue,
  normalizeSelectValue,
  normalizeObjectByDefaults,
} from "@/lib/input-normalization";

test("normalizePresetKey validates against presets", () => {
  assert.equal(normalizePresetKey("UPRO", "fallback"), "UPRO");
  assert.equal(normalizePresetKey("INVALID", "fallback"), "fallback");
});

test("normalizeIndexKey accepts valid keys and falls back for unknown", () => {
  assert.equal(normalizeIndexKey("sp500"), "sp500");
  assert.equal(normalizeIndexKey("nasdaq100"), "nasdaq100");
  assert.equal(normalizeIndexKey("other"), "sp500");
  assert.equal(normalizeIndexKey(42), "sp500");
  assert.equal(normalizeIndexKey(undefined), "sp500");
  assert.equal(normalizeIndexKey("nasdaq100", "nasdaq100"), "nasdaq100");
});

test("normalizeRiskOffAsset accepts valid values and falls back for unknown", () => {
  assert.equal(normalizeRiskOffAsset("SGOV"), "SGOV");
  assert.equal(normalizeRiskOffAsset("VGSH"), "VGSH");
  assert.equal(normalizeRiskOffAsset("GLDM"), "GLDM");
  assert.equal(normalizeRiskOffAsset("NOT_REAL"), "BRK.B+GLDM+VGSH");
  assert.equal(normalizeRiskOffAsset(null), "BRK.B+GLDM+VGSH");
});

test("normalizeDateString parses valid dates and rejects invalid ones", () => {
  assert.equal(normalizeDateString("2024-01-15", "fallback"), "2024-01-15");
  assert.equal(normalizeDateString("2020-12-31", "fallback"), "2020-12-31");
  // accepts slashes as separators
  assert.equal(normalizeDateString("2024/01/15", "fallback"), "2024-01-15");
  // falls back on non-strings
  assert.equal(normalizeDateString(20240115, "fallback"), "fallback");
  assert.equal(normalizeDateString(null, "fallback"), "fallback");
  // falls back on bad formats
  assert.equal(normalizeDateString("not-a-date", "fallback"), "fallback");
  assert.equal(normalizeDateString("2024-1-5", "fallback"), "fallback");
  assert.equal(normalizeDateString("", "fallback"), "fallback");
  // falls back on impossible calendar dates
  assert.equal(normalizeDateString("2024-02-30", "fallback"), "fallback");
  assert.equal(normalizeDateString("2024-13-01", "fallback"), "fallback");
});

test("normalizeNumberValue parses numbers with optional constraints", () => {
  assert.equal(normalizeNumberValue(42, 0), 42);
  assert.equal(normalizeNumberValue("3.14", 0), 3.14);
  assert.equal(normalizeNumberValue("bad", 0), 0);
  assert.equal(normalizeNumberValue(NaN, 0), 0);
  assert.equal(normalizeNumberValue(Infinity, 0), 0);
  // min/max clamping returns fallback, not clamped value
  assert.equal(normalizeNumberValue(5, 99, { min: 10 }), 99);
  assert.equal(normalizeNumberValue(15, 99, { max: 10 }), 99);
  assert.equal(normalizeNumberValue(10, 99, { min: 10, max: 20 }), 10);
  // integer constraint
  assert.equal(normalizeNumberValue(3.5, 99, { integer: true }), 99);
  assert.equal(normalizeNumberValue(3, 99, { integer: true }), 3);
});

test("normalizeBooleanValue coerces strings and falls back for unknown", () => {
  assert.equal(normalizeBooleanValue(true, false), true);
  assert.equal(normalizeBooleanValue(false, true), false);
  assert.equal(normalizeBooleanValue("true", false), true);
  assert.equal(normalizeBooleanValue("false", true), false);
  assert.equal(normalizeBooleanValue("yes", true), true);
  assert.equal(normalizeBooleanValue(1, true), true);
  assert.equal(normalizeBooleanValue(null, true), true);
});

test("normalizeSelectValue accepts valid options and falls back for unknown", () => {
  assert.equal(normalizeSelectValue("a", ["a", "b", "c"] as const, "b"), "a");
  assert.equal(normalizeSelectValue("c", ["a", "b", "c"] as const, "b"), "c");
  assert.equal(normalizeSelectValue("d", ["a", "b", "c"] as const, "b"), "b");
  assert.equal(normalizeSelectValue(42, ["a", "b"] as const, "a"), "a");
});

test("normalizeObjectByDefaults sanitizes each field type by its default", () => {
  const defaults = { count: 5, label: "default", enabled: true };
  const result = normalizeObjectByDefaults(
    { count: "10", label: "custom", enabled: "false", extra: "ignored" },
    defaults,
  );
  assert.equal(result.count, 10);
  assert.equal(result.label, "custom");
  assert.equal(result.enabled, false);

  // falls back to default when coercion fails
  const bad = normalizeObjectByDefaults({ count: "bad", label: 999 }, defaults);
  assert.equal(bad.count, 5);
  assert.equal(bad.label, "default");

  // missing keys keep their default
  const partial = normalizeObjectByDefaults({ count: 3 }, defaults);
  assert.equal(partial.enabled, true);
});
