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
  futuresCarryForHoldingPeriod,
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
    smaUpperBuffer: 0, smaLowerBuffer: 0,
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
    ["NDX 2x", nq2],
    ["NDX 3x", nq3],
    ["NDX 4x", nq4],
  ] as const) {
    assert.equal(Number.isFinite(mult), true, `${label} multiplier must be finite`);
    assert.equal(mult > 0.01, true, `${label} should not collapse to near-zero`);
    assert.equal(mult < 1_000_000, true, `${label} should not explode unrealistically`);
  }

  // Ensure leverage tiers are not accidentally identical due to sizing bugs.
  assert.equal(Math.abs(sp3 - sp2) > 0.01, true, "SPX 2x and 3x should differ");
  assert.equal(Math.abs(sp4 - sp3) > 0.01, true, "SPX 3x and 4x should differ");
  assert.equal(Math.abs(nq3 - nq2) > 0.01, true, "NDX 2x and 3x should differ");
  assert.equal(Math.abs(nq4 - nq3) > 0.01, true, "NDX 3x and 4x should differ");
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

test("futures sanity: a window ending before the fee-schedule anchor still deflates from it", () => {
  // The engine only ever receives CPI up to the simulation's end date, so a run ending in
  // 1980 has no anchor-year row. Falling back to the series' own tail would charge the
  // present-day commission schedule in 1980 dollars.
  const rows = [
    { date: "1970-01-01", value: 38 },
    { date: "1980-01-01", value: 82 },
  ];
  const scaleForDate = buildInflationDollarCostScaleLookup(rows, "2026-07-01", 332.813);
  assert.equal(scaleForDate("1980-05-01"), 82 / 332.813);
  assert.equal(scaleForDate("1970-05-01"), 38 / 332.813);

  // A series that does reach the anchor uses its own reading, not the fallback.
  const reaching = buildInflationDollarCostScaleLookup(
    [...rows, { date: "2026-07-01", value: 330 }],
    "2026-07-01",
    332.813
  );
  assert.equal(reaching("1980-05-01"), 82 / 330);
  assert.equal(reaching("2026-08-01"), 1);
});

test("futures sanity: carry accrues rate per calendar day and nets the realized dividend once", () => {
  const carry = futuresCarryForHoldingPeriod({
    rateDaily: 0.036 / 360,
    dividendForPeriod: 0.0004,
    calendarDays: 3,
  });
  assert.equal(Math.abs(carry - ((0.036 * 3) / 365.25 - 0.0004)) < 1e-12, true);

  // A held position earns exactly the index total return minus financing:
  // priceReturn - (rate - dividend) === totalReturn - rate.
  const priceReturn = -0.031;
  const totalReturn = -0.002;
  const oneDay = futuresCarryForHoldingPeriod({
    rateDaily: 0.036 / 360,
    dividendForPeriod: totalReturn - priceReturn,
    calendarDays: 1,
  });
  assert.equal(Math.abs((priceReturn - oneDay) - (totalReturn - 0.036 / 365.25)) < 1e-12, true);
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
    smaUpperBuffer: 0, smaLowerBuffer: 0,
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
    smaUpperBuffer: 0, smaLowerBuffer: 0,
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
    smaUpperBuffer: 0, smaLowerBuffer: 0,
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
    smaUpperBuffer: 0.036, smaLowerBuffer: 0.036,
    riskOffAsset: "SGOV",
    riskOffCloseByTicker: riskCloseByTicker,
    riskOffOpenByTicker: riskOpenByTicker,
  });

  const hasFuturesTrade = result.transactions.some((row) => row.instrument === "futures");
  assert.equal(hasFuturesTrade, true, "e-mini mode should produce futures trades when one contract is within range");
});

