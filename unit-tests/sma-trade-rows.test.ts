import test from "node:test";
import assert from "node:assert/strict";
import { buildSmaTradeRows } from "../src/lib/sma-trade-rows";
import type { SmaSignal } from "../src/lib/simulation/types";

const DATES = [
  "2020-01-01",
  "2020-01-02",
  "2020-01-03",
  "2020-01-06",
  "2020-01-07",
  "2020-01-08",
  "2020-01-09",
  "2020-01-10",
];

function makeParams(overrides?: {
  smaSignals?: SmaSignal[];
  smaStartInvested?: boolean | undefined;
  smaExecutionMode?: "trigger-day-close" | "next-day-close" | "next-day-open";
}) {
  const closePrices = [100, 101, 102, 90, 89, 88, 95, 96];
  return {
    etf: {
      smaSignals: overrides?.smaSignals ?? [],
      smaPrices: closePrices.map((p) => p * 0.98),
      smaStartInvested: overrides?.smaStartInvested,
    },
    config: {
      name: "UPRO",
      riskOffAsset: "BRK.B+GLDM+VGSH" as const,
      smaExecutionMode: overrides?.smaExecutionMode ?? ("trigger-day-close" as const),
    },
    etfDates: DATES,
    closePrices,
    openPrices: closePrices.map((p) => p - 0.5),
    tradeClosePrices: [50, 51, 52, 40, 39, 38, 46, 47],
    tradeOpenPrices: [49, 50, 51, 39, 38, 37, 45, 46],
    syntheticPriceScale: 1,
    annualizedInflation: 0,
  };
}

test("prepends an initial Buy row on the window start date for a risk-on start", () => {
  const rows = buildSmaTradeRows(
    makeParams({
      smaStartInvested: true,
      smaSignals: [
        { date: "2020-01-06", type: "sell", price: 90 },
        { date: "2020-01-09", type: "buy", price: 95 },
      ],
    })
  );

  assert.equal(rows.length, 4);
  const initial = rows[0];
  assert.equal(initial.isInitialEntry, true);
  assert.equal(initial.signalDate, "2020-01-01");
  assert.equal(initial.tradingDay, "2020-01-01");
  assert.equal(initial.signalType, "buy");
  assert.match(initial.action, /^Buy UPRO/);
  // ETF entry price at the window start (inflation 0 → unanchored)
  assert.equal(initial.eventPrice, 50);
  assert.equal(rows[1].signalDate, "2020-01-06");
  assert.equal(rows[2].signalDate, "2020-01-09");
  assert.equal(rows[3].isEndLiquidation, true);
});

test("initial row reflects a risk-off start carried in from warm-up", () => {
  const rows = buildSmaTradeRows(
    makeParams({
      smaStartInvested: false,
      smaSignals: [{ date: "2020-01-09", type: "buy", price: 95 }],
    })
  );

  assert.equal(rows.length, 3);
  const initial = rows[0];
  assert.equal(initial.isInitialEntry, true);
  assert.equal(initial.signalType, "sell");
  // Buys the risk-off basket, abbreviated
  assert.match(initial.action, /^Buy B\+G\+V/);
  // Hypothetical ETF price at start still provided for the risk-off comparison columns
  assert.equal(initial.eventPrice, 50);
  // Ends risk-on after the 01-09 buy → terminal row liquidates the ETF
  const terminal = rows[2];
  assert.equal(terminal.isEndLiquidation, true);
  assert.match(terminal.action, /^LIQUIDATE UPRO/);
});

test("windows with zero crossings still show entry and liquidation rows", () => {
  const rows = buildSmaTradeRows(makeParams({ smaStartInvested: true, smaSignals: [] }));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].isInitialEntry, true);
  assert.equal(rows[0].signalType, "buy");
  assert.equal(rows[1].isEndLiquidation, true);
  assert.match(rows[1].action, /^LIQUIDATE UPRO/);
});

test("falls back to inferring the start regime from the first in-window signal", () => {
  // First signal is a buy → the window must have started risk-off.
  const rows = buildSmaTradeRows(
    makeParams({
      smaStartInvested: undefined,
      smaSignals: [{ date: "2020-01-09", type: "buy", price: 95 }],
    })
  );
  assert.equal(rows[0].isInitialEntry, true);
  assert.equal(rows[0].signalType, "sell");

  // First signal is a sell → the window started risk-on.
  const rows2 = buildSmaTradeRows(
    makeParams({
      smaStartInvested: undefined,
      smaSignals: [{ date: "2020-01-06", type: "sell", price: 90 }],
    })
  );
  assert.equal(rows2[0].signalType, "buy");
});

test("next-day-open execution keeps the initial row and hides an unexecuted last-day signal", () => {
  const rows = buildSmaTradeRows(
    makeParams({
      smaStartInvested: true,
      smaExecutionMode: "next-day-open",
      smaSignals: [
        { date: "2020-01-06", type: "sell", price: 90 },
        { date: "2020-01-10", type: "buy", price: 96 }, // last day → execution hasn't happened
      ],
    })
  );

  // initial + executed sell + terminal (last-day buy hidden)
  assert.equal(rows.length, 3);
  assert.equal(rows[0].isInitialEntry, true);
  assert.equal(rows[0].tradingDay, "2020-01-01");
  assert.equal(rows[1].signalDate, "2020-01-06");
  assert.equal(rows[1].tradingDay, "2020-01-07");
  assert.equal(rows[2].isEndLiquidation, true);
});

test("degenerate windows (fewer than two days) produce no rows", () => {
  const params = makeParams({ smaStartInvested: true });
  const rows = buildSmaTradeRows({
    ...params,
    etfDates: ["2020-01-01"],
    closePrices: [100],
    openPrices: [99.5],
    tradeClosePrices: [50],
    tradeOpenPrices: [49],
  });
  assert.deepEqual(rows, []);
});
