import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  simulateFuturesSmaStrategy,
  getQuarterlyFuturesRollTradingDay,
  DEFAULT_FUTURES_ROLL_CALENDAR_DAYS_BEFORE_EXPIRY,
  futuresFrontBackQtysFromLots,
  getFuturesHalfSpreadPerContract,
  buildInflationDollarCostScaleLookup,
  futuresCarryForCalendarDays,
} from "@/lib/simulation/futures";
import { riskOffCloseMarkPrice, riskOffOpenTradePrice } from "@/lib/simulation/risk-off";

type CsvRow = Record<string, string>;

function parseCsv(filename: string): CsvRow[] {
  const raw = readFileSync(join(process.cwd(), "data", filename), "utf-8").trim();
  const [headerLine, ...lines] = raw.split("\n");
  const headers = headerLine.split(",");
  return lines.map((line) => {
    const cols = line.split(",");
    const row: CsvRow = {};
    for (let i = 0; i < headers.length; i++) row[headers[i]] = cols[i] ?? "";
    return row;
  });
}

function alignRiskSeries(rows: CsvRow[], dates: string[], key: "adj_open" | "adj_close"): number[] {
  const m = new Map(rows.map((r) => [r.date, Number(r[key])]));
  const out: number[] = [];
  let last = NaN;
  for (const d of dates) {
    const v = m.get(d);
    if (Number.isFinite(v) && (v as number) > 0) last = v as number;
    out.push(last);
  }
  return out;
}

function runFuturesResult(
  index: "sp500" | "nasdaq100",
  leverage: 2 | 3 | 4,
  leverageTolerancePct?: number
) {
  const indexFile = index === "sp500" ? "index-sp.csv" : "index-nq.csv";
  const indexRows = parseCsv(indexFile);
  const rateRows = parseCsv("rate-borrow.csv");
  const sgovRows = parseCsv("risk-sgov.csv");

  const prices = indexRows.map((r) => {
    const close = Number(r.close);
    return {
      date: r.date,
      adj_close: Number(r.adj_close),
      close,
      adj_open: r.adj_open ? Number(r.adj_open) : undefined,
      open: r.open ? Number(r.open) : (Number.isFinite(close) ? close : undefined),
    };
  });

  const dates = prices.filter((p) => p.date >= "2003-10-10").map((p) => p.date);
  const riskCloseByTicker = { SGOV: alignRiskSeries(sgovRows, dates, "adj_close") };
  const riskOpenByTicker = { SGOV: alignRiskSeries(sgovRows, dates, "adj_open") };

  const rates = rateRows.map((r) => ({
    date: r.date,
    rateType: "borrow",
    rateValue: Number(r.value),
  }));

  return simulateFuturesSmaStrategy({
    index,
    prices,
    rates,
    startDate: "2003-10-10",
    endDate: prices[prices.length - 1]?.date,
    initialEquity: 30_000,
    targetLeverage: leverage,
    smaPeriod: 200,
    smaBuffer: 0,
    riskOffAsset: "SGOV",
    riskOffCloseByTicker: riskCloseByTicker,
    riskOffOpenByTicker: riskOpenByTicker,
    leverageTolerancePct,
  });

}

function runFutures(index: "sp500" | "nasdaq100", leverage: 2 | 3 | 4): number {
  const result = runFuturesResult(index, leverage);
  const dailyValues = result.etfResult.dailyValues as number[];
  const initial = dailyValues[0] ?? 0;
  const final = dailyValues[dailyValues.length - 1] ?? 0;
  return initial > 0 ? final / initial : 0;
}

test("futures sanity: multipliers are plausible and non-degenerate", () => {
  const sp2 = runFutures("sp500", 2);
  const sp3 = runFutures("sp500", 3);
  const sp4 = runFutures("sp500", 4);
  const nq2 = runFutures("nasdaq100", 2);
  const nq3 = runFutures("nasdaq100", 3);
  const nq4 = runFutures("nasdaq100", 4);

  for (const [label, mult] of [
    ["SPX 2x", sp2],
    ["SPX 3x", sp3],
    ["SPX 4x", sp4],
    ["NDQ 2x", nq2],
    ["NDQ 3x", nq3],
    ["NDQ 4x", nq4],
  ] as const) {
    assert.equal(Number.isFinite(mult), true, `${label} multiplier must be finite`);
    assert.equal(mult > 0.01, true, `${label} should not collapse to near-zero`);
    assert.equal(mult < 1_000_000, true, `${label} should not explode unrealistically`);
  }

  // Ensure leverage tiers are not accidentally identical due to sizing bugs.
  assert.equal(Math.abs(sp3 - sp2) > 0.01, true, "SPX 2x and 3x should differ");
  assert.equal(Math.abs(sp4 - sp3) > 0.01, true, "SPX 3x and 4x should differ");
  assert.equal(Math.abs(nq3 - nq2) > 0.01, true, "NDQ 2x and 3x should differ");
  assert.equal(Math.abs(nq4 - nq3) > 0.01, true, "NDQ 3x and 4x should differ");
});