/** Weekday ISO dates starting at `from`, skipping Sat/Sun. */
function weekdayDates(from: string, count: number): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T00:00:00Z`);
  while (out.length < count) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

test("futures sanity: a held position tracks total return, not a disagreeing price column", () => {
  // Spliced history (index-sp.csv before 1988) carries `adj_close` from one source
  // and `close` from another, so on some days the two disagree by ~3%. The position
  // must follow the total-return path both engines compound, not the price glitch.
  const dates = weekdayDates("2024-01-02", 30);
  const glitchIdx = 15;
  const prices = dates.map((date, i) => {
    const adjClose = 4000 * Math.pow(1.0003, i);
    // `close` normally tracks adj_close; on one day it prints 3% low and recovers.
    const priceRatio = i === glitchIdx ? 0.97 : 1;
    return { date, adj_close: adjClose, close: adjClose * priceRatio, open: adjClose * priceRatio };
  });
  const rates = dates.map((date) => ({ date, rateType: "borrow", rateValue: 0 }));

  const result = simulateFuturesSmaStrategy({
    index: "sp500",
    prices,
    rates,
    startDate: dates[0],
    endDate: dates[dates.length - 1],
    initialEquity: 5_000_000,
    targetLeverage: 3,
    smaPeriod: 3,
    // Wide bands: this test is about carry, so the regime must never flip.
    smaUpperBuffer: 90,
    smaLowerBuffer: 90,
    riskOffAsset: "SGOV",
    leverageTolerancePct: 1000, // no rebalancing after the initial open
    feePerContract: 0,
  });

  const values = result.etfResult.dailyValues;
  assert.equal(result.etfResult.smaSignals.length, 0, "regime must stay risk-on");

  const glitchReturn = values[glitchIdx] / values[glitchIdx - 1] - 1;
  const totalReturn = prices[glitchIdx].adj_close / prices[glitchIdx - 1].adj_close - 1;
  const priceReturn = prices[glitchIdx].close / prices[glitchIdx - 1].close - 1;
  const leverage = result.avgActualLeverageRiskOn;

  assert.equal(
    Math.abs(glitchReturn - leverage * totalReturn) < 5e-4,
    true,
    `glitch-day return ${glitchReturn} should be ~${leverage * totalReturn} (leveraged total return)`
  );
  assert.equal(
    Math.abs(glitchReturn - leverage * priceReturn) > 0.05,
    true,
    "glitch-day return must not follow the leveraged price-column move"
  );
});

test("futures sanity: sweep interest accrues into equity daily instead of stepping at month start", () => {
  // Interest posts to cash monthly, but the equity curve must not jump a month's
  // worth of interest on the first session of each month.
  const dates = weekdayDates("2024-01-02", 60);
  const prices = dates.map((date) => ({ date, adj_close: 4000, close: 4000, open: 4000 }));
  const rates = dates.map((date) => ({ date, rateType: "borrow", rateValue: 0.05 }));

  const result = simulateFuturesSmaStrategy({
    index: "sp500",
    prices,
    rates,
    startDate: dates[0],
    endDate: dates[dates.length - 1],
    initialEquity: 5_000_000,
    targetLeverage: 3,
    smaPeriod: 3,
    smaUpperBuffer: 90,
    smaLowerBuffer: 90,
    riskOffAsset: "SGOV",
    leverageTolerancePct: 1000,
    feePerContract: 0,
  });

  const values = result.etfResult.dailyValues;
  const monthStarts = dates
    .map((date, i) => ({ date, i }))
    .filter(({ date, i }) => i > 0 && date.slice(0, 7) !== dates[i - 1].slice(0, 7));
  assert.equal(monthStarts.length >= 2, true, "window must cross at least two month boundaries");

  // Flat index at a positive rate: carry on 3x notional always outruns the sweep,
  // so every session must lose ground. A posted-in-one-lump month of interest
  // would show up as a single positive day.
  for (let i = 1; i < values.length; i++) {
    assert.equal(
      values[i] < values[i - 1],
      true,
      `equity should drift down every session; ${dates[i]} rose from ${values[i - 1]} to ${values[i]}`
    );
  }
});

test("futures sanity: the first bar's open cannot move the result in either regime", () => {
  // Day 0 is the initial investment, not a signal execution, so it establishes at
  // the first close - the same bar `dailyEquity[0]` marks, and the convention
  // `simulateSingleEtf` uses. Sizing off the open instead would either pocket the
  // first bar's intraday move (risk-off start, which marked to close) or buy a
  // stale quantity and drop it (risk-on start), depending on the opening regime.
  const dates = weekdayDates("2024-01-02", 70);
  const windowStartIdx = 40;

  // `direction` sets the trend, which decides the regime the window opens in.
  const run = (direction: 1 | -1, dayZeroOpenFactor: number) => {
    const prices = dates.map((date, i) => {
      const adjClose = 4000 * Math.pow(1 + direction * 0.004, i);
      const isWindowStart = i === windowStartIdx;
      return {
        date,
        adj_close: adjClose,
        close: adjClose,
        open: isWindowStart ? adjClose * dayZeroOpenFactor : adjClose,
      };
    });
    const riskOffClose = prices.map((p) => p.adj_close / 100);
    const riskOffOpen = prices.map((p, i) =>
      i === windowStartIdx ? (p.adj_close / 100) * dayZeroOpenFactor : p.adj_close / 100
    );
    return simulateFuturesSmaStrategy({
      index: "sp500",
      prices,
      rates: dates.map((date) => ({ date, rateType: "borrow", rateValue: 0.04 })),
      startDate: dates[windowStartIdx],
      endDate: dates[dates.length - 1],
      initialEquity: 5_000_000,
      targetLeverage: 3,
      smaPeriod: 5,
      smaUpperBuffer: 0,
      smaLowerBuffer: 0,
      riskOffAsset: "SGOV",
      riskOffCloseByTicker: { SGOV: riskOffClose.slice(windowStartIdx) },
      riskOffOpenByTicker: { SGOV: riskOffOpen.slice(windowStartIdx) },
      feePerContract: 0,
    });
  };

  const rising = run(1, 1);
  const falling = run(-1, 1);
  assert.equal(rising.riskOffSessionDayCount, 0, "rising series must open risk-on");
  assert.equal(
    falling.riskOffSessionDayCount,
    falling.sessionDayCount,
    "falling series must open risk-off and stay there"
  );

  // A first bar that opens 5% away from its close must not change anything.
  for (const [label, direction] of [["risk-on start", 1], ["risk-off start", -1]] as const) {
    const flat = run(direction, 1).etfResult;
    const gapped = run(direction, 0.95).etfResult;
    assert.equal(
      Math.abs(gapped.dailyValues[0] / flat.dailyValues[0] - 1) < 1e-12,
      true,
      `${label}: day-0 value moved with the first open (${flat.dailyValues[0]} vs ${gapped.dailyValues[0]})`
    );
    assert.equal(
      Math.abs(gapped.finalValue / flat.finalValue - 1) < 1e-12,
      true,
      `${label}: final value moved with the first open (${flat.finalValue} vs ${gapped.finalValue})`
    );
  }
});

test("futures sanity: margin requirement constrains capacity but not sweep interest", () => {
  // Futures margin is a requirement, not a payment: collateral held against an
  // open position stays in the cash balance and keeps earning. Raising the
  // maintenance rate must move excess liquidity without moving interest.
  const dates = weekdayDates("2024-01-02", 70);
  const prices = dates.map((date) => ({ date, adj_close: 4000, close: 4000, open: 4000 }));
  const rates = dates.map((date) => ({ date, rateType: "borrow", rateValue: 0.06 }));

  const run = (maintenanceMarginRate: number) =>
    simulateFuturesSmaStrategy({
      index: "sp500",
      prices,
      rates,
      startDate: dates[0],
      endDate: dates[dates.length - 1],
      initialEquity: 5_000_000,
      targetLeverage: 2,
      smaPeriod: 3,
      smaUpperBuffer: 90,
      smaLowerBuffer: 90,
      riskOffAsset: "SGOV",
      leverageTolerancePct: 1000,
      feePerContract: 0,
      maintenanceMarginRate,
    });

  const lowMargin = run(0.02);
  const highMargin = run(0.1);
  const interest = (r: ReturnType<typeof run>) =>
    r.transactions.reduce((sum, t) => sum + t.cashInterestEarned, 0);

  assert.equal(
    lowMargin.transactions[0].qtyAfter,
    highMargin.transactions[0].qtyAfter,
    "neither margin rate should bind capacity at 2x"
  );
  assert.equal(interest(lowMargin) > 0, true, "sweep must actually earn something");
  assert.equal(
    Math.abs(interest(highMargin) / interest(lowMargin) - 1) < 1e-9,
    true,
    `margin rate changed interest earned (${interest(lowMargin)} vs ${interest(highMargin)})`
  );
  // The requirement itself must still show up where it belongs.
  assert.equal(
    highMargin.transactions[0].excessLiquidity < lowMargin.transactions[0].excessLiquidity,
    true,
    "higher maintenance rate must reduce reported excess liquidity"
  );
});

test("futures sanity: the funding spread costs leverage x spread per year", () => {
  // ES/NQ roll rich, so financing embedded in the contract sits above the
  // risk-free rate. It is charged on notional, so unlike the cash-sweep haircut
  // (which touches 1x collateral) the cost scales with the leverage rung.
  const spread = 0.0035;
  const carryFair = futuresCarryForHoldingPeriod({
    rateDaily: 0.04 / 360,
    dividendForPeriod: 0,
    calendarDays: 365.25,
  });
  const carryRich = futuresCarryForHoldingPeriod({
    rateDaily: 0.04 / 360,
    fundingSpreadAnnual: spread,
    dividendForPeriod: 0,
    calendarDays: 365.25,
  });
  assert.equal(Math.abs((carryRich - carryFair) - spread) < 1e-12, true);

  // End to end on a flat index: the drag must land near leverage x spread x years.
  const dates = weekdayDates("2024-01-02", 250);
  const prices = dates.map((date) => ({ date, adj_close: 4000, close: 4000, open: 4000 }));
  const rates = dates.map((date) => ({ date, rateType: "borrow", rateValue: 0.04 }));
  const run = (futuresFundingSpreadAnnual: number) =>
    simulateFuturesSmaStrategy({
      index: "sp500",
      prices,
      rates,
      startDate: dates[0],
      endDate: dates[dates.length - 1],
      initialEquity: 5_000_000,
      targetLeverage: 3,
      smaPeriod: 3,
      smaUpperBuffer: 90,
      smaLowerBuffer: 90,
      riskOffAsset: "SGOV",
      leverageTolerancePct: 1000,
      feePerContract: 0,
      futuresFundingSpreadAnnual,
    });

  const fair = run(0);
  const rich = run(spread);
  const years =
    (new Date(`${dates[dates.length - 1]}T00:00:00Z`).getTime() -
      new Date(`${dates[0]}T00:00:00Z`).getTime()) /
    (365.25 * 86_400_000);
  const drag = Math.log(fair.etfResult.finalValue / rich.etfResult.finalValue) / years;
  // Whole contracts held against shrinking equity drift the realized rung above
  // the 3x target, so compare against what was actually carried.
  const realizedLeverage = fair.avgActualLeverageRiskOn;
  assert.equal(realizedLeverage > 3, true, "flat index at a positive rate must drift leverage up");
  assert.equal(
    Math.abs(drag - realizedLeverage * spread) < 1e-3,
    true,
    `drag ${drag} should be near ${realizedLeverage * spread} (realized leverage x spread)`
  );
});
