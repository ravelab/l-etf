import test from "node:test";
import assert from "node:assert/strict";
import calibration from "../src/lib/tool-snapshots/sma-calibration.json";
import {
  getDefaultSmaPeriod,
  getDefaultSmaUpperBuffer,
  getDefaultSmaLowerBuffer,
  getDefaultWindowLength,
} from "../src/lib/simulation/defaults";

test("defaults follow the saved calibration", () => {
  for (const index of ["sp500", "nasdaq100"] as const) {
    assert.equal(getDefaultSmaPeriod(index), calibration[index].smaPeriod);
    assert.equal(getDefaultSmaUpperBuffer(index), calibration[index].smaUpperBuffer);
    assert.equal(getDefaultSmaLowerBuffer(index), calibration[index].smaLowerBuffer);
  }
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
