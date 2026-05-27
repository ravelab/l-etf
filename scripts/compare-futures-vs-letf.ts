import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import type { EtfConfig, PricePoint, RatePoint, RiskOffAsset } from "@/lib/simulation/types";
import { runParallelBacktest } from "@/lib/simulation/parallel";
import { createPresetEtfConfig, ETF_PRESETS } from "@/lib/simulation/presets";
import { simulateFuturesSmaStrategy } from "@/lib/simulation/futures";
import { CONSTANT_INITIAL_INVESTMENT } from "@/lib/constants";

type CsvRow = Record<string, string>;

function parseCsv(filename: string): CsvRow[] {
  const raw = readFileSync(join(process.cwd(), "data", filename), "utf-8").trim();
  const [headerLine, ...lines] = raw.split("\n");
  const headers = headerLine.split(",");
  return lines.map((line) => {
    const cols = line.split(",");
    const row: CsvRow = {};
    for (let i = 0; i < headers.length; i++) row[headers[i]!] = cols[i] ?? "";
    return row;
  });
}

function toIndexPricePoints(rows: CsvRow[]): PricePoint[] {
  return rows.map((r) => ({
    date: r.date!,
    adj_close: Number(r.adj_close),
    close: Number(r.close),
    adj_open: r.adj_open ? Number(r.adj_open) : undefined,
    open: r.open ? Number(r.open) : undefined,
  }));
}

function toEtfPricePoints(rows: CsvRow[]): PricePoint[] {
  // For ETF rows we only care about adj_open/adj_close as the actual series;
  // fill `close` with adj_close so downstream alignment stays finite.
  return rows.map((r) => ({
    date: r.date!,
    adj_close: Number(r.adj_close),
    close: Number(r.adj_close),
    adj_open: r.adj_open ? Number(r.adj_open) : undefined,
    open: r.adj_open ? Number(r.adj_open) : undefined,
  }));
}

function toRatePoints(rows: CsvRow[]): RatePoint[] {
  return rows.map((r) => ({
    date: r.date!,
    rateType: "borrow",
    rateValue: Number(r.value),
  }));
}

function alignSeries(rows: PricePoint[], dates: string[], key: "adj_open" | "adj_close"): number[] {
  const m = new Map(rows.map((r) => [r.date, Number(r[key])] as const));
  const out: number[] = [];
  let last = NaN;
  for (const d of dates) {
    const v = m.get(d);
    if (Number.isFinite(v ?? NaN) && (v as number) > 0) last = v as number;
    out.push(last);
  }
  return out;
}

function lastFinite(arr: number[]): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    const v = arr[i];
    if (Number.isFinite(v) && v > 0) return v;
  }
  return 0;
}

function dailyLogReturns(values: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < values.length; i++) {
    const a = values[i - 1] ?? 0;
    const b = values[i] ?? 0;
    if (a > 0 && b > 0 && Number.isFinite(a) && Number.isFinite(b)) out.push(Math.log(b / a));
  }
  return out;
}

