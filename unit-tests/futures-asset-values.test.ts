import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  accountComposition,
  toDailyAssetValues,
} from "@/lib/simulation/futures-asset-values";
import { simulateFuturesSmaStrategy, type FuturesStrategyParams } from "@/lib/simulation/futures";
import { simulateDualSleeveFuturesStrategy } from "@/lib/simulation/futures-dual-sleeve";
import { buildFuturesRunPlans, runFuturesPlan } from "@/lib/simulation/futures-run-plan";
import type { FuturesLadderStep } from "@/lib/simulation/futures-plan";

test("futures notional is exposure, not money held; ETFs and margin cash are, and Cash is the rest", () => {
  const composition = accountComposition([
    { index: "sp500", positions: { ESZ25: 450_000, MESZ25: 25_000, SGOV: 20_000, VGSH: 60_000 }, marginCash: 15_000, equity: 100_000 },
  ]);
  assert.deepEqual(composition, { "SPX margin cash": 15_000, SGOV: 20_000, VGSH: 60_000, Cash: 5_000 });
});

test("a fund's margin cash stays split by index while ETFs combine", () => {
  const composition = accountComposition([
    { index: "sp500", positions: { ESZ25: 400_000, VGSH: 70_000 }, marginCash: 25_000, equity: 100_000 },
    { index: "nasdaq100", positions: { NQZ25: 300_000, VGSH: 60_000 }, marginCash: 30_000, equity: 92_000 },
  ]);
  assert.deepEqual(composition, { "SPX margin cash": 25_000, "NDX margin cash": 30_000, VGSH: 130_000, Cash: 7_000 });
});

test("float residue of a position sold to nothing is not a holding", () => {
  // A full SGOV sale can leave ~1e-60 behind; on a log axis that plotted as a cliff.
  const composition = accountComposition([{ index: "sp500", positions: { SGOV: 1e-60, BRK: 1_000 }, equity: 1_000.4 }]);
  assert.deepEqual(composition, { BRK: 1_000 });
});

test("each asset becomes one zero-filled series: margin cash, ETFs, then Cash", () => {
  const values = toDailyAssetValues([{ Cash: 1, SGOV: 1 }, { "NDX margin cash": 2, SGOV: 2 }, { "SPX margin cash": 3, BRK: 5 }]);
  assert.deepEqual(Object.keys(values), ["SPX margin cash", "NDX margin cash", "BRK", "SGOV", "Cash"]);
  assert.deepEqual(values.SGOV, [1, 2, 0]);
  assert.deepEqual(values.Cash, [1, 0, 0]);
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
  assert.ok(!Object.keys(values).some((asset) => /^M?(ES|NQ)/.test(asset)), "no futures notional");
  assert.ok(values["SPX margin cash"], "a 4.5x SPX sleeve holds margin cash");

  // Before `finish` liquidates, the composition adds up to the day's equity.
  const total = (k: number) => Object.values(values).reduce((sum, series) => sum + series[k], 0);
  for (let k = 0; k < dates.length - 1; k++) {
    assert.ok(Math.abs(total(k) - recorded.etfResult.dailyValues[k]) < 5, `${dates[k]}: parts sum to equity`);
  }
  // At 4.5x, 8% maintenance on notional is 36% of equity, plus the sweep buffer;
  // out of the market only a sub-band remainder is left in the futures account.
  const share = dates.map((_, k) => values["SPX margin cash"][k] / recorded.etfResult.dailyValues[k]);
  const riskOn = share.filter((x) => x > 0.05);
  const riskOff = share.filter((x) => x < 0.01);
  assert.ok(riskOn.length > 100 && riskOff.length > 10, "the window covers both regimes");
  assert.equal(riskOn.length + riskOff.length, dates.length, "margin cash is either a margin balance or a remainder");
  for (const x of riskOn) assert.ok(x > 0.3 && x < 0.55, `risk-on margin cash is ${(x * 100).toFixed(0)}% of equity`);
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
  assert.ok(values["SPX margin cash"] && values["NDX margin cash"], "each index keeps its own margin cash");
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
  assert.ok(shown.dailyAssetValues?.["SPX margin cash"]);
  assert.equal(hidden.dailyAssetValues, undefined);
});