test("futures sanity: per-contract spreads are half a tick per side", () => {
  assert.equal(getFuturesHalfSpreadPerContract("ESM06"), 6.25);
  assert.equal(getFuturesHalfSpreadPerContract("NQM06"), 2.5);
});

test("futures sanity: fixed-dollar fees scale down in historical dollars", () => {
  const scaleForDate = buildInflationDollarCostScaleLookup(
    [
      { date: "1980-01-01", value: 80 },
      { date: "2020-01-01", value: 260 },
    ],
    "2020-12-31"
  );
  assert.equal(scaleForDate("2020-05-01"), 1);
  assert.equal(scaleForDate("1980-05-01"), 80 / 260);
});

test("futures sanity: futures carry uses annualized rate/dividend over calendar days", () => {
  const carry = futuresCarryForCalendarDays({
    rateDaily: 0.036 / 360,
    dividendDaily: 0.012 / 252,
    calendarDays: 3,
  });
  assert.equal(Math.abs(carry - ((0.036 - 0.012) * 3 / 365.25)) < 1e-12, true);
});

test("risk-off shared pricing falls back across open, close, previous close, and last price", () => {
  assert.equal(
    riskOffOpenTradePrice({
      openValues: [10, NaN],
      closeValues: [9, 11],
      index: 1,
      lastPrice: 8,
    }),
    11
  );
  assert.equal(
    riskOffOpenTradePrice({
      openValues: [10, NaN],
      closeValues: [9, NaN],
      index: 1,
      lastPrice: 8,
    }),
    9
  );
  assert.equal(
    riskOffCloseMarkPrice({
      closeValues: [9, NaN],
      index: 1,
      lastPrice: 8,
    }),
    9
  );
});

test("futures sanity: risk-off basket sell falls back when one leg has missing open", () => {
  const prices = [
    { date: "2025-08-01", close: 100, open: 100, adj_close: 100 },
    { date: "2025-08-04", close: 80, open: 80, adj_close: 80 },
    { date: "2025-08-05", close: 120, open: 120, adj_close: 120 },
    { date: "2025-08-06", close: 130, open: 130, adj_close: 130 },
  ];
  const rates = prices.map((p) => ({ date: p.date, rateType: "borrow", rateValue: 0.04 }));
  const result = simulateFuturesSmaStrategy({
    index: "sp500",
    prices,
    rates,
    startDate: "2025-08-01",
    endDate: "2025-08-06",
    initialEquity: 100_000,
    targetLeverage: 3,
    smaPeriod: 2,
    smaBuffer: 0,
    riskOffAsset: "BRK.B+GLDM+VGSH",
    riskOffOpenByTicker: {
      "BRK.B": [500, 500, 500, 510],
      GLDM: [50, 50, 50, 51],
      VGSH: [58, 58, 58, NaN],
    },
    riskOffCloseByTicker: {
      "BRK.B": [500, 500, 505, 510],
      GLDM: [50, 50, 50.5, 51],
      VGSH: [58, 58, 58.5, 59],
    },
  });

  const riskOffSellSymbols = result.transactions
    .filter((row) => row.instrument === "riskoff" && row.action === "sell" && row.date === "2025-08-06")
    .map((row) => row.symbol)
    .sort();
  assert.deepEqual(riskOffSellSymbols, ["BRK.B", "GLDM", "VGSH"]);
});

test("futures sanity: explicit max leverage caps rounded-up contract sizing", () => {
  const prices = [
    { date: "2025-08-01", close: 1050, open: 1050, adj_close: 1050 },
    { date: "2025-08-04", close: 1050, open: 1050, adj_close: 1050 },
  ];
  const result = simulateFuturesSmaStrategy({
    index: "sp500",
    prices,
    rates: prices.map((p) => ({ date: p.date, rateType: "borrow", rateValue: 0 })),
    startDate: "2025-08-01",
    endDate: "2025-08-04",
    initialEquity: 100_000,
    targetLeverage: 4.5,
    maxLeverage: 4.5,
    smaPeriod: 185,
    smaBuffer: 0,
    riskOffAsset: "SGOV",
  });
  const firstBuy = result.transactions.find((row) => row.instrument === "futures" && row.action === "buy");
  assert.equal(firstBuy?.qtyAfter, 8);
});

