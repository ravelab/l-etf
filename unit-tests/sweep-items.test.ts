import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRiskOffVariantConfigs,
  buildSmaPeriodSweepItems,
  buildSymmetricBufferSweepItems,
  encodeAsymBuffer,
  makeAsymmetricSweepItem,
  type SweepPresetDef,
} from "@/lib/simulation/sweep-items";
import { getDefaultSmaPeriod } from "@/lib/simulation/defaults";

const PRESET: SweepPresetDef = {
  name: "UPRO",
  leverage: 3,
  expenseRatio: 0.91,
  simulated: true,
  index: "sp500",
};

test("buildSmaPeriodSweepItems: baseline first, then one config per period", () => {
  const items = buildSmaPeriodSweepItems({
    preset: PRESET,
    riskOffAsset: "SGOV",
    minSmaPeriod: 100,
    maxSmaPeriod: 200,
    stepSize: 50,
    upperBuffer: 3,
    lowerBuffer: 4,
  });
  assert.equal(items.length, 4);
  const [base, ...sweep] = items;
  assert.deepEqual(
    { pv: base.paramValue, id: base.config.id, sma: base.config.smaEnabled, period: base.config.smaPeriod, sim: base.config.simulated },
    { pv: 0, id: "baseline", sma: false, period: getDefaultSmaPeriod("sp500"), sim: true },
  );
  assert.deepEqual(
    sweep.map((i) => [i.paramValue, i.config.id, i.config.name]),
    [
      [100, "sma-100", "UPRO SMA 100"],
      [150, "sma-150", "UPRO SMA 150"],
      [200, "sma-200", "UPRO SMA 200"],
    ],
  );
  assert.equal(sweep[0].config.smaUpperBuffer, 3);
  assert.equal(sweep[0].config.smaLowerBuffer, 4);
  assert.equal(sweep[0].config.riskOffAsset, "SGOV");
});

test("buildRiskOffVariantConfigs: variants first, no-SMA baseline last", () => {
  const configs = buildRiskOffVariantConfigs({
    preset: PRESET,
    baselineRiskOffAsset: "BRK.B+GLDM+VGSH",
    assets: ["SGOV", "GLDM"],
    smaPeriod: 185,
    upperBuffer: 3,
    lowerBuffer: 4,
  });
  assert.deepEqual(
    configs.map((c) => [c.label, c.config.id, c.config.name]),
    [
      ["SGOV", "riskoff-SGOV", "3x SMA 185 (SGOV)"],
      ["GLDM", "riskoff-GLDM", "3x SMA 185 (GLDM)"],
      ["baseline", "baseline", "UPRO (No SMA)"],
    ],
  );
  assert.equal(configs[2].config.smaEnabled, false);
  assert.equal(configs[2].config.riskOffAsset, "BRK.B+GLDM+VGSH");
});

test("buildSymmetricBufferSweepItems: baseline uses the given period, then symmetric buffers", () => {
  const items = buildSymmetricBufferSweepItems({
    preset: PRESET,
    riskOffAsset: "SGOV",
    smaPeriod: 150,
    minBuffer: 0,
    maxBuffer: 2,
    fineStep: 1,
  });
  assert.equal(items.length, 4);
  assert.equal(items[0].config.smaPeriod, 150); // not the index default
  assert.equal(items[0].config.smaEnabled, false);
  assert.deepEqual(
    items.slice(1).map((i) => [i.paramValue, i.config.id, i.config.smaUpperBuffer, i.config.smaLowerBuffer]),
    [
      [0, "buffer-0", 0, 0],
      [1, "buffer-1", 1, 1],
      [2, "buffer-2", 2, 2],
    ],
  );
});

test("makeAsymmetricSweepItem encodes the (upper, lower) pair", () => {
  assert.equal(encodeAsymBuffer(5, 2), 5000200);
  const item = makeAsymmetricSweepItem({
    preset: PRESET,
    riskOffAsset: "SGOV",
    smaPeriod: 185,
    upper: 5,
    lower: 2,
    variant: "coarse",
  });
  assert.equal(item.paramValue, 5000200);
  assert.equal(item.config.id, "asym-5000200");
  assert.equal(item.config.name, "UPRO SMA 185 U5/L2 (coarse)");
  assert.equal(item.config.smaUpperBuffer, 5);
  assert.equal(item.config.smaLowerBuffer, 2);
});
