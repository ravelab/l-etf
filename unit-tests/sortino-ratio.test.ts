import assert from "node:assert/strict";
import test from "node:test";
import { calcSortinoRatio } from "../src/lib/simulation/metrics";

test("Sortino uses downside RMS across all daily returns and annualizes", () => {
  // +10%, -10%, +20%: mean 1/15, downside deviation sqrt(.01/3).
  const values = [100, 110, 99, 118.8];
  const expected = (1 / 15) / Math.sqrt(0.01 / 3) * Math.sqrt(252);
  assert.ok(Math.abs(calcSortinoRatio(values) - expected) < 1e-10);
  assert.equal(calcSortinoRatio(values), calcSortinoRatio(values));
});

test("Sortino handles flat, insufficient, upside-only, and wiped-out paths", () => {
  assert.equal(calcSortinoRatio([]), 0);
  assert.equal(calcSortinoRatio([100, 90]), 0);
  assert.equal(calcSortinoRatio([100, 100, 100]), 0);
  assert.equal(calcSortinoRatio([100, 110, 121]), Infinity);
  assert.ok(calcSortinoRatio([100, 90, 0, 0]) < 0);
  assert.equal(calcSortinoRatio([0, 0, 0]), 0);
});

test("upside variation is not included in downside deviation", () => {
  // Same mean and same negative return; only positive-return dispersion differs.
  const smooth = [100, 90, 108, 129.6]; // -.1, .2, .2
  const varied = [100, 90, 99, 128.7]; // -.1, .1, .3
  assert.ok(Math.abs(calcSortinoRatio(smooth) - calcSortinoRatio(varied)) < 1e-10);
});
