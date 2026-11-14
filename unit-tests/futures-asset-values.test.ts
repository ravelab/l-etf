import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assetValueKey,
  positionsByAsset,
  toDailyAssetValues,
} from "@/lib/simulation/futures-asset-values";
import { simulateFuturesSmaStrategy, type FuturesStrategyParams } from "@/lib/simulation/futures";
import { simulateDualSleeveFuturesStrategy } from "@/lib/simulation/futures-dual-sleeve";
import { buildFuturesRunPlans, runFuturesPlan } from "@/lib/simulation/futures-run-plan";
import type { FuturesLadderStep } from "@/lib/simulation/futures-plan";

test("micros fold into their full-size family; ETFs keep their ticker", () => {
  assert.equal(assetValueKey("ESZ25"), "ES");
  assert.equal(assetValueKey("MESZ25"), "ES");
  assert.equal(assetValueKey("NQH88"), "NQ");
  assert.equal(assetValueKey("MNQH88"), "NQ");
  assert.equal(assetValueKey("BRK.B"), "BRK.B");
  assert.equal(assetValueKey("SGOV"), "SGOV");
});

test("positions sum by asset and drop empty or invalid entries", () => {
  assert.deepEqual(
    positionsByAsset({ ESZ25: 400_000, MESZ25: 25_000, ESH26: 100, SGOV: 50_000, VGSH: 0, GLDM: Number.NaN }),
    { ES: 425_100, SGOV: 50_000 },
  );
});

test("float residue of a position sold to nothing is not a holding", () => {
  // A full SGOV sale can leave ~1e-60 behind; on a log axis that plotted as a cliff.
  assert.deepEqual(positionsByAsset({ SGOV: 1e-60, VGSH: 0.4, ES: 2e6 }), { ES: 2e6 });
});

test("a live fund run never records sub-dollar residue", () => {
  const params = {
    displayName: "Fund",
    initialEquity: 1_000_000,
    primary: sleeve("sp500", 4.5),
    secondary: sleeve("nasdaq100", 3.5),
  };
  const values = simulateDualSleeveFuturesStrategy(params, undefined, { recordAssetValues: true }).dailyAssetValues!;
  for (const [asset, series] of Object.entries(values)) {
    assert.ok(series.every((v) => v === 0 || v >= 1), `${asset} carries sub-dollar residue`);
  }
});

test("each asset becomes one zero-filled series, futures first", () => {
  const values = toDailyAssetValues([{ SGOV: 1 }, { ES: 4, SGOV: 2 }, { NQ: 3, BRK: 5 }]);
  assert.deepEqual(Object.keys(values), ["ES", "NQ", "BRK", "SGOV"]);
  assert.deepEqual(values.ES, [0, 4, 0]);
  assert.deepEqual(values.NQ, [0, 0, 3]);
  assert.deepEqual(values.BRK, [0, 0, 5]);
  assert.deepEqual(values.SGOV, [1, 2, 0]);
});

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

// Daily Treasury rows start 2020-04; 2020-2023 holds both regimes through the 2022 bear market.
const START = "2020-06-01";
const END = "2023-12-29";
const rates = parseCsv("rate-borrow.csv").map((r) => ({ date: r.date, rateType: "borrow", rateValue: Number(r.value) }));
const sgov = parseCsv("risk-sgov.csv");
const vgsh = parseCsv("risk-vgsh.csv");

function pricesFor(index: "sp500" | "nasdaq100") {
  return parseCsv(index === "sp500" ? "index-sp.csv" : "index-nq.csv").map((r) => {
    const close = Number(r.close);
    return {
      date: r.date,
      adj_close: Number(r.adj_close),
      close,
      adj_open: r.adj_open ? Number(r.adj_open) : undefined,
      open: r.open ? Number(r.open) : close,
    };
  });
}

