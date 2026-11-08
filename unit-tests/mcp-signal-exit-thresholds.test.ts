import test from "node:test";
import assert from "node:assert/strict";
import { signalExitThresholds } from "@/lib/mcp/signal-exit-thresholds";
import { computeRealizedVol, SMA_VOL_GATE } from "@/lib/simulation/vol-gate";
import { computeWilderRsi, SMA_RSI_BRAKE } from "@/lib/simulation/rsi-brake";

const prices = Array.from({ length: 200 }, (_, i) => ({ date: `day-${i}`, close: 100 * Math.exp(0.02 * Math.sin(i)) }));
const base = { index: "sp500" as const, prices, smaPeriod: 178, smaLowerBuffer: 5.5, volEnabled: true, volGateRiskOff: false,
  rsiBrakeEnabled: false, rsiBrakeRiskOff: false };

test("exit roots match the engine's rolling sample volatility for both indices", () => {
  for (const index of ["sp500", "nasdaq100"] as const) {
    const result = signalExitThresholds({ ...base, index });
    const gate = SMA_VOL_GATE[index];
    const closes = prices.map(p => p.close);
    for (const scenario of result.volatility.constantDeclineScenarios) {
      const path = [...closes];
      for (let day = 0; day < scenario.tradingDays; day++) path.push(path.at(-1)! * (1 + scenario.dailyReturnPctAtHorizon / 100));
      const vol = computeRealizedVol(path, gate.windowDays).at(-1)!;
      assert.ok(Math.abs(vol - gate.exitAbove) < 1e-10);
      const beyond = [...path.slice(0, -1), path.at(-1)! * 0.999];
      assert.ok(computeRealizedVol(beyond, gate.windowDays).at(-1)! > gate.exitAbove);
    }
    const up = [...closes, closes.at(-1)! * (1 + result.volatility.nextVolExitRisePct! / 100)];
    assert.ok(Math.abs(computeRealizedVol(up, gate.windowDays).at(-1)! - gate.exitAbove) < 1e-10);
  }
});

test("by-horizon boundary hits somewhere within the horizon and is monotonic", () => {
  const result = signalExitThresholds(base);
  let previous = -Infinity;
  for (const s of result.volatility.constantDeclineScenarios) {
    assert.ok(s.dailyReturnPctByHorizon >= previous);
    previous = s.dailyReturnPctByHorizon;
    const path = prices.map(p => p.close);
    for (let day = 0; day < s.tradingDays; day++) path.push(path.at(-1)! * (1 + s.dailyReturnPctByHorizon / 100));
    const futureVol = computeRealizedVol(path, 11).slice(-s.tradingDays);
    assert.ok(Math.abs(Math.max(...futureVol) - 0.42) < 1e-10);
  }
});

test("SMA boundary includes the candidate close and drops the oldest observation", () => {
  const result = signalExitThresholds(base);
  const path = [...prices.map(p => p.close), result.nextSmaExitClose!].slice(-base.smaPeriod);
  const sma = path.reduce((s, p) => s + p, 0) / path.length;
  assert.ok(Math.abs(result.nextSmaExitClose! - sma * 0.945) < 1e-10);
});

test("disabled, active and insufficient gates do not fabricate new-exit scenarios", () => {
  for (const [overrides, status] of [
    [{ volEnabled: false }, "disabled"],
    [{ volGateRiskOff: true }, "already-risk-off"],
    [{ prices: prices.slice(0, 2) }, "insufficient-data"],
    [{ prices: [...prices.slice(0, -1), { date: "bad", close: 0 }] }, "insufficient-data"],
  ] as const) {
    const result = signalExitThresholds({ ...base, ...overrides });
    assert.equal(result.volatility.status, status);
    assert.deepEqual(result.volatility.constantDeclineScenarios, []);
    assert.equal(result.volatility.nextVolExitRisePct, null);
  }
  assert.equal(signalExitThresholds({ ...base, prices: [] }).nextSmaExitClose, null);
});

const brakeBase = { ...base, rsiBrakeEnabled: true, rsiBrakeRiskOff: false };

test("RSI brake boundary is the close that puts the engine's Wilder RSI exactly on the exit level", () => {
  for (const index of ["sp500", "nasdaq100"] as const) {
    const result = signalExitThresholds({ ...brakeBase, index });
    const brake = SMA_RSI_BRAKE[index];
    const closes = prices.map(p => p.close);
    assert.equal(result.rsiBrake.status, "available");
    assert.equal(result.rsiBrake.periodDays, brake.periodDays);
    assert.equal(result.rsiBrake.exitBelow, brake.exitBelow);
    assert.equal(result.rsiBrake.reenterAbove, brake.reenterAbove);
    assert.ok(Math.abs(result.rsiBrake.rsi! - computeWilderRsi(closes, brake.periodDays).at(-1)!) < 1e-12);
    const close = result.rsiBrake.nextExitClose!;
    assert.ok(close < closes.at(-1)!);
    assert.ok(Math.abs(computeWilderRsi([...closes, close], brake.periodDays).at(-1)! - brake.exitBelow) < 1e-9);
    assert.ok(computeWilderRsi([...closes, close * 0.999], brake.periodDays).at(-1)! < brake.exitBelow);
    assert.ok(Math.abs(result.rsiBrake.nextExitReturnPct! - (close / closes.at(-1)! - 1) * 100) < 1e-12);
  }
});

test("disabled, active and insufficient brakes do not fabricate an exit close", () => {
  for (const [overrides, status] of [
    [{ rsiBrakeEnabled: false }, "disabled"],
    [{ rsiBrakeRiskOff: true }, "already-risk-off"],
    [{ prices: prices.slice(0, 10) }, "insufficient-data"],
    [{ prices: [...prices.slice(0, -1), { date: "bad", close: 0 }] }, "insufficient-data"],
  ] as const) {
    const result = signalExitThresholds({ ...brakeBase, ...overrides });
    assert.equal(result.rsiBrake.status, status);
    assert.equal(result.rsiBrake.nextExitClose, null);
    assert.equal(result.rsiBrake.nextExitReturnPct, null);
  }
});
