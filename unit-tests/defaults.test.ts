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

test("asymmetric calibrated bands keep distinct entry and exit buffers", () => {
  // Upper governs re-entry, lower governs the exit. Collapsing them to one
  // number moves the trapdoor rather than the band — the futures-ladder bug in
  // AGENTS.md. Calibration may legitimately choose equal values; only bands
  // with different calibrated values must preserve that asymmetry.
  for (const index of ["sp500", "nasdaq100"] as const) {
    if (calibration[index].smaUpperBuffer === calibration[index].smaLowerBuffer) continue;
    assert.notEqual(
      getDefaultSmaUpperBuffer(index),
      getDefaultSmaLowerBuffer(index),
      `${index} default band collapsed to a symmetric buffer`,
    );
  }
});

test("the site default is the inflation-adjusted set with its flag; MCP keeps the nominal pair", async () => {
  const { DEFAULT_SMA_INFLATION_ADJUSTED, getSiteDefaultSmaRule, getInflationAdjustedDefaultSmaBand, getDefaultSmaPeriod } =
    await import("../src/lib/simulation/defaults");
  const { getDefaultSmaSignalConfig } = await import("../src/lib/sma-status");
  assert.equal(DEFAULT_SMA_INFLATION_ADJUSTED, true);
  for (const index of ["sp500", "nasdaq100"] as const) {
    assert.deepEqual(getSiteDefaultSmaRule(index), { ...getInflationAdjustedDefaultSmaBand(index), smaInflationAdjusted: true });
  }
  const site = getDefaultSmaSignalConfig();
  assert.equal(site.smaInflationAdjusted, true);
  assert.equal(site.smaSpPeriod, getInflationAdjustedDefaultSmaBand("sp500").smaPeriod);
  const nominal = getDefaultSmaSignalConfig(false);
  assert.equal(nominal.smaInflationAdjusted, false);
  assert.equal(nominal.smaSpPeriod, getDefaultSmaPeriod("sp500"));
});
