import test from "node:test";
import assert from "node:assert/strict";
import { buildPresetBacktestUrl } from "../src/lib/url-builders";
import { ETF_PRESETS } from "../src/lib/simulation/presets";

test("buildPresetBacktestUrl builds correct query params", () => {
  const url = buildPresetBacktestUrl({
    preset: ETF_PRESETS["UPRO"],
    startDate: "2020-01-01",
    endDate: "2021-01-01",
    smaPeriod: 185,
    smaBuffer: 3.5,
    riskOffAsset: "SGOV"
  });
  
  const u = new URL(url, "http://localhost");
  assert.equal(u.searchParams.get("tab"), "backtest");
  assert.equal(u.searchParams.get("letf"), "UPRO");
  assert.equal(u.searchParams.get("sd"), "2020-01-01");
  assert.equal(u.searchParams.get("ed"), "2021-01-01");
  assert.equal(u.searchParams.get("smaPsp"), "185");
  assert.equal(u.searchParams.get("smatsp"), "3.5");
  assert.equal(u.searchParams.get("ro"), "SGOV");
  assert.equal(u.searchParams.get("autorun"), "1");
});

test("buildPresetBacktestUrl uses nasdaq params for nasdaq index", () => {
  const url = buildPresetBacktestUrl({
    preset: ETF_PRESETS["TQQQ"],
    startDate: "2020-01-01",
    endDate: "2021-01-01",
    smaPeriod: 150,
    smaBuffer: 12,
    riskOffAsset: "SGOV"
  });
  
  const u = new URL(url, "http://localhost");
  assert.equal(u.searchParams.get("smaPnq"), "150");
  assert.equal(u.searchParams.get("smatnq"), "12");
  assert.equal(u.searchParams.has("smaPsp"), false);
});
