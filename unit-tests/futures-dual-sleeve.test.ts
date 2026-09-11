import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { simulateFuturesSmaStrategy, type FuturesStrategyParams } from "@/lib/simulation/futures";
import { simulateDualSleeveFuturesStrategy } from "@/lib/simulation/futures-dual-sleeve";
import { buildFuturesLadderPlan, type SmaBandsByIndex } from "@/lib/simulation/futures-plan";

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

const START = "2003-10-10";
const rates = parseCsv("rate-borrow.csv").map((r) => ({
  date: r.date,
  rateType: "borrow",
  rateValue: Number(r.value),
}));
const sgovRows = parseCsv("risk-sgov.csv");

function pricesFor(index: "sp500" | "nasdaq100") {
  return parseCsv(index === "sp500" ? "index-sp.csv" : "index-nq.csv").map((r) => {
    const close = Number(r.close);
    return {
      date: r.date,
      adj_close: Number(r.adj_close),
      close,
      adj_open: r.adj_open ? Number(r.adj_open) : undefined,
      open: r.open ? Number(r.open) : Number.isFinite(close) ? close : undefined,
    };
  });
}

/** Sleeve inputs minus the two fields the fund owns (`initialEquity`, `displayName`). */
function sleeve(
  index: "sp500" | "nasdaq100",
  targetLeverage: number,
  sma: { period: number; upper: number; lower: number },
  maxLeverage?: number
): Omit<FuturesStrategyParams, "initialEquity" | "displayName"> {
  const prices = pricesFor(index);
  const endDate = prices[prices.length - 1]!.date;
  const dates = prices.filter((p) => p.date >= START).map((p) => p.date);
  return {
    index,
    prices,
    rates,
    startDate: START,
    endDate,
    targetLeverage,
    maxLeverage,
    smaPeriod: sma.period,
    smaUpperBuffer: sma.upper,
    smaLowerBuffer: sma.lower,
    riskOffAsset: "SGOV",
    riskOffCloseByTicker: { SGOV: alignRiskSeries(sgovRows, dates, "adj_close") },
    riskOffOpenByTicker: { SGOV: alignRiskSeries(sgovRows, dates, "adj_open") },
  };
}

const NORMAL_SP = { period: 200, upper: 0, lower: 0 };
const NORMAL_NQ = { period: 200, upper: 0, lower: 0 };
/** An exit threshold 99% below the SMA never fires, so the sleeve is risk-on throughout. */
const ALWAYS_ON = { period: 200, upper: 0, lower: 99 };

test("dual sleeve: with no trigger it is exactly two independent half-size sleeves", () => {
  // Both sleeves stay risk-on for the whole window, so "both risk-off" never happens
  // and no capital ever moves. Any difference here is the interleaving machinery
  // itself changing a sleeve's path, which it must never do.
  const primary = sleeve("sp500", 4.5, ALWAYS_ON, 4.5);
  const secondary = sleeve("nasdaq100", 3, ALWAYS_ON);
  const fund = simulateDualSleeveFuturesStrategy({
    displayName: "Max 4.5x SPX 3x NDX SMA",
    initialEquity: 30_000,
    primary,
    secondary,
  });

  const soloSp = simulateFuturesSmaStrategy({ ...primary, initialEquity: 15_000 });
  const soloNq = simulateFuturesSmaStrategy({ ...secondary, initialEquity: 15_000 });

  const spByDate = new Map(soloSp.etfResult.dates.map((d, i) => [d, soloSp.etfResult.dailyValues[i]]));
  const nqByDate = new Map(soloNq.etfResult.dates.map((d, i) => [d, soloNq.etfResult.dailyValues[i]]));

  let compared = 0;
  fund.etfResult.dates.forEach((date, k) => {
    const sp = spByDate.get(date);
    const nq = nqByDate.get(date);
    if (sp === undefined || nq === undefined) return;
    compared += 1;
    assert.equal(
      fund.etfResult.dailyValues[k],
      sp + nq,
      `${date}: fund must be the exact sum of its sleeves when nothing rebalances`
    );
  });
  assert.ok(compared > 1000, `expected a long overlap, compared ${compared} days`);
});