test("futures sanity: explicit max leverage trims on open when breach is beyond tolerance headroom", () => {
  const prices = [
    { date: "2025-08-01", close: 1000, open: 1000, adj_close: 1000 },
    { date: "2025-08-04", close: 800, open: 1000, adj_close: 800 },
  ];
  const result = simulateFuturesSmaStrategy({
    index: "sp500",
    prices,
    rates: prices.map((p) => ({ date: p.date, rateType: "borrow", rateValue: 0 })),
    startDate: "2025-08-01",
    endDate: "2025-08-04",
    initialEquity: 100_000,
    targetLeverage: 4.5,
    maxLeverage: 4.5,
    leverageTolerancePct: 0,
    smaPeriod: 185,
    smaBuffer: 0,
    riskOffAsset: "SGOV",
  });
  const trims = result.transactions.filter((row) =>
    row.date === "2025-08-04" &&
    row.instrument === "futures" &&
    row.action === "sell" &&
    !row.isEndLiquidation
  );
  const trim = trims.at(-1);
  assert.ok(trim, "max leverage breach should force an open contract trim");
  assert.equal(Math.abs(trim.qtyDelta) > 0, true);
  assert.equal(trim.leverageDeltaPct <= 0, true);
});

test("futures sanity: enters risk-on on first day when invested", () => {
  const result = runFuturesResult("sp500", 3);
  const firstDate = result.etfResult.dates[0];
  const firstFuturesTrade = result.transactions.find((row) => row.instrument === "futures");
  assert.ok(firstDate, "result should have a first date");
  assert.ok(firstFuturesTrade, "result should contain at least one futures trade");
  assert.equal(firstFuturesTrade?.date, firstDate, "first futures trade should occur on first date");
  assert.equal((firstFuturesTrade?.qtyDelta ?? 0) > 0, true, "first futures trade quantity should be positive");
});

test("futures sanity: leverage tolerance suppresses routine rebalances", () => {
  const zeroTolerance = runFuturesResult("sp500", 3, 0);
  const wideTolerance = runFuturesResult("sp500", 3, 20);

  const countRoutineFuturesTrades = (result: ReturnType<typeof runFuturesResult>) =>
    result.transactions.filter((row) =>
      row.instrument === "futures" &&
      !row.symbol.includes("(ROLL)") &&
      row.qtyAfter !== 0
    ).length;

  assert.equal(
    countRoutineFuturesTrades(wideTolerance) < countRoutineFuturesTrades(zeroTolerance),
    true,
    "wider leverage tolerance should reduce routine futures rebalancing trades"
  );
});

test("futures sanity: rolls and routine sizing use basis-adjusted raw index open fills", () => {
  const indexRows = parseCsv("index-sp.csv");
  const openByDate = new Map(indexRows.map((row) => [row.date, Number(row.open)]));
  const result = runFuturesResult("sp500", 3, 0);
  const firstDate = result.etfResult.dates[0];

  const isQuarterlyCarrySell = (row: (typeof result.transactions)[number]) =>
    row.instrument === "futures" &&
    row.symbol.includes("(ROLL)") &&
    row.action === "sell" &&
    Number.isFinite(openByDate.get(row.date) ?? NaN);
  const rollSellIdx = result.transactions.findIndex(isQuarterlyCarrySell);
  const rollSell = rollSellIdx >= 0 ? result.transactions[rollSellIdx] : undefined;
  const rollBuy = rollSellIdx >= 0 ? result.transactions[rollSellIdx + 1] : undefined;
  const routine = result.transactions.find((row) =>
    row.instrument === "futures" &&
    !row.symbol.includes("(ROLL)") &&
    row.qtyAfter !== 0 &&
    row.date !== firstDate &&
    Number.isFinite(openByDate.get(row.date) ?? NaN)
  );

  assert.ok(rollSell, "result should include a futures (ROLL) carry sell with an available raw index open");
  assert.ok(rollBuy, "result should include a matching futures carry buy");
  assert.equal(rollBuy?.instrument, "futures");
  assert.equal(rollBuy?.action, "buy");
  assert.equal(rollBuy?.date, rollSell?.date);
  assert.ok(routine, "result should include a routine futures sizing trade with an available raw index open");

  const rollOpen = openByDate.get(rollSell.date) ?? NaN;
  const routineOpen = openByDate.get(routine.date) ?? NaN;
  assert.equal(Math.abs((rollSell.fillPrice / rollOpen) - 1) < 0.05, true);
  assert.equal(Math.abs(((rollBuy?.fillPrice ?? 0) / rollOpen) - 1) < 0.05, true);
  assert.equal(Math.abs((routine.fillPrice / routineOpen) - 1) < 0.05, true);
  assert.notEqual(rollSell.fillPrice, rollBuy?.fillPrice, "carry should show old/new contract basis spread");
});

