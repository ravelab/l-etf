import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { riskOffSharesPerSeriesUnit } from "@/lib/constants";
import { simulateFuturesSmaStrategy, type FuturesStrategyResult } from "@/lib/simulation/futures";

type CsvRow = Record<string, string>;

function parseCsv(filename: string): CsvRow[] {
  const [headerLine, ...lines] = readFileSync(join(process.cwd(), "data", filename), "utf-8").trim().split("\n");
  const headers = headerLine.split(",");
  return lines.map((line) => {
    const cols = line.split(",");
    return Object.fromEntries(headers.map((h, i) => [h, cols[i] ?? ""]));
  });
}

function align(rows: CsvRow[], dates: string[], key: "adj_open" | "adj_close"): number[] {
  const byDate = new Map(rows.map((r) => [r.date, Number(r[key])]));
  let last = Number.NaN;
  return dates.map((d) => {
    const v = byDate.get(d);
    if (v !== undefined && Number.isFinite(v) && v > 0) last = v;
    return last;
  });
}

// Daily Treasury rows start 2020-04; the SMA-100 band exits SPX through 2022.
const START = "2020-06-01";
const END = "2023-12-29";
const prices = parseCsv("index-sp.csv").map((r) => {
  const close = Number(r.close);
  return { date: r.date, adj_close: Number(r.adj_close), close, open: r.open ? Number(r.open) : close };
});
const dates = prices.filter((p) => p.date >= START && p.date <= END).map((p) => p.date);
const series = { "BRK.B": parseCsv("risk-brka.csv"), GLDM: parseCsv("risk-gldm.csv"), SGOV: parseCsv("risk-sgov.csv"), VGSH: parseCsv("risk-vgsh.csv") };
const byTicker = (key: "adj_open" | "adj_close") =>
  Object.fromEntries(Object.entries(series).map(([t, rows]) => [t, align(rows, dates, key)]));
const brkaClose = new Map(series["BRK.B"].map((r) => [r.date, Number(r.adj_close)]));

function run(initialEquity: number, treasuryCollateral = true): FuturesStrategyResult {
  return simulateFuturesSmaStrategy({
    index: "sp500",
    prices,
    rates: parseCsv("rate-borrow.csv").map((r) => ({ date: r.date, rateType: "borrow", rateValue: Number(r.value) })),
    startDate: START,
    endDate: END,
    initialEquity,
    targetLeverage: 4.5,
    smaPeriod: 100,
    smaUpperBuffer: 1,
    smaLowerBuffer: 1,
    riskOffAsset: "BRK.B+GLDM",
    treasuryCollateral,
    microFutures: true,
    riskOffCloseByTicker: byTicker("adj_close"),
    riskOffOpenByTicker: byTicker("adj_open"),
  }, { recordAssetValues: true });
}

const basketBuys = (result: FuturesStrategyResult, ticker: string) =>
  result.transactions.filter((row) => row.instrument === "riskoff" && row.action === "buy" && row.symbol === ticker);

test("the BRK.B series is BRK-A, so a BRK.B share is 1/1,500 of it; other tickers trade at the series price", () => {
  assert.equal(riskOffSharesPerSeriesUnit("BRK.B"), 1500);
  for (const ticker of ["GLDM", "VOO", "QQQ", "SGOV", "VGSH"]) assert.equal(riskOffSharesPerSeriesUnit(ticker), 1);
});

test("the risk-off basket buys whole shares, at least 200 a leg, BRK.B at BRK.B prices", () => {
  const result = run(2_000_000);
  const brk = basketBuys(result, "BRK.B");
  const gldm = basketBuys(result, "GLDM");
  assert.ok(brk.length > 0 && gldm.length > 0, "the window exits to the basket");
  for (const row of [...brk, ...gldm]) {
    assert.ok(Number.isInteger(row.qtyDelta), `${row.date} ${row.symbol}: ${row.qtyDelta} is not a whole share count`);
    assert.ok(row.qtyDelta >= 200, `${row.date} ${row.symbol}: ${row.qtyDelta} is under the 200-share minimum`);
  }
  for (const row of brk) {
    const brka = brkaClose.get(row.date) ?? Number.NaN;
    assert.ok(row.fillPrice > brka / 1500 / 1.2 && row.fillPrice < brka / 1500 * 1.2, `${row.date}: BRK.B filled at ${row.fillPrice}`);
  }
});

test("a leg under 200 shares is dropped before any order, and its share is not moved into the other legs", () => {
  // Half of this account never reaches 200 BRK.B (~$275-310 a share) but buys 300-1,000 GLDM.
  const result = run(20_000);
  assert.equal(basketBuys(result, "BRK.B").length, 0, "no BRK.B order under the minimum");
  assert.ok(basketBuys(result, "GLDM").length > 0, "GLDM still meets the minimum");
  const values = result.dailyAssetValues!;
  const riskOffDays = result.etfResult.dates.map((_, k) => k).filter((k) => (values.GLDM?.[k] ?? 0) > 0);
  assert.ok(riskOffDays.length > 10);
  for (const k of riskOffDays) {
    // GLDM gets its own half; the dropped half stays where it was (Treasuries, margin
    // cash awaiting the sweep, or cash), and the parts always add up to equity.
    const gldm = values.GLDM[k] / result.etfResult.dailyValues[k];
    assert.ok(gldm > 0.4 && gldm < 0.56, `${result.etfResult.dates[k]}: GLDM is ${(gldm * 100).toFixed(0)}% of equity`);
  }
});

test("the analytical cash mode keeps its fractional basket", () => {
  const result = run(60_000, false);
  assert.ok(basketBuys(result, "BRK.B").some((row) => !Number.isInteger(row.qtyDelta)));
});
