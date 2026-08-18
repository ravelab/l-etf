import test from "node:test";
import assert from "node:assert/strict";
import { getSwapSpreadDaily } from "@/lib/simulation/engine";

// The engine charges `annualRate / 360` on ~252 trading days a year, so the
// borrow term alone delivers only this fraction of the annual rate; the swap
// spread carries the rest.
const TRADING_DAY_FRACTION = 252 / 360;

/** All-in annual financing per unit borrowed, as the daily loop actually charges it. */
function financingPerUnitBorrowed(index: string, annualRate: number, leverage: number): number {
  const spreadAnnual = getSwapSpreadDaily(index, annualRate / 360, leverage) * 360;
  return TRADING_DAY_FRACTION * (annualRate + spreadAnnual);
}

const CALIBRATED_RATE_MAX = 0.06;
const CASES = [
  { index: "sp500", leverage: 3, rateSensitivity: 0.899306, baseSpread: 0.002997 },
  { index: "nasdaq100", leverage: 3, rateSensitivity: 1.078049, baseSpread: -0.001198 },
  { index: "sp500", leverage: 2, rateSensitivity: 0.718186, baseSpread: 0.004127 },
  { index: "nasdaq100", leverage: 2, rateSensitivity: 0.899135, baseSpread: -0.000226 },
];

test("swap spread: unchanged at every rate the model is calibrated on", () => {
  // The real ETFs only exist from 2006/2009-10, where the benchmark tops out at
  // 5.82%. Every one of those days must price exactly as the fitted line does,
  // or the calibration stops describing the simulation it was fitted to.
  for (const { index, leverage, rateSensitivity, baseSpread } of CASES) {
    for (let bp = 0; bp <= 600; bp += 5) {
      const annualRate = bp / 10000;
      const expected = Math.max(rateSensitivity * annualRate + baseSpread, 0) / 360;
      const actual = getSwapSpreadDaily(index, annualRate / 360, leverage);
      assert.equal(
        Math.abs(actual - expected) < 1e-15,
        true,
        `${index} ${leverage}x at ${(annualRate * 100).toFixed(2)}%: ${actual} !== ${expected}`
      );
    }
  }
});

test("swap spread: the credit premium stops growing past the fitted range", () => {
  // Above the calibrated ceiling the fitted slope is pure extrapolation, so the
  // premium over the risk-free rate holds at its end-of-range value.
  for (const { index, leverage } of CASES) {
    const premiumAtCap =
      financingPerUnitBorrowed(index, CALIBRATED_RATE_MAX, leverage) - CALIBRATED_RATE_MAX;
    for (const annualRate of [0.07, 0.1, 0.15, 0.2]) {
      const premium = financingPerUnitBorrowed(index, annualRate, leverage) - annualRate;
      assert.equal(
        Math.abs(premium - premiumAtCap) < 1e-12,
        true,
        `${index} ${leverage}x at ${(annualRate * 100).toFixed(0)}%: premium ${premium} drifted from ${premiumAtCap}`
      );
    }
  }
});

test("swap spread: leveraged financing never undercuts the risk-free rate", () => {
  // Capping the spread outright (rather than only its credit component) would
  // make a 1981 backtest borrow below risk-free, because the borrow term only
  // carries 252/360 of the rate.
  for (const { index, leverage } of CASES) {
    for (const annualRate of [0.02, 0.06, 0.1, 0.15, 0.2]) {
      const financing = financingPerUnitBorrowed(index, annualRate, leverage);
      assert.equal(
        financing > annualRate,
        true,
        `${index} ${leverage}x at ${(annualRate * 100).toFixed(0)}%: financing ${financing} <= rate`
      );
    }
  }
});