test("futures sanity: front/deferred is earlier quarter vs later quarter when two NQ legs are held", () => {
  const lots = new Map<string, number>([
    ["NQZ07", 102],
    ["NQH08", 4],
  ]);
  const { frontQty, backQty } = futuresFrontBackQtysFromLots({
    index: "nasdaq100",
    tradeDate: "2007-12-07",
    rollDateByQuarter: new Map(),
    lots,
  });
  assert.equal(frontQty, 102);
  assert.equal(backQty, 4);

  const afterTrim = new Map<string, number>([
    ["NQZ07", 96],
    ["NQH08", 4],
  ]);
  const fb2 = futuresFrontBackQtysFromLots({
    index: "nasdaq100",
    tradeDate: "2007-12-17",
    rollDateByQuarter: new Map(),
    lots: afterTrim,
  });
  assert.equal(fb2.frontQty, 96);
  assert.equal(fb2.backQty, 4);

  const smallOldLargeNew = new Map<string, number>([
    ["NQZ07", 4],
    ["NQH08", 96],
  ]);
  const fb3 = futuresFrontBackQtysFromLots({
    index: "nasdaq100",
    tradeDate: "2007-12-17",
    rollDateByQuarter: new Map(),
    lots: smallOldLargeNew,
  });
  assert.equal(fb3.frontQty, 4, "earlier quarter (Z) stays front even if smaller");
  assert.equal(fb3.backQty, 96);
});

test("futures sanity: front/deferred single leg is all front", () => {
  const lots = new Map<string, number>([["NQZ07", 100]]);
  const { frontQty, backQty } = futuresFrontBackQtysFromLots({
    index: "nasdaq100",
    tradeDate: "2007-12-05",
    rollDateByQuarter: new Map(),
    lots,
  });
  assert.equal(frontQty, 100);
  assert.equal(backQty, 0);
});

test("futures sanity: roll snap is 4 calendar days before 3rd Friday, aligned to the index series", () => {
  const indexRows = parseCsv("index-sp.csv");
  const dates = indexRows.map((r) => r.date).filter((d) => d >= "2003-10-10");
  assert.equal(DEFAULT_FUTURES_ROLL_CALENDAR_DAYS_BEFORE_EXPIRY, 4);
  assert.equal(
    getQuarterlyFuturesRollTradingDay("ESU09", "2009-09-01", dates, 4),
    "2009-09-14"
  );
  assert.equal(
    getQuarterlyFuturesRollTradingDay("ESM06", "2006-06-01", dates, 4),
    "2006-06-12"
  );
});

test("futures sanity: e-mini mode trades futures for accounts that can support one contract", () => {
  const indexRows = parseCsv("index-sp.csv");
  const rateRows = parseCsv("rate-borrow.csv");
  const sgovRows = parseCsv("risk-sgov.csv");

  const prices = indexRows.map((r) => {
    const close = Number(r.close);
    return {
      date: r.date,
      adj_close: Number(r.adj_close),
      close,
      adj_open: r.adj_open ? Number(r.adj_open) : undefined,
      open: r.open ? Number(r.open) : (Number.isFinite(close) ? close : undefined),
    };
  });
  const dates = prices.filter((p) => p.date >= "2005-10-10" && p.date <= "2026-05-01").map((p) => p.date);
  const riskCloseByTicker = { SGOV: alignRiskSeries(sgovRows, dates, "adj_close") };
  const riskOpenByTicker = { SGOV: alignRiskSeries(sgovRows, dates, "adj_open") };
  const rates = rateRows.map((r) => ({ date: r.date, rateType: "borrow", rateValue: Number(r.value) }));

  const result = simulateFuturesSmaStrategy({
    index: "sp500",
    prices,
    rates,
    startDate: "2005-10-10",
    endDate: "2026-05-01",
    initialEquity: 60_000,
    targetLeverage: 3,
    smaPeriod: 185,
    smaBuffer: 0.036,
    riskOffAsset: "SGOV",
    riskOffCloseByTicker: riskCloseByTicker,
    riskOffOpenByTicker: riskOpenByTicker,
  });

  const hasFuturesTrade = result.transactions.some((row) => row.instrument === "futures");
  assert.equal(hasFuturesTrade, true, "e-mini mode should produce futures trades when one contract is within range");
});
