import test from "node:test";
import assert from "node:assert/strict";
import { annualizedInflationForRange } from "@/lib/inflation";
import {
  buildRealEndValuePercentileSeries,
  computeRealEndValue,
  inverseTransformRealEndValue,
  percentile,
  transformRealEndValue,
} from "@/lib/strategy-percentiles";
import type { RollingSimulationPoint } from "@/lib/simulation/rolling";

test("percentile interpolates between sorted values", () => {
  assert.equal(percentile([0, 100, 200], 0), 0);
  assert.equal(percentile([0, 100, 200], 0.25), 50);
  assert.equal(percentile([0, 100, 200], 0.5), 100);
  assert.equal(percentile([0, 100, 200], 0.75), 150);
  assert.equal(percentile([0, 100, 200], 1), 200);
});

test("computes inflation-adjusted real end value", () => {
  const monthlyCpi = [
    { date: "2019-01-01", value: 100 },
    { date: "2020-01-01", value: 110 },
  ];
  const run: Pick<RollingSimulationPoint, "startDate" | "endDate" | "finalValue"> = {
    startDate: "2019-01-01",
    endDate: "2020-01-01",
    finalValue: 11000,
  };

  const inflation = annualizedInflationForRange(monthlyCpi, run.startDate, run.endDate);
  const years = (new Date(`${run.endDate}T00:00:00Z`).getTime() - new Date(`${run.startDate}T00:00:00Z`).getTime()) / (365.25 * 24 * 60 * 60 * 1000);
  const expected = run.finalValue / Math.pow(1 + inflation, years);

  assert.ok(Math.abs(computeRealEndValue(run, monthlyCpi) - expected) < 1e-9);
});

test("builds ordered percentile series and preserves colors", () => {
  const monthlyCpi: Array<{ date: string; value: number }> = [];
  const baseRun = (finalValue: number): Pick<RollingSimulationPoint, "startDate" | "endDate" | "finalValue"> => ({
    startDate: "2020-01-01",
    endDate: "2021-01-01",
    finalValue,
  });

  const series = buildRealEndValuePercentileSeries({
    strategies: [
      {
        label: "UPRO",
        color: "#16f3ce",
        runs: [baseRun(10000), baseRun(12000), baseRun(14000)],
      },
      {
        label: "TQQQ SMA",
        color: "#a16207",
        runs: [],
      },
      {
        label: "QLD",
        color: "#f97316",
        runs: [baseRun(11000), baseRun(13000)],
      },
    ],
    monthlyCpi,
    pointCount: 5,
  });

  assert.deepEqual(series.map((item) => item.label), ["UPRO", "QLD"]);
  assert.deepEqual(series.map((item) => item.color), ["#16f3ce", "#f97316"]);
  assert.equal(series[0].points.length, 5);
  assert.equal(series[0].points[0].x, 0);
  assert.equal(series[0].points[4].x, 100);
  assert.equal(series[0].points[0].y, 10000);
  assert.equal(series[0].points[2].y, 12000);
  assert.equal(series[0].points[4].y, 14000);
});

test("log transform is reversible for nonnegative values", () => {
  for (const value of [0, 2.5, 100, 10000]) {
    const transformed = transformRealEndValue(value, true);
    const roundTrip = inverseTransformRealEndValue(transformed, true);
    assert.ok(Math.abs(roundTrip - value) < 1e-9);
    assert.equal(transformRealEndValue(value, false), value);
    assert.equal(inverseTransformRealEndValue(value, false), value);
  }
});
