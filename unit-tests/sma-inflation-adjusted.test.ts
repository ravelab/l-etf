import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildCpiModule } from "../scripts/lib/cpi-module";
import cpiModule from "@/lib/tool-snapshots/cpi-monthly.json";
import { CPI_RELEASE_DAY, cpiDeflatorForDates, cpiKnownOn } from "@/lib/simulation/cpi-deflator";
import { generateSmaSignals } from "@/lib/simulation/sma";
import { dedupeExpandedConfigs } from "@/lib/simulation/etf-config-expansion";
import { createPresetEtfConfig, ETF_PRESETS } from "@/lib/simulation/presets";

test("the bundled CPI module matches data/inflation.csv", () => {
  const csv = readFileSync(join(process.cwd(), "data/inflation.csv"), "utf8");
  assert.deepEqual(buildCpiModule(csv), cpiModule, "run `npm run fetch-data -- inflation` to regenerate");
});

test("a month's CPI counts from the release day of the next month", () => {
  const cpi = { startMonth: "2020-01", values: [100, 101, 102, 103] };
  assert.equal(CPI_RELEASE_DAY, 15);
  assert.equal(cpiKnownOn("2020-03-14", cpi), 100, "before the 15th: January, the month before last");
  assert.equal(cpiKnownOn("2020-03-15", cpi), 101, "from the 15th: February");
  assert.equal(cpiKnownOn("2019-06-30", cpi), 100, "before the series: its first value");
  assert.equal(cpiKnownOn("2030-01-20", cpi), 103, "past the newest print: it holds");
});

test("a skipped source month repeats the prior value", () => {
  const csv = "date,value,name,source\n1914-06,10,CPI,x\n1914-07,11,CPI,x\n1914-10,12,CPI,x\n";
  assert.deepEqual(buildCpiModule(csv), { startMonth: "1914-06", values: [10, 11, 11, 11, 12] });
});

test("the inflation-adjusted band is the nominal band run on CPI-deflated prices", () => {
  // Nominal prices rise ~8%/yr then fall; long enough to cross the band both ways.
  const dates: string[] = [];
  const prices: number[] = [];
  for (let i = 0; i < 1500; i++) {
    const d = new Date(Date.UTC(1972, 0, 3) + i * 86_400_000 * 1.45);
    dates.push(d.toISOString().slice(0, 10));
    prices.push(100 * Math.exp(0.0003 * i) * (1 + 0.15 * Math.sin(i / 90)));
  }
  const band = { upper: 2, lower: 4 };
  const deflator = cpiDeflatorForDates(dates);
  const real = generateSmaSignals(dates, prices, 100, band, { inflationAdjusted: true });
  const onDeflated = generateSmaSignals(dates, prices.map((p, i) => p / deflator[i]), 100, band);
  assert.deepEqual(real.invested, onDeflated.invested);
  real.smaValues.forEach((value, i) => {
    if (Number.isNaN(value)) return assert.ok(Number.isNaN(onDeflated.smaValues[i]));
    assert.ok(Math.abs(value - onDeflated.smaValues[i] * deflator[i]) < 1e-9 * value, "SMA re-inflated to the day's dollars");
  });
  real.signals.forEach((signal) => assert.equal(signal.price, prices[dates.indexOf(signal.date)], "signals keep nominal prices"));

  const nominal = generateSmaSignals(dates, prices, 100, band);
  assert.notDeepEqual(real.invested, nominal.invested, "1970s inflation moves the band");
});

test("an inflation-adjusted config is never deduplicated with its nominal twin", () => {
  const base = createPresetEtfConfig("etf1", ETF_PRESETS.UPRO, { smaEnabled: true, smaPeriod: 200, smaUpperBuffer: 3, smaLowerBuffer: 5 });
  const { unique } = dedupeExpandedConfigs([base, { ...base, id: "etf2", smaInflationAdjusted: true }]);
  assert.equal(unique.length, 2);
});

test("the Signals page replay agrees with the engine on the inflation-adjusted band", async () => {
  const { getSmaSignal } = await import("@/lib/sma-signals");
  const band = { upper: 2, lower: 4 };
  // Walk the end date through a 1970s path; the replay and the engine must name the same regime.
  const dates: string[] = [];
  const closes: number[] = [];
  for (let i = 0; i < 1200; i++) {
    dates.push(new Date(Date.UTC(1973, 0, 2) + i * 86_400_000 * 1.45).toISOString().slice(0, 10));
    closes.push(100 * Math.exp(0.0004 * i) * (1 + 0.12 * Math.sin(i / 70)));
  }
  let disagreements = 0;
  let realOnlyDiffers = 0;
  for (let end = 400; end <= dates.length; end += 25) {
    const d = dates.slice(0, end);
    const c = closes.slice(0, end);
    const engine = generateSmaSignals(d, c, 100, band, { inflationAdjusted: true }).invested[end - 1];
    const daily = d.map((date, i) => ({ date, close: c[i], name: "SPX" })) as Parameters<typeof getSmaSignal>[0];
    const replay = getSmaSignal(daily, 100, band, { inflationAdjusted: true });
    const replayRiskOn = replay.regime === "risk-on";
    if (replayRiskOn !== engine) disagreements++;
    const nominal = getSmaSignal(daily, 100, band);
    if (nominal.signal !== replay.signal || nominal.regime !== replay.regime) realOnlyDiffers++;
  }
  assert.equal(disagreements, 0);
  assert.ok(realOnlyDiffers > 0, "the fixture must reach a day where inflation changes the call");
});
