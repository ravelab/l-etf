import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  simulateFuturesSmaStrategy,
  type FuturesStrategyParams,
  type FuturesTransactionRow,
} from "@/lib/simulation/futures";
import { simulateDualSleeveFuturesStrategy } from "@/lib/simulation/futures-dual-sleeve";
import {
  addHoldings,
  ledgerAssetLines,
  ledgerTradeValues,
  ledgerHoldingsDeltas,
  runningHoldings,
  sumHoldings,
} from "@/lib/simulation/futures-ledger-assets";

const FUTURES_LISTING = /^(ES|NQ)[HMUZ]\d{2}$/;

function futuresValue(holdings: Record<string, number>, root: "ES" | "NQ"): number {
  return Object.entries(holdings)
    .filter(([symbol]) => FUTURES_LISTING.test(symbol) && symbol.startsWith(root))
    .reduce((sum, [, qty]) => sum + qty, 0);
}

function stampOf(row: FuturesTransactionRow): Record<string, number> {
  assert.ok(row.holdingsAfter, `${row.date} ${row.symbol}: every row must carry holdingsAfter`);
  return row.holdingsAfter;
}

/** A 2x SPX rung that exits to BRK.B and back again on a six-day path, with Treasury collateral. */
function brkRoundTrip() {
  const dates = ["2026-01-02", "2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09"];
  const closes = [100, 110, 60, 55, 120, 125];
  const flat = (x: number) => dates.map(() => x);
  return simulateFuturesSmaStrategy({
    index: "sp500",
    prices: dates.map((date, i) => ({ date, close: closes[i], open: closes[i], adj_close: closes[i] })),
    rates: dates.map((date) => ({ date, rateType: "borrow", rateValue: 0 })),
    startDate: dates[0],
    endDate: dates.at(-1)!,
    initialEquity: 1_000_000,
    targetLeverage: 1,
    smaPeriod: 2,
    smaUpperBuffer: 0,
    smaLowerBuffer: 0,
    riskOffAsset: "BRK.B",
    treasuryCollateral: true,
    riskOffCloseByTicker: { SGOV: flat(100), VGSH: flat(58), "BRK.B": flat(500) },
    riskOffOpenByTicker: { SGOV: flat(100), VGSH: flat(58), "BRK.B": flat(500) },
    futuresFundingSpreadAnnual: 0,
  });
}

const ROUND_TRIP_CLOSES = [100, 110, 60, 55, 120, 125];

test("each ledger row is stamped with the dollar value the sleeve holds once it has executed", () => {
  const result = brkRoundTrip();
  const levelByDate = new Map(result.etfResult.dates.map((d, i) => [d, ROUND_TRIP_CLOSES[i]]));
  assert.ok(result.transactions.some((row) => row.symbol === "BRK.B" && row.action === "buy"));
  assert.ok(result.transactions.some((row) => row.symbol === "BRK.B" && row.action === "sell"));
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-6 * Math.max(1, Math.abs(b));
  for (const row of result.transactions) {
    const held = stampOf(row);
    if (row.instrument === "futures") {
      // ES is $50 a point, valued at the index level of the moment (open = close here).
      const notional = row.qtyAfter * 50 * (levelByDate.get(row.date) ?? NaN);
      assert.ok(near(futuresValue(held, "ES"), notional), `${row.date} ${row.symbol}: notional`);
    } else if (row.symbol.endsWith("(COLLATERAL)")) {
      const ticker = row.symbol.replace(" (COLLATERAL)", "");
      assert.ok(near(held[ticker] ?? 0, row.qtyAfter * row.fillPrice), `${row.date} ${row.symbol}: marked value`);
    } else if (row.symbol === "BRK.B" && row.action === "buy") {
      assert.ok(near(held["BRK.B"] ?? 0, row.qtyAfter * row.fillPrice), `${row.date} BRK.B bought`);
    } else if (row.symbol === "BRK.B") {
      assert.equal(held["BRK.B"], undefined, `${row.date}: a sold leg leaves the stamp`);
    }
  }
  assert.deepEqual(stampOf(result.transactions.at(-1)!), {}, "the book closes out flat");
});

