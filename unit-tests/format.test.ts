import test from "node:test";
import assert from "node:assert/strict";
import {
  formatAdaptiveMultiple,
  formatPercent,
  formatCostPercent,
  formatMultiple,
  formatCurrency,
  formatNumber,
  formatDate,
} from "@/lib/format";

test("adaptive multiple formatting increases precision near zero", () => {
  assert.equal(formatAdaptiveMultiple(16.72), "16.72x");
  assert.equal(formatAdaptiveMultiple(0.42), "0.42x");
  assert.equal(formatAdaptiveMultiple(0.0375), "0.038x");
  assert.equal(formatAdaptiveMultiple(0.004375), "0.0044x");
  assert.equal(formatAdaptiveMultiple(0.0004375), "0.00044x");
  assert.equal(formatAdaptiveMultiple(Infinity), "0x");
  assert.equal(formatAdaptiveMultiple(0), "0x");
});

test("formatPercent appends % with two decimal places", () => {
  assert.equal(formatPercent(3.14), "3.14%");
  assert.equal(formatPercent(-1.5), "-1.50%");
  assert.equal(formatPercent(0), "0.00%");
  assert.equal(formatPercent(100), "100.00%");
});

test("formatCostPercent appends % and rounds to 2 decimals", () => {
  assert.equal(formatCostPercent(0.95), "0.95%");
});

test("formatMultiple appends x with two decimal places", () => {
  assert.equal(formatMultiple(2.5), "2.50x");
  assert.equal(formatMultiple(1), "1.00x");
  assert.equal(formatMultiple(0), "0.00x");
});

test("formatCurrency formats as USD with no cents", () => {
  assert.equal(formatCurrency(12345), "$12,345");
  assert.equal(formatCurrency(0), "$0");
  assert.equal(formatCurrency(1000000), "$1,000,000");
});

test("formatNumber formats integers with commas", () => {
  assert.equal(formatNumber(12345), "12,345");
  assert.equal(formatNumber(0), "0");
  assert.equal(formatNumber(1000000), "1,000,000");
});

test("formatDate replaces dashes with slashes", () => {
  assert.equal(formatDate("2024-01-15"), "2024/01/15");
  assert.equal(formatDate("2020-12-31"), "2020/12/31");
});
