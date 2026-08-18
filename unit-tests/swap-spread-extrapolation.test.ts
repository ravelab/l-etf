import test from "node:test";
import assert from "node:assert/strict";
import { getSwapSpreadDaily, getSwapSpreadModel } from "@/lib/simulation/engine";
import { ETF_PRESETS } from "@/lib/simulation/presets";

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

// Read the live model rather than transcribing it: `calibrate-etfs.ts` rewrites
// these coefficients on a schedule, and a hardcoded copy would either go stale
// (the way the FAQ table did) or fail the build every calibration.
const CASES = (["SSO", "UPRO", "QLD", "TQQQ"] as const).map((etf) => {
  const preset = ETF_PRESETS[etf];
  const model = getSwapSpreadModel()[preset.index][preset.leverage];
  return { index: preset.index, leverage: preset.leverage, ...model };
});

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