function sleeve(index: "sp500" | "nasdaq100", targetLeverage: number): Omit<FuturesStrategyParams, "initialEquity" | "displayName"> {
  const prices = pricesFor(index);
  const dates = prices.filter((p) => p.date >= START && p.date <= END).map((p) => p.date);
  return {
    index,
    prices,
    rates,
    startDate: START,
    endDate: END,
    targetLeverage,
    smaPeriod: 100,
    smaUpperBuffer: 1,
    smaLowerBuffer: 1,
    riskOffAsset: "SGOV",
    treasuryCollateral: true,
    microFutures: true,
    riskOffCloseByTicker: { SGOV: alignRisk(sgov, dates, "adj_close"), VGSH: alignRisk(vgsh, dates, "adj_close") },
    riskOffOpenByTicker: { SGOV: alignRisk(sgov, dates, "adj_open"), VGSH: alignRisk(vgsh, dates, "adj_open") },
  };
}

test("a single sleeve records one value per result date without changing the run", () => {
  const params = { ...sleeve("sp500", 4.5), initialEquity: 1_000_000 };
  const plain = simulateFuturesSmaStrategy(params);
  const recorded = simulateFuturesSmaStrategy(params, { recordAssetValues: true });
  assert.equal(plain.dailyAssetValues, undefined);
  assert.deepEqual(recorded.etfResult.dailyValues, plain.etfResult.dailyValues);
  assert.equal(recorded.transactions.length, plain.transactions.length);

  const values = recorded.dailyAssetValues!;
  const dates = recorded.etfResult.dates;
  for (const series of Object.values(values)) assert.equal(series.length, dates.length);
  assert.ok(values.ES, "a 4.5x SPX sleeve holds ES");
  assert.ok(!Object.keys(values).some((asset) => asset.startsWith("MES")), "micros are folded into ES");

  // Notional is leverage × equity: within the tolerance band on a risk-on close.
  const invested = dates.map((_, k) => values.ES[k] > 0);
  const riskOnDays = dates.map((_, k) => k).filter((k) => invested[k]);
  const riskOffDays = dates.map((_, k) => k).filter((k) => !invested[k]);
  assert.ok(riskOnDays.length > 100 && riskOffDays.length > 10, "the window covers both regimes");
  for (const k of riskOnDays.filter((_, n) => n % 25 === 0)) {
    const leverage = values.ES[k] / recorded.etfResult.dailyValues[k];
    assert.ok(leverage > 3.5 && leverage < 5.5, `${dates[k]}: ES notional is ${leverage.toFixed(2)}x equity`);
  }
  // Out of the market, the book is the Treasury basket.
  for (const k of riskOffDays) {
    const treasuries = (values.SGOV?.[k] ?? 0) + (values.VGSH?.[k] ?? 0);
    assert.ok(treasuries > 0, `${dates[k]}: risk-off holds Treasuries`);
  }
});

test("the two-sleeve fund records both indices on the fund's calendar", () => {
  const params = {
    displayName: "Fund",
    initialEquity: 1_000_000,
    primary: sleeve("sp500", 4.5),
    secondary: sleeve("nasdaq100", 3.5),
  };
  const plain = simulateDualSleeveFuturesStrategy(params);
  const recorded = simulateDualSleeveFuturesStrategy(params, undefined, { recordAssetValues: true });
  assert.deepEqual(recorded.etfResult.dailyValues, plain.etfResult.dailyValues);
  const values = recorded.dailyAssetValues!;
  assert.ok(values.ES && values.NQ, "the fund holds both ES and NQ");
  for (const series of Object.values(values)) assert.equal(series.length, recorded.etfResult.dates.length);
});

test("run plans record only the steps the caller asks for", () => {
  const steps: FuturesLadderStep[] = [
    { index: "sp500", leverage: 4.5, sma: { period: 100, upperBuffer: 1, lowerBuffer: 1 } },
    { index: "sp500", leverage: 3, sma: { period: 100, upperBuffer: 1, lowerBuffer: 1 } },
  ];
  const plans = buildFuturesRunPlans({
    steps,
    initialEquity: 1_000_000,
    sleeveParams: (index, leverage) => sleeve(index, leverage),
    recordAssetValuesFor: (step) => step.leverage === 4.5,
  });
  const [shown, hidden] = plans.map(runFuturesPlan);
  assert.ok(shown.dailyAssetValues?.ES);
  assert.equal(hidden.dailyAssetValues, undefined);
});
