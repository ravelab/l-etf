import test from "node:test";
import assert from "node:assert/strict";
import {
  describeSmaSignalChange,
  describeSmaSignalConfig,
  describeSmaSignalStatus,
  buildSmaSignalFingerprint,
  getDefaultSmaSignalConfig,
  computeSmaSignalSnapshot,
  type SmaSignalSnapshot,
} from "../src/lib/sma-status";
import type { DailyPrice } from "../src/lib/data/storage";

function prices(n: number, start = 100): DailyPrice[] {
  const out: DailyPrice[] = [];
  let px = start;
  for (let i = 0; i < n; i++) {
    px *= 1.001;
    const d = new Date(Date.UTC(2024, 0, 2 + i));
    out.push({
      date: d.toISOString().slice(0, 10),
      open: px,
      close: px,
      adj_close: px,
      name: "test",
      source: "test",
    });
  }
  return out;
}

function snap(overrides?: Partial<SmaSignalSnapshot>): SmaSignalSnapshot {
  return {
    sp500: {
      signal: "buy",
      signalLabel: "Buy L-ETFs",
      percentDiff: 2.5,
      smaValue: 100,
      indexValue: 102.5,
      indexDate: "2024-06-01",
      signalEmoji: "",
    },
    nasdaq100: {
      signal: "sell",
      signalLabel: "Sell L-ETFs",
      percentDiff: -3.25,
      smaValue: 100,
      indexValue: 96.75,
      indexDate: "2024-06-01",
      signalEmoji: "",
    },
    timestamp: "2024-06-01T20:00:00.000Z",
    ...overrides,
  };
}

test("describeSmaSignalStatus formats both indexes", () => {
  const text = describeSmaSignalStatus(snap());
  assert.match(text, /SPX: Buy L-ETFs \(\+2\.50%\)/);
  assert.match(text, /NDX: Sell L-ETFs \(-3\.25%\)/);
});

test("describeSmaSignalStatus respects disabled indexes", () => {
  const config = { ...getDefaultSmaSignalConfig(), smaSpEnabled: false, smaNqEnabled: true };
  const text = describeSmaSignalStatus(snap(), config);
  assert.equal(text.includes("SPX"), false);
  assert.match(text, /NDX:/);
});

test("describeSmaSignalConfig collapses whole-number buffers", () => {
  const config = {
    ...getDefaultSmaSignalConfig(),
    smaSpPeriod: 200,
    smaSpUpperBuffer: 3,
    smaSpLowerBuffer: 3,
    smaNqEnabled: false,
  };
  assert.equal(describeSmaSignalConfig(config), "SPX 200 SMA, −3%/3%");
});

test("buildSmaSignalFingerprint ignores disabled indexes", () => {
  const both = buildSmaSignalFingerprint(snap());
  const spOnly = buildSmaSignalFingerprint(snap(), {
    ...getDefaultSmaSignalConfig(),
    smaNqEnabled: false,
  });
  assert.equal(both, "risk-on|risk-off");
  assert.equal(spOnly, "risk-on|disabled");
});

test("describeSmaSignalChange reports a regime switch", () => {
  const previous = snap({
    sp500: { ...snap().sp500, signal: "sell", signalLabel: "Sell L-ETFs", percentDiff: -1 },
  });
  const current = snap();
  const text = describeSmaSignalChange(current, previous);
  assert.match(text, /SPX switched to Buy L-ETFs/);
  assert.match(text, /Current:/);
});

test("computeSmaSignalSnapshot returns both index signals", () => {
  const series = prices(260);
  const snapshot = computeSmaSignalSnapshot({
    sp500Prices: series,
    nasdaqPrices: series,
    config: getDefaultSmaSignalConfig(),
    timestamp: "2024-06-01T00:00:00.000Z",
  });
  assert.equal(snapshot.timestamp, "2024-06-01T00:00:00.000Z");
  assert.ok(Number.isFinite(snapshot.sp500.percentDiff));
  assert.ok(Number.isFinite(snapshot.nasdaq100.percentDiff));
});

test("describeSmaSignalConfig returns None when both indexes are disabled", () => {
  const config = {
    ...getDefaultSmaSignalConfig(),
    smaSpEnabled: false,
    smaNqEnabled: false,
  };
  assert.equal(describeSmaSignalConfig(config), "None");
});

test("describeSmaSignalStatus returns No alerts enabled when both indexes are disabled", () => {
  const config = {
    ...getDefaultSmaSignalConfig(),
    smaSpEnabled: false,
    smaNqEnabled: false,
  };
  assert.equal(describeSmaSignalStatus(snap(), config), "No alerts enabled");
});

test("describeSmaSignalChange falls back to current status when regimes are unchanged", () => {
  const current = snap();
  const text = describeSmaSignalChange(current, current);
  assert.equal(text, describeSmaSignalStatus(current));
});

test("describeSmaSignalChange without previous uses current status", () => {
  const current = snap();
  assert.equal(describeSmaSignalChange(current), describeSmaSignalStatus(current));
});

test("describeSmaSignalStatus maps Buy/Sell labels to L-ETF wording", () => {
  const snapshot = snap({
    sp500: {
      ...snap().sp500,
      signalLabel: "Buy",
      percentDiff: 1,
    },
    nasdaq100: {
      ...snap().nasdaq100,
      signalLabel: "Sell",
      percentDiff: -2,
    },
  });
  const text = describeSmaSignalStatus(snapshot);
  assert.match(text, /SPX: Buy L-ETFs \(\+1\.00%\)/);
  assert.match(text, /NDX: Sell L-ETFs \(-2\.00%\)/);
});