test("a close-out that sells a whole basket records what it sold per ticker", () => {
  // Ends risk-off in BRK.B+GLDM, so the book closes with one multi-ticker row.
  const dates = ["2026-01-02", "2026-01-05", "2026-01-06", "2026-01-07"];
  const closes = [100, 110, 60, 55];
  const flat = (x: number) => dates.map(() => x);
  const result = simulateFuturesSmaStrategy({
    index: "sp500",
    prices: dates.map((date, i) => ({ date, close: closes[i], open: closes[i], adj_close: closes[i] })),
    rates: dates.map((date) => ({ date, rateType: "borrow", rateValue: 0 })),
    startDate: dates[0],
    endDate: dates.at(-1)!,
    initialEquity: 1_000_000,
    targetLeverage: 1,
    smaPeriod: 2,
    smaUpperBuffer: 0,
    smaLowerBuffer: 0,
    riskOffAsset: "BRK.B+GLDM",
    riskOffCloseByTicker: { "BRK.B": flat(500), GLDM: flat(50) },
    riskOffOpenByTicker: { "BRK.B": flat(500), GLDM: flat(50) },
    futuresFundingSpreadAnnual: 0,
  });
  const closeOut = result.transactions.at(-1)!;
  assert.equal(closeOut.isEndLiquidation, true);
  assert.ok(closeOut.symbol.includes("LIQUIDATE"));
  const before = result.transactions.at(-2)!.holdingsAfter!;
  assert.ok(before["BRK.B"] > 0 && before.GLDM > 0, "the basket was held going into the close-out");
  for (const ticker of ["BRK.B", "GLDM"]) {
    assert.ok(Math.abs((closeOut.legValues?.[ticker] ?? 0) + before[ticker]) < 1e-6, `${ticker}: sold what was held`);
  }
  assert.deepEqual(closeOut.holdingsAfter, {});
});

type CsvRow = Record<string, string>;
function parseCsv(filename: string): CsvRow[] {
  const raw = readFileSync(join(process.cwd(), "data", filename), "utf-8").trim();
  const [headerLine, ...lines] = raw.split("\n");
  const headers = headerLine.split(",");
  return lines.map((line) => {
    const cols = line.split(",");
    return Object.fromEntries(headers.map((h, i) => [h, cols[i] ?? ""]));
  });
}
function aligned(rows: CsvRow[], dates: string[], key: "adj_open" | "adj_close"): number[] {
  const byDate = new Map(rows.map((r) => [r.date, Number(r[key])]));
  let last = NaN;
  return dates.map((d) => {
    const v = byDate.get(d);
    if (Number.isFinite(v) && (v as number) > 0) last = v as number;
    return last;
  });
}

const START = "2003-10-10";
const rates = parseCsv("rate-borrow.csv").map((r) => ({ date: r.date, rateType: "borrow", rateValue: Number(r.value) }));
const sgovRows = parseCsv("risk-sgov.csv");

function sleeve(index: "sp500" | "nasdaq100", targetLeverage: number): Omit<FuturesStrategyParams, "initialEquity" | "displayName"> {
  const prices = parseCsv(index === "sp500" ? "index-sp.csv" : "index-nq.csv").map((r) => ({
    date: r.date,
    adj_close: Number(r.adj_close),
    close: Number(r.close),
    open: r.open ? Number(r.open) : Number(r.close),
  }));
  const dates = prices.filter((p) => p.date >= START).map((p) => p.date);
  return {
    index,
    prices,
    rates,
    startDate: START,
    endDate: prices.at(-1)!.date,
    targetLeverage,
    maxLeverage: targetLeverage,
    smaPeriod: 200,
    smaUpperBuffer: 0,
    smaLowerBuffer: 0,
    riskOffAsset: "SGOV",
    riskOffCloseByTicker: { SGOV: aligned(sgovRows, dates, "adj_close") },
    riskOffOpenByTicker: { SGOV: aligned(sgovRows, dates, "adj_open") },
  };
}

test("a two-sleeve fund's rows hold the whole fund, both sleeves' positions together", () => {
  const fund = simulateDualSleeveFuturesStrategy({
    displayName: "Max 4.5x SPX / Max 3.5x NDX SMA",
    initialEquity: 100_000,
    primary: sleeve("sp500", 4.5),
    secondary: sleeve("nasdaq100", 3.5),
  });
  let sawBothFamilies = false;
  for (const row of fund.transactions) {
    const held = stampOf(row);
    if (row.instrument !== "futures") continue;
    // A row's own family must match its own sleeve's count: the other sleeve
    // contributes only its own family, never a second copy of this one.
    const root = row.symbol.startsWith("ES") ? "ES" : "NQ";
    assert.equal(futuresValue(held, root) > 0, row.qtyAfter > 0, `${row.date} ${row.symbol}`);
    if (futuresValue(held, "ES") > 0 && futuresValue(held, "NQ") > 0) sawBothFamilies = true;
  }
  assert.ok(sawBothFamilies, "rows must show the other sleeve's contracts alongside their own");
  assert.deepEqual(stampOf(fund.transactions.at(-1)!), {}, "both sleeves close out flat");
  for (let k = 1; k < fund.transactions.length; k++) {
    assert.ok(fund.transactions[k - 1].date <= fund.transactions[k].date, "ledger stays in date order");
  }
});