function stddev(xs: number[]): number {
  if (xs.length <= 1) return 0;
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  const v = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

async function main() {
  const startDate = process.env.SD ?? "2006-05-01";
  const endDate = process.env.ED ?? "2026-05-02";
  const amount = Number(process.env.AMT ?? "100000");
  const riskOffAsset = (process.env.RO ?? "BRK.B+GLDM+VGSH") as RiskOffAsset;
  const smaSpPeriod = Number(process.env.SMA_P_SP ?? "185");
  const smaSpBufferPct = Number(process.env.SMA_T_SP ?? "3.6");
  const smaNqPeriod = Number(process.env.SMA_P_NQ ?? "148");
  const smaNqBufferPct = Number(process.env.SMA_T_NQ ?? "11.9");
  const leverageTolerancePct = Number(process.env.LT ?? "3");

  const spIndex = toIndexPricePoints(parseCsv("index-sp.csv"));
  const nqIndex = toIndexPricePoints(parseCsv("index-nq.csv"));
  const rates = toRatePoints(parseCsv("rate-borrow.csv"));

  const riskSgov = toEtfPricePoints(parseCsv("risk-sgov.csv"));
  const riskVgsh = toEtfPricePoints(parseCsv("risk-vgsh.csv"));
  const riskGldm = toEtfPricePoints(parseCsv("risk-gldm.csv"));
  const riskBrka = toEtfPricePoints(parseCsv("risk-brka.csv"));

  const riskOffPricesByAsset = {
    SGOV: riskSgov,
    VGSH: riskVgsh,
    GLDM: riskGldm,
    "BRK.B": riskBrka,
  } as const;

  const etfPricePointsByName = {
    UPRO: toEtfPricePoints(parseCsv("etf-upro.csv")),
    TQQQ: toEtfPricePoints(parseCsv("etf-tqqq.csv")),
    QLD: toEtfPricePoints(parseCsv("etf-qld.csv")),
    SSO: toEtfPricePoints(parseCsv("etf-sso.csv")),
  };

  const configs = [
    createPresetEtfConfig("upro", ETF_PRESETS.UPRO, {
      smaEnabled: true,
      smaPeriod: smaSpPeriod,
      smaUpperBuffer: smaSpBufferPct, smaLowerBuffer: smaSpBufferPct,
      riskOffAsset,
    }),
    createPresetEtfConfig("tqqq", ETF_PRESETS.TQQQ, {
      smaEnabled: true,
      smaPeriod: smaNqPeriod,
      smaUpperBuffer: smaNqBufferPct, smaLowerBuffer: smaNqBufferPct,
      riskOffAsset,
    }),
    createPresetEtfConfig("qld", ETF_PRESETS.QLD, {
      smaEnabled: true,
      smaPeriod: smaNqPeriod,
      smaUpperBuffer: smaNqBufferPct, smaLowerBuffer: smaNqBufferPct,
      riskOffAsset,
    }),
    createPresetEtfConfig("sso", ETF_PRESETS.SSO, {
      smaEnabled: true,
      smaPeriod: smaSpPeriod,
      smaUpperBuffer: smaSpBufferPct, smaLowerBuffer: smaSpBufferPct,
      riskOffAsset,
    }),
  ];

  const etfBacktest = await runParallelBacktest({
    prices: spIndex,
    rates,
    startDate,
    endDate,
    configs,
    riskOffPricesByAsset: riskOffPricesByAsset as Partial<Record<EtfConfig["riskOffAsset"], PricePoint[]>>,
    etfPricePointsByName,
    pricesByIndex: { sp500: spIndex, nasdaq100: nqIndex },
  });

  const pick = (sym: string) => etfBacktest.etfResults.find((r) => r.name.toUpperCase().includes(sym) && r.id.endsWith("-sma"));

  const upro = pick("UPRO");
  const tqqq = pick("TQQQ");
  const qld = pick("QLD");
  const sso = pick("SSO");
  assert.ok(upro && tqqq && qld && sso, "Missing ETF SMA results");

  const spDates = spIndex
    .filter((p) => p.date >= startDate && p.date <= endDate)
    .map((p) => p.date);
  const nqDates = nqIndex
    .filter((p) => p.date >= startDate && p.date <= endDate)
    .map((p) => p.date);
  const spRiskOffCloseByTicker = {
    "BRK.B": alignSeries(riskBrka, spDates, "adj_close"),
    GLDM: alignSeries(riskGldm, spDates, "adj_close"),
    VGSH: alignSeries(riskVgsh, spDates, "adj_close"),
    SGOV: alignSeries(riskSgov, spDates, "adj_close"),
  } as Record<string, number[]>;
  const spRiskOffOpenByTicker = {
    "BRK.B": alignSeries(riskBrka, spDates, "adj_open"),
    GLDM: alignSeries(riskGldm, spDates, "adj_open"),
    VGSH: alignSeries(riskVgsh, spDates, "adj_open"),
    SGOV: alignSeries(riskSgov, spDates, "adj_open"),
  } as Record<string, number[]>;
  const nqRiskOffCloseByTicker = {
    "BRK.B": alignSeries(riskBrka, nqDates, "adj_close"),
    GLDM: alignSeries(riskGldm, nqDates, "adj_close"),
    VGSH: alignSeries(riskVgsh, nqDates, "adj_close"),
    SGOV: alignSeries(riskSgov, nqDates, "adj_close"),
  } as Record<string, number[]>;
  const nqRiskOffOpenByTicker = {
    "BRK.B": alignSeries(riskBrka, nqDates, "adj_open"),
    GLDM: alignSeries(riskGldm, nqDates, "adj_open"),
    VGSH: alignSeries(riskVgsh, nqDates, "adj_open"),
    SGOV: alignSeries(riskSgov, nqDates, "adj_open"),
  } as Record<string, number[]>;

  const futuresSp3 = simulateFuturesSmaStrategy({
    index: "sp500",
    prices: spIndex,
    rates,
    startDate,
    endDate,
    initialEquity: amount,
    targetLeverage: 3,
    smaPeriod: smaSpPeriod,
    smaUpperBuffer: smaSpBufferPct, smaLowerBuffer: smaSpBufferPct,
    riskOffAsset,
    riskOffCloseByTicker: spRiskOffCloseByTicker,
    riskOffOpenByTicker: spRiskOffOpenByTicker,
    leverageTolerancePct,
  }).etfResult;

  const futuresSp2 = simulateFuturesSmaStrategy({
    index: "sp500",
    prices: spIndex,
    rates,
    startDate,
    endDate,
    initialEquity: amount,
    targetLeverage: 2,
    smaPeriod: smaSpPeriod,
    smaUpperBuffer: smaSpBufferPct, smaLowerBuffer: smaSpBufferPct,
    riskOffAsset,
    riskOffCloseByTicker: spRiskOffCloseByTicker,
    riskOffOpenByTicker: spRiskOffOpenByTicker,
    leverageTolerancePct,
  }).etfResult;

  const futuresNq3 = simulateFuturesSmaStrategy({
    index: "nasdaq100",
    prices: nqIndex,
    rates,
    startDate,
    endDate,
    initialEquity: amount,
    targetLeverage: 3,
    smaPeriod: smaNqPeriod,
    smaUpperBuffer: smaNqBufferPct, smaLowerBuffer: smaNqBufferPct,
    riskOffAsset,
    riskOffCloseByTicker: nqRiskOffCloseByTicker,
    riskOffOpenByTicker: nqRiskOffOpenByTicker,
    leverageTolerancePct,
  }).etfResult;

  const futuresNq2 = simulateFuturesSmaStrategy({
    index: "nasdaq100",
    prices: nqIndex,
    rates,
    startDate,
    endDate,
    initialEquity: amount,
    targetLeverage: 2,
    smaPeriod: smaNqPeriod,
    smaUpperBuffer: smaNqBufferPct, smaLowerBuffer: smaNqBufferPct,
    riskOffAsset,
    riskOffCloseByTicker: nqRiskOffCloseByTicker,
    riskOffOpenByTicker: nqRiskOffOpenByTicker,
    leverageTolerancePct,
  }).etfResult;

  const scale = CONSTANT_INITIAL_INVESTMENT > 0 ? amount / CONSTANT_INITIAL_INVESTMENT : 1;
  const etfVals = (vals: number[]) => vals.map((v) => v * scale);

  const pairs = [
    ["SP 3x", futuresSp3.dailyValues, etfVals(upro.dailyValues)],
    ["SP 2x", futuresSp2.dailyValues, etfVals(sso.dailyValues)],
    ["NQ 3x", futuresNq3.dailyValues, etfVals(tqqq.dailyValues)],
    ["NQ 2x", futuresNq2.dailyValues, etfVals(qld.dailyValues)],
  ] as const;

  for (const [label, futVals, etfVals] of pairs) {
    const fEnd = lastFinite(futVals);
    const eEnd = lastFinite(etfVals);
    const rel = eEnd > 0 ? fEnd / eEnd - 1 : 0;
    const fR = dailyLogReturns(futVals);
    const eR = dailyLogReturns(etfVals);
    const n = Math.min(fR.length, eR.length);
    const diffs = new Array(n);
    for (let i = 0; i < n; i++) diffs[i] = (fR[i] ?? 0) - (eR[i] ?? 0);
    const teDaily = stddev(diffs);
    const teAnn = teDaily * Math.sqrt(252);
    console.log(`${label}: end fut=${fEnd.toFixed(2)} etf=${eEnd.toFixed(2)} rel=${(rel * 100).toFixed(2)}% trackingErr≈${(teAnn * 100).toFixed(2)}%/yr`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

