import test from "node:test";
import assert from "node:assert/strict";
import {
  getDefaultSmaPeriod,
  getDefaultSmaUpperBuffer,
  getDefaultSmaLowerBuffer,
  getDefaultWindowLength,
} from "../src/lib/simulation/defaults";

test("defaults return expected values", () => {
  assert.equal(getDefaultSmaPeriod("sp500"), 174);
  assert.equal(getDefaultSmaUpperBuffer("sp500"), 3.5);
  assert.equal(getDefaultSmaLowerBuffer("sp500"), 3.6);
  assert.equal(getDefaultSmaPeriod("nasdaq100"), 127);
  assert.equal(getDefaultSmaUpperBuffer("nasdaq100"), 19.3);
  assert.equal(getDefaultSmaLowerBuffer("nasdaq100"), 17.8);
  assert.equal(getDefaultWindowLength(), 10);
});

test("the default band is asymmetric, and stays that way", () => {
  // Upper governs re-entry, lower governs the exit. Collapsing them to one
  // number moves the trapdoor rather than the band — the futures-ladder bug in
  // AGENTS.md. A future edit that makes both sides equal should have to say so.
  for (const index of ["sp500", "nasdaq100"] as const) {
    assert.notEqual(
      getDefaultSmaUpperBuffer(index),
      getDefaultSmaLowerBuffer(index),
      `${index} default band collapsed to a symmetric buffer`,
    );
  }
});
