import test from "node:test";
import assert from "node:assert/strict";
import {
  getDefaultSmaPeriod,
  getDefaultSmaBuffer,
  getDefaultWindowLength
} from "../src/lib/simulation/defaults";

test("defaults return expected values", () => {
  assert.equal(getDefaultSmaPeriod("sp500"), 185);
  assert.equal(getDefaultSmaPeriod("nasdaq100"), 150);
  assert.equal(getDefaultSmaBuffer("sp500"), 3.6);
  assert.equal(getDefaultSmaBuffer("nasdaq100"), 11.9);
  assert.equal(getDefaultWindowLength(), 10);
});