test("dual sleeve: the 50/50 reset actually fires and moves the result", () => {
  const primary = sleeve("sp500", 4.5, NORMAL_SP, 4.5);
  const secondary = sleeve("nasdaq100", 3, NORMAL_NQ);
  const fund = simulateDualSleeveFuturesStrategy({
    displayName: "Max 4.5x SPX 3x NDX SMA",
    initialEquity: 30_000,
    primary,
    secondary,
  });
  const soloSp = simulateFuturesSmaStrategy({ ...primary, initialEquity: 15_000 });
  const soloNq = simulateFuturesSmaStrategy({ ...secondary, initialEquity: 15_000 });

  const unrebalanced =
    (soloSp.etfResult.dailyValues.at(-1) ?? 0) + (soloNq.etfResult.dailyValues.at(-1) ?? 0);
  const final = fund.etfResult.dailyValues.at(-1) ?? 0;

  assert.ok(Number.isFinite(final) && final > 0, "fund must end at a finite positive value");
  assert.notEqual(final, unrebalanced, "with real SMA bands the reset must change the outcome");
});

test("dual sleeve: reports the fund's own curve, not the primary sleeve's", () => {
  const fund = simulateDualSleeveFuturesStrategy({
    displayName: "Max 4.5x SPX 3x NDX SMA",
    initialEquity: 30_000,
    primary: sleeve("sp500", 4.5, NORMAL_SP, 4.5),
    secondary: sleeve("nasdaq100", 3, NORMAL_NQ),
  });
  const { etfResult } = fund;
  assert.equal(etfResult.name, "Max 4.5x SPX 3x NDX SMA");
  assert.equal(etfResult.dailyValues.length, etfResult.dates.length);
  assert.equal(etfResult.smaPrices.length, etfResult.dates.length, "SMA overlay must span the fund calendar");
  assert.equal(etfResult.finalValue, etfResult.dailyValues.at(-1));
  // Slightly under the full amount: day 0 establishes both sleeves' positions and
  // each pays its own entry commission and spread, exactly as a lone sleeve does.
  const opening = etfResult.dailyValues[0];
  assert.ok(opening < 30_000 && opening > 29_900, `fund should open just under 30,000, got ${opening}`);
  assert.ok(etfResult.maxDrawdownPct > 0 && etfResult.maxDrawdownPct < 100);
  assert.ok(Number.isFinite(etfResult.cagr));
  assert.ok(etfResult.totalTradingCostPct > 0, "both sleeves' costs must be carried");
});

const BANDS: SmaBandsByIndex = {
  sp500: { period: 186, upperBuffer: 3, lowerBuffer: 3.3 },
  nasdaq100: { period: 150, upperBuffer: 20.4, lowerBuffer: 17.6 },
};

test("futures plan: the dual-sleeve rung carries each index's own band", () => {
  const plan = buildFuturesLadderPlan({
    showEmulations: false,
    hasNasdaqData: true,
    yearSpan: 20,
    bands: BANDS,
  });
  const dual = plan.find((step) => step.secondary);
  assert.ok(dual, "the ladder must offer the two-sleeve fund");
  assert.equal(dual.displayName, "Max 4.5x SPX 3x NDX SMA");
  assert.equal(dual.index, "sp500");
  assert.equal(dual.leverage, 4.5);
  assert.equal(dual.maxLeverage, 4.5);
  assert.deepEqual(dual.sma, BANDS.sp500);
  assert.equal(dual.secondary?.index, "nasdaq100");
  assert.equal(dual.secondary?.leverage, 3);
  // The NDX sleeve must take the NDX band, not inherit the SPX one.
  assert.deepEqual(dual.secondary?.sma, BANDS.nasdaq100);
});

test("futures plan: the dual-sleeve rung drops with no NDX data, and survives a long window", () => {
  const noNdx = buildFuturesLadderPlan({
    showEmulations: false,
    hasNasdaqData: false,
    yearSpan: 20,
    bands: BANDS,
  });
  assert.equal(noNdx.some((step) => step.secondary), false, "no NDX data means no NDX sleeve");

  const long = buildFuturesLadderPlan({
    showEmulations: false,
    hasNasdaqData: true,
    yearSpan: 140,
    bands: BANDS,
  });
  assert.equal(long.some((step) => step.secondary), true, "the fund runs on long windows too");

  const emulations = buildFuturesLadderPlan({
    showEmulations: true,
    hasNasdaqData: true,
    yearSpan: 20,
    bands: BANDS,
  });
  assert.equal(
    emulations.some((step) => step.secondary),
    false,
    "emulation mode runs only rungs that have an LETF twin"
  );
});
