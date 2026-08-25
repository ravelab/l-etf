import test from "node:test";
import assert from "node:assert/strict";
import { simulateBacktest } from "../src/lib/simulation/engine";
import type { EtfConfig, PricePoint, RatePoint } from "../src/lib/simulation/types";

const rates: RatePoint[] = [{ date: "1900-01-01", rateValue: 0.05, rateType: "borrow" }];

function config(): EtfConfig {
  return {
    id: "SSO", name: "SSO", leverage: 2, expenseRatio: 0.91, simulated: true,
    smaEnabled: false, smaPeriod: 200, smaUpperBuffer: 0, smaLowerBuffer: 0,
    smaIndex: "sp500", riskOffAsset: "SGOV",
  };
}

function series(n: number, tailMultiplier: number): PricePoint[] {
  const out: PricePoint[] = [];
  let v = 100;
  for (let i = 0; i < n; i++) {
    v *= 1.0004;
    // Perturb ONLY rows past the last sampled index: step = floor(len/500), so
    // the stride stops at step*floor((n-1)/step) and never reaches these.
    const step = Math.max(1, Math.floor(n / 500));
    const lastSampled = step * Math.floor((n - 1) / step);
    const inTail = i > lastSampled;
    const value = inTail ? v * tailMultiplier : v;
    const day = new Date(Date.UTC(1990, 0, 1) + i * 86400000).toISOString().slice(0, 10);
    out.push({ date: day, adj_close: value, close: value });
  }
  return out;
}

test("two series differing only in their tail do not share cached derived arrays", () => {
  // len is identical and the sampling stride skips the differing rows, so a
  // tail-blind hash collides and the second run silently reuses the first's
  // arrays -- returning the first series' result.
  const n = 3000;
  const a = simulateBacktest(series(n, 1.0), rates, [config()]);
  const b = simulateBacktest(series(n, 1.5), rates, [config()]);

  const finalA = a.etfResults[0].finalValue;
  const finalB = b.etfResults[0].finalValue;
  assert.notEqual(
    finalB,
    finalA,
    "a 50% tail move must change the result; identical values mean the cache key collided"
  );
});
