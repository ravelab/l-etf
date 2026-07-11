import test from "node:test";
import assert from "node:assert/strict";
import {
  getDaysTillNextEvent,
  getRiskOffAdvantage,
  getRiskOffRealCagr,
  getRiskOffTotalRealReturn,
  getRiskOnRealCagr,
  type SmaSegmentContext,
} from "../src/lib/sma-trade-metrics";
import type { SmaTradeRow } from "../src/lib/sma-trade-rows";

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;
const T0 = "2020-01-01";
const T1 = "2022-01-01";
const YEARS = (Date.UTC(2022, 0, 1) - Date.UTC(2020, 0, 1)) / MS_PER_YEAR;
const INFLATION = 0.03;

function row(partial: Partial<SmaTradeRow> & Pick<SmaTradeRow, "signalDate" | "signalType">): SmaTradeRow {
  return {
    tradingDay: partial.signalDate,
    action: "",
    eventPrice: null,
    triggerClose: null,
    triggerSmaPctDiff: null,
    actionToneClass: "",
    ...partial,
  };
}

function ctx(overrides: Partial<SmaSegmentContext>): SmaSegmentContext {
  return {
    tradeRows: [],
    endDate: T1,
    finalEtfPrice: 100,
    annualizedInflation: INFLATION,
    riskOffLookups: [],
    ...overrides,
  };
}

// eventPrice values are anchored to end-of-window dollars, so a ratio of two
// eventPrices is already a REAL return — the metrics must not deflate it again.

test("risk-on real CAGR equals nominal CAGR deflated exactly once", () => {
  const nominalCagr = 0.10;
  const p0Anchored = 100 * Math.pow(1 + INFLATION, YEARS);
  const p1Anchored = 100 * Math.pow(1 + nominalCagr, YEARS); // at the anchor date, anchored = nominal
  const context = ctx({
    tradeRows: [
      row({ signalDate: T0, signalType: "buy", eventPrice: p0Anchored }),
      row({ signalDate: T1, signalType: "sell", eventPrice: p1Anchored }),
    ],
  });

  const expected = ((1 + nominalCagr) / (1 + INFLATION) - 1) * 100;
  const actual = getRiskOnRealCagr(context, 0);
  assert.notEqual(actual, null);
  assert.ok(Math.abs((actual as number) - expected) < 1e-6, `expected ~${expected}, got ${actual}`);
});

test("an asset that exactly tracks inflation has 0% risk-on real CAGR", () => {
  const p0Anchored = 100 * Math.pow(1 + INFLATION, YEARS);
  const p1Anchored = 100 * Math.pow(1 + INFLATION, YEARS); // nominal growth = inflation
  const context = ctx({
    tradeRows: [
      row({ signalDate: T0, signalType: "buy", eventPrice: p0Anchored }),
      row({ signalDate: T1, signalType: "sell", eventPrice: p1Anchored }),
    ],
  });

  const actual = getRiskOnRealCagr(context, 0);
  assert.notEqual(actual, null);
  assert.ok(Math.abs(actual as number) < 1e-6, `expected ~0, got ${actual}`);
});

test("final open segment falls back to endDate and finalEtfPrice", () => {
  const nominalCagr = 0.10;
  const p0Anchored = 100 * Math.pow(1 + INFLATION, YEARS);
  const finalEtfPrice = 100 * Math.pow(1 + nominalCagr, YEARS);
  const context = ctx({
    tradeRows: [row({ signalDate: T0, signalType: "buy", eventPrice: p0Anchored })],
    finalEtfPrice,
  });

  const expected = ((1 + nominalCagr) / (1 + INFLATION) - 1) * 100;
  const actual = getRiskOnRealCagr(context, 0);
  assert.notEqual(actual, null);
  assert.ok(Math.abs((actual as number) - expected) < 1e-6, `expected ~${expected}, got ${actual}`);
});

test("risk-off total real return deflates nominal risk-off prices exactly once", () => {
  // Risk-off asset grows exactly at inflation → 0% real.
  const lookup = new Map([
    [T0, 100],
    [T1, 100 * Math.pow(1 + INFLATION, YEARS)],
  ]);
  const context = ctx({
    tradeRows: [
      row({ signalDate: T0, signalType: "sell", eventPrice: 50 }),
      row({ signalDate: T1, signalType: "buy", eventPrice: 55 }),
    ],
    riskOffLookups: [lookup],
  });

  const actual = getRiskOffTotalRealReturn(context, 0);
  assert.notEqual(actual, null);
  assert.ok(Math.abs(actual as number) < 1e-6, `expected ~0, got ${actual}`);
  const cagr = getRiskOffRealCagr(context, 0);
  assert.ok(Math.abs(cagr as number) < 1e-6, `expected ~0, got ${cagr}`);
});

test("risk-off advantage compares real risk-off vs real hypothetical risk-on", () => {
  const nominalCagr = 0.10;
  // Risk-off tracks inflation → real ratio 1.
  const lookup = new Map([
    [T0, 100],
    [T1, 100 * Math.pow(1 + INFLATION, YEARS)],
  ]);
  // Hypothetical risk-on leg: ETF grows at 10% nominal.
  const sellAnchored = 50 * Math.pow(1 + INFLATION, YEARS);
  const buyAnchored = 50 * Math.pow(1 + nominalCagr, YEARS);
  const context = ctx({
    tradeRows: [
      row({ signalDate: T0, signalType: "sell", eventPrice: sellAnchored }),
      row({ signalDate: T1, signalType: "buy", eventPrice: buyAnchored }),
    ],
    riskOffLookups: [lookup],
  });

  // advantage = realRiskOffRatio / realRiskOnRatio = 1 / ((1.1 / 1.03) ^ years)
  const expected = 1 / Math.pow((1 + nominalCagr) / (1 + INFLATION), YEARS);
  const actual = getRiskOffAdvantage(context, 0);
  assert.notEqual(actual, null);
  assert.ok(Math.abs((actual as number) - expected) < 1e-6, `expected ~${expected}, got ${actual}`);
});

test("terminal and mismatched rows return null", () => {
  const context = ctx({
    tradeRows: [
      row({ signalDate: T0, signalType: "sell", eventPrice: 50, isEndLiquidation: true }),
      row({ signalDate: T0, signalType: "sell", eventPrice: 50 }),
    ],
    riskOffLookups: [new Map([[T0, 100], [T1, 103]])],
  });
  assert.equal(getRiskOnRealCagr(context, 0), null);
  assert.equal(getRiskOffAdvantage(context, 0), null);
  assert.equal(getDaysTillNextEvent(context, 0), null);
  // Row 1 is a sell → no risk-on CAGR for it
  assert.equal(getRiskOnRealCagr(context, 1), null);
});

test("days till next event spans to the next row or window end", () => {
  const context = ctx({
    tradeRows: [
      row({ signalDate: T0, signalType: "buy", eventPrice: 50 }),
      row({ signalDate: "2020-01-11", signalType: "sell", eventPrice: 50 }),
    ],
  });
  assert.equal(getDaysTillNextEvent(context, 0), 10);
  // Last row → to endDate (2022-01-01)
  const daysToEnd = Math.round((Date.UTC(2022, 0, 1) - Date.UTC(2020, 0, 11)) / 86400000);
  assert.equal(getDaysTillNextEvent(context, 1), daysToEnd);
});
