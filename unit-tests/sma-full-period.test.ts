import { generateSmaSignals } from "../src/lib/simulation/sma";
import { smaReentryPenaltyFraction } from "../src/lib/simulation/sma-search-bounds";
import assert from "node:assert/strict";
import { it } from "node:test";
import { buildSmaEraContexts, evaluateCombosAcrossEras } from "../scripts/lib/sma-sweep-context";
import { scoreFullPeriod } from "../src/lib/simulation/score";

it("calibration uses one actual full-length window and annualizes trade frequency", async () => {
  const eras = await buildSmaEraContexts({ indexKey: "sp500", endDate: "2026-10-30", windowLength: 10, maxPeriod: 280 });
  assert.equal(eras.contexts.length, 1);
  const ctx = eras.contexts[0].ctx;
  assert.equal(ctx.windows.length, 1);
  const window = ctx.windows[0];
  assert.equal(window.startDate, "1988-04-06");
  assert.equal(window.endDate, "2026-10-30");
  assert.equal(window.usesSyntheticTail, false);
  assert.ok(window.startIdx > 0, "warm-up must precede scored history");
  assert.ok(ctx.windowLength > 38 && ctx.windowLength < 39);
  const [result] = evaluateCombosAcrossEras(eras, [{ smaPeriod: 175, smaUpperBuffer: 3.5, smaLowerBuffer: 3.5 }]);
  assert.equal(result.row.historyWrapApplied, false);
  assert.equal(result.row.avgReturn, result.row.worstReturn);
  assert.equal(result.score, scoreFullPeriod(result.row, ctx.inflPct, ctx.windowLength, result.smaOnlySwitches));
  const row = { ...result.row, avgTrades: 12 };
  // Same annual CAGR, drawdown and switching frequency must score identically,
  // whether observed over 10 or 40 years. Total wealth is not a score input.
  assert.equal(scoreFullPeriod(row, 0, 40), scoreFullPeriod({ ...row, avgTrades: 3 }, 0, 10));
  assert.notEqual(scoreFullPeriod(row, 0, 40), scoreFullPeriod(row, 0, 10));
  assert.equal(scoreFullPeriod(row, 0, 40), scoreFullPeriod({ ...row, worstReturn: -100 }, 0, 40));
  assert.ok(scoreFullPeriod({ ...row, avgReturn: row.avgReturn + 1 }, 0, 40) > scoreFullPeriod(row, 0, 40));
  assert.ok(scoreFullPeriod({ ...row, biggestMaxDrawdown: 90 }, 0, 40) < scoreFullPeriod(row, 0, 40));
  assert.throws(() => scoreFullPeriod(row, 0, 0));
});

it("volatility-gate switches cannot satisfy the SMA-only activity preference", async () => {
  const eras = await buildSmaEraContexts({ indexKey: "nasdaq100", endDate: "2026-10-30", windowLength: 40, maxPeriod: 280 });
  const rows = evaluateCombosAcrossEras(eras, [
    { smaPeriod: 119, smaUpperBuffer: 15.7, smaLowerBuffer: 20.2 },
    { smaPeriod: 136, smaUpperBuffer: 9.6, smaLowerBuffer: 18 },
  ]);
  assert.deepEqual(rows.map(r => r.smaOnlySwitches), [6, 10]);
  for (const r of rows) assert.ok(r.row.avgTrades > r.smaOnlySwitches);
  const row = { ...rows[0].row, avgTrades: 24 };
  const years = eras.contexts[0].ctx.windowLength;
  assert.ok(scoreFullPeriod(row, 0, years, 10) > scoreFullPeriod(row, 0, years, 6));
  assert.ok(scoreFullPeriod(row, 0, years, 6) < scoreFullPeriod(row, 0, years));
  assert.equal(scoreFullPeriod(row, 0, 40, 8), scoreFullPeriod({ ...row, avgTrades: 6 }, 0, 10, 2));
});


it("a smooth recovery can leave the wider re-entry band locked out", () => {
  const prices = Array.from({ length: 1260 }, (_, i) => 100 * Math.pow(1.5, i / 252));
  const dates = prices.map((_, i) => new Date(Date.UTC(2000, 0, 1 + i)).toISOString().slice(0, 10));
  const wide = { smaPeriod: 119, smaUpperBuffer: 15.7 };
  const moderate = { smaPeriod: 136, smaUpperBuffer: 9.6 };
  const signals = (combo: typeof wide) => generateSmaSignals(dates, prices, combo.smaPeriod,
    { upper: combo.smaUpperBuffer, lower: 18 }, { initialInvested: false, seedAtIndex: 280 });
  assert.equal(signals(wide).signals.filter(s => s.type === "buy").length, 0);
  assert.ok(signals(moderate).signals.some(s => s.type === "buy"));
  assert.ok(smaReentryPenaltyFraction(wide) > smaReentryPenaltyFraction(moderate));
  assert.ok(smaReentryPenaltyFraction({ ...moderate, smaUpperBuffer: 12 }) > smaReentryPenaltyFraction(moderate));
  assert.ok(smaReentryPenaltyFraction({ ...moderate, smaPeriod: 160 }) < smaReentryPenaltyFraction(moderate));
});
