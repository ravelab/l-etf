import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  futuresFrontBackQtysFromLots,
  getFuturesHalfSpreadPerContract,
  simulateFuturesSmaStrategy,
  type FuturesStrategyResult,
} from "@/lib/simulation/futures";

type CsvRow = Record<string, string>;

function parseCsv(filename: string): CsvRow[] {
  const [headerLine, ...lines] = readFileSync(join(process.cwd(), "data", filename), "utf-8").trim().split("\n");
  const headers = headerLine.split(",");
  return lines.map((line) => {
    const cols = line.split(",");
    return Object.fromEntries(headers.map((h, i) => [h, cols[i] ?? ""]));
  });
}

function alignRisk(rows: CsvRow[], dates: string[], key: "adj_open" | "adj_close"): number[] {
  const byDate = new Map(rows.map((r) => [r.date, Number(r[key])]));
  let last = Number.NaN;
  return dates.map((d) => {
    const v = byDate.get(d);
    if (v !== undefined && Number.isFinite(v) && v > 0) last = v;
    return last;
  });
}

const START = "2010-01-04";

function run(microFutures: boolean | undefined, initialEquity = 100_000, endDate?: string): FuturesStrategyResult {
  const prices = parseCsv("index-sp.csv").map((r) => {
    const close = Number(r.close);
    return {
      date: r.date,
      adj_close: Number(r.adj_close),
      close,
      adj_open: r.adj_open ? Number(r.adj_open) : undefined,
      open: r.open ? Number(r.open) : close,
    };
  });
  const dates = prices.filter((p) => p.date >= START).map((p) => p.date);
  const sgov = parseCsv("risk-sgov.csv");
  return simulateFuturesSmaStrategy({
    index: "sp500",
    prices,
    rates: parseCsv("rate-borrow.csv").map((r) => ({ date: r.date, rateType: "borrow", rateValue: Number(r.value) })),
    startDate: START,
    endDate: endDate ?? prices[prices.length - 1].date,
    initialEquity,
    targetLeverage: 4.5,
    smaPeriod: 178,
    smaUpperBuffer: 3.4,
    smaLowerBuffer: 5.5,
    riskOffAsset: "SGOV",
    riskOffCloseByTicker: { SGOV: alignRisk(sgov, dates, "adj_close") },
    riskOffOpenByTicker: { SGOV: alignRisk(sgov, dates, "adj_open") },
    leverageTolerancePct: 9,
    ...(microFutures === undefined ? {} : { microFutures }),
  });
}

const futuresRows = (result: FuturesStrategyResult) =>
  result.transactions.filter((row) => row.instrument === "futures" && !row.isEndLiquidation);
const isMicro = (symbol: string) => /^M(ES|NQ)[HMUZ]\d{2}/.test(symbol);

const off = run(undefined);
const on = run(true);

test("micro futures off is identical to the full-size engine", () => {
  const explicitOff = run(false);
  assert.deepEqual(explicitOff.etfResult.dailyValues, off.etfResult.dailyValues);
  assert.equal(explicitOff.transactions.length, off.transactions.length);
  assert.ok(futuresRows(off).every((row) => !isMicro(row.symbol)));
});

test("with micros a $100k sleeve holds MES beside ES and tracks 4.5x more closely", () => {
  const rows = futuresRows(on);
  assert.ok(rows.some((row) => isMicro(row.symbol)), "some MES traded");
  assert.ok(rows.some((row) => /^ES[HMUZ]\d{2}/.test(row.symbol)), "some ES traded");
  for (const row of rows) assert.ok(Number.isInteger(row.qtyDelta), `${row.symbol} ${row.qtyDelta} is whole contracts`);
  // While the account is small (2010-11), whole ES alone sit well off 4.5x.
  const gap = (r: FuturesStrategyResult) => Math.abs(r.avgActualLeverageRiskOn - 4.5);
  const smallOn = run(true, 100_000, "2011-12-30");
  const smallOff = run(undefined, 100_000, "2011-12-30");
  assert.ok(gap(smallOn) < gap(smallOff), `micro gap ${gap(smallOn)} vs full ${gap(smallOff)}`);
});

test("a day never trades one size against the other", () => {
  const byDate = new Map<string, Set<string>>();
  for (const row of futuresRows(on)) {
    if (/\((ROLL|LIQUIDATE)\)/.test(row.symbol)) continue;
    const actions = byDate.get(row.date) ?? new Set<string>();
    actions.add(row.action);
    byDate.set(row.date, actions);
  }
  for (const [date, actions] of byDate) assert.ok(actions.size === 1, `${date} both buys and sells`);
});

test("reductions sell the micros before any full contract", () => {
  const sellsByDate = new Map<string, string[]>();
  for (const row of futuresRows(on)) {
    if (row.action !== "sell" || /\(ROLL\)/.test(row.symbol)) continue;
    sellsByDate.set(row.date, [...(sellsByDate.get(row.date) ?? []), row.symbol]);
  }
  for (const [date, symbols] of sellsByDate) {
    const firstFull = symbols.findIndex((s) => !isMicro(s));
    const lastMicro = symbols.map(isMicro).lastIndexOf(true);
    assert.ok(firstFull === -1 || lastMicro === -1 || lastMicro < firstFull, `${date}: ${symbols.join(", ")}`);
  }
});

test("micro listings carry their own half tick and count a tenth in front/back totals", () => {
  assert.equal(getFuturesHalfSpreadPerContract("MESM06"), 0.625);
  assert.equal(getFuturesHalfSpreadPerContract("MNQM06"), 0.25);
  const totals = futuresFrontBackQtysFromLots({
    index: "sp500",
    tradeDate: "2026-11-13",
    rollDateByQuarter: new Map(),
    lots: new Map([["ESZ26", 7], ["MESZ26", 5]]),
  });
  assert.equal(totals.frontQty + totals.backQty, 7.5);
});

test("micros are bought only while one ES is a bigger step than the 9% band", () => {
  for (const row of futuresRows(on)) {
    if (row.action !== "buy" || !isMicro(row.symbol) || /\(ROLL\)/.test(row.symbol)) continue;
    const esNotional = 50 * row.fillPrice;
    assert.ok(esNotional > 4.5 * row.equity * 0.09 * 0.98, `${row.date}: MES bought though one ES fits the band`);
  }
});

test("a sleeve too large for micros to matter never holds one", () => {
  const big = run(true, 10_000_000);
  assert.ok(futuresRows(big).every((row) => !isMicro(row.symbol)));
  assert.ok(futuresRows(big).some((row) => /^ES[HMUZ]\d{2}/.test(row.symbol)));
});

test("micros are never sold on their own: only by a rebalance sell, an exit or a peel", () => {
  const rows = futuresRows(on);
  const byDate = new Map<string, typeof rows>();
  for (const row of rows) byDate.set(row.date, [...(byDate.get(row.date) ?? []), row]);
  for (const row of rows) {
    if (row.action !== "sell" || !isMicro(row.symbol) || /\(ROLL\)/.test(row.symbol)) continue;
    const day = byDate.get(row.date) ?? [];
    const firstSell = day.find((r) => r.action === "sell" && !/\(ROLL\)/.test(r.symbol));
    const exited = day.at(-1)?.qtyAfter === 0;
    const breached = Math.abs(firstSell?.leverageDeltaPctBefore ?? 0) > 9 - 1e-6;
    assert.ok(exited || breached || /LIQUIDATE/.test(row.symbol), `${row.date}: MES sold inside the band`);
  }
});