test("holdings arithmetic is immutable and drops positions that net to nothing", () => {
  const a = { ESM88: 3, "BRK.B": 10 };
  const sum = addHoldings(a, { ESM88: -3, GLDM: 2 });
  assert.deepEqual(sum, { "BRK.B": 10, GLDM: 2 });
  assert.deepEqual(a, { ESM88: 3, "BRK.B": 10 }, "inputs are untouched");
  assert.deepEqual(sumHoldings([{ A: 1 }, { A: 2, B: 1 }, { B: -1 }]), { A: 3 });
});

test("deltas replayed in any within-day order land on the engine's end-of-day holdings", () => {
  const rows: Array<{ holdingsAfter: Record<string, number> }> = [
    { holdingsAfter: { ESM88: 10 } },
    { holdingsAfter: { ESM88: 10, SGOV: 300 } },
    // Next day: sell the futures, then buy the basket.
    { holdingsAfter: { SGOV: 300 } },
    { holdingsAfter: { SGOV: 300, "BRK.B": 50 } },
  ];
  const deltas = ledgerHoldingsDeltas(rows);
  assert.ok(deltas);
  assert.deepEqual(deltas[0], { ESM88: 10 });
  assert.deepEqual(deltas[2], { ESM88: -10 });
  // Shown buy-first: intermediate rows differ, the day still ends where the engine did.
  const shown = runningHoldings([deltas[0], deltas[1], deltas[3], deltas[2]]);
  assert.deepEqual(shown[2], { ESM88: 10, SGOV: 300, "BRK.B": 50 });
  assert.deepEqual(shown[3], rows[3].holdingsAfter);
  assert.equal(ledgerHoldingsDeltas([{ holdingsAfter: {} }, {}]), null, "legacy rows disable the column");
});

test("asset lines put futures first by expiry, then one-letter risk-off labels", () => {
  const lines = ledgerAssetLines(
    { VGSH: 55_400, NQZ88: 9_000, ESH89: 27_000, ESZ88: 110_000, "BRK.B": 12_000, GLDM: 34_000, SGOV: 0.2 },
    "1988-12-12"
  );
  assert.deepEqual(lines.futures.map((a) => a.label), ["ESZ88", "ESH89", "NQZ88"]);
  assert.deepEqual(lines.securities.map((a) => a.label), ["B", "G", "V"], "sub-dollar residue is left off");
  assert.equal(lines.securities[2].value, 55_400);
  // The century resolves against the trade date, so a 1999 roll orders Dec before Mar.
  assert.deepEqual(
    ledgerAssetLines({ ESH00: 1, ESZ99: 1 }, "1999-12-14").futures.map((a) => a.label),
    ["ESZ99", "ESH00"]
  );
});

test("trade values are futures notional, risk-off dollars, or a close-out's own legs", () => {
  assert.deepEqual(ledgerTradeValues({ symbol: "NQM88 (ROLL)", qtyDelta: -3, fillPrice: 180 }), { NQM88: -10_800 });
  assert.deepEqual(ledgerTradeValues({ symbol: "ESZ88 (LIQUIDATE)", qtyDelta: -2, fillPrice: 270 }), { ESZ88: -27_000 });
  assert.deepEqual(ledgerTradeValues({ symbol: "VGSH (COLLATERAL)", qtyDelta: 200, fillPrice: 20 }), { VGSH: 4_000 });
  assert.deepEqual(
    ledgerTradeValues({ symbol: "B+G (LIQUIDATE)", qtyDelta: 0, fillPrice: 0, legValues: { "BRK.B": -5, GLDM: -6 } }),
    { "BRK.B": -5, GLDM: -6 }
  );
  const lines = ledgerAssetLines({ NQU88: 10_800 }, "1988-06-14", { NQM88: -10_800, NQU88: 10_800 });
  assert.deepEqual(lines.futures, [
    { label: "NQM88", value: 0, trade: -10_800 },
    { label: "NQU88", value: 10_800, trade: 10_800 },
  ], "a roll shows the closed listing and the new one");
});
