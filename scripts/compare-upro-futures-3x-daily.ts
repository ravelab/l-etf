/**
 * UPRO SMA backtest (1957–) vs 3× SPX futures SMA (2006–) with matching parameters.
 * Writes daily series + compares overlapping daily returns. Equity columns are rebased so both
 * paths equal `AMT` USD on the first overlapping session (UPRO’s engine starts in 1957; futures
 * starts at `SD_FUT`; rebasing does not change returns). If divergence is large, prints roll-day
 * flags from futures transactions and the worst gaps (LETF vs futures differ on expense ratio,
 * borrow, rebalance bands, rolls, and daily compounding).
 *
 * Default params match:
 *   /tools?tab=backtest&letf=UPRO&sd=1957-03-04&ed=2026-05-02&smaPsp=185&...&ro=BRK.B+GLDM+VGSH
 *   /tools?tab=futures&sd=2006-05-02&ed=2026-05-02&...&amt=1000000&lt=3
 *
 * Run: node --import tsx scripts/compare-upro-futures-3x-daily.ts
 * Env (optional): SD_BT, ED_BT, SD_FUT, ED_FUT, AMT, LT, OUT
 *
 * Top gaps vs index context: node --import tsx scripts/report-top-divergence-days.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EtfConfig, PricePoint, RatePoint, RiskOffAsset } from "@/lib/simulation/types";
import { runParallelBacktest } from "@/lib/simulation/parallel";
import { createPresetEtfConfig, ETF_PRESETS } from "@/lib/simulation/presets";
import { simulateFuturesSmaStrategy } from "@/lib/simulation/futures";
import { CONSTANT_INITIAL_INVESTMENT, getRiskOffFetchTickers } from "@/lib/constants";
import { alignCloseSeriesToDates, alignOpenSeriesToDates } from "@/lib/utils";

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

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2 || n !== ys.length) return NaN;
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const vx = xs[i]! - mx;
    const vy = ys[i]! - my;
    num += vx * vy;
    dx += vx * vx;
    dy += vy * vy;
  }
  const den = Math.sqrt(dx * dy);
  return den > 0 ? num / den : NaN;
}

function buildRiskOffAligned(
  basePrices: PricePoint[],
  rawByTicker: Record<string, PricePoint[]>,
  tickers: string[],
): { closeByTicker: Record<string, number[]>; openByTicker: Record<string, number[]> } {
  const closeByTicker: Record<string, number[]> = {};
  const openByTicker: Record<string, number[]> = {};
  for (const t of tickers) {
    const series = rawByTicker[t];
    if (!series?.length) {
      closeByTicker[t] = new Array(basePrices.length).fill(NaN);
      openByTicker[t] = new Array(basePrices.length).fill(NaN);
      continue;
    }
    closeByTicker[t] = alignCloseSeriesToDates(basePrices, series);
    openByTicker[t] = alignOpenSeriesToDates(basePrices, series);
  }
  return { closeByTicker, openByTicker };
}

async function main() {
  const backtestStart = process.env.SD_BT ?? "1957-03-04";
  const backtestEnd = process.env.ED_BT ?? "2026-05-02";
  const futuresStart = process.env.SD_FUT ?? "2006-05-02";
  const futuresEnd = process.env.ED_FUT ?? "2026-05-02";
  const amount = Number(process.env.AMT ?? "1000000");
  const leverageTolerancePct = Number(process.env.LT ?? "3");
  const outPath = process.env.OUT ?? join(process.cwd(), "scripts", "output", "upro-vs-futures-3x-daily.csv");

  const riskOffAsset = (process.env.RO ?? "BRK.B+GLDM+VGSH") as RiskOffAsset;
  const smaSpPeriod = Number(process.env.SMA_P_SP ?? "185");
  const smaSpBufferPct = Number(process.env.SMA_T_SP ?? "3.6");

  const spIndex = toIndexPricePoints(parseCsv("index-sp.csv"));
  const nqIndex = toIndexPricePoints(parseCsv("index-nq.csv"));
  const rates = toRatePoints(parseCsv("rate-borrow.csv"));

  const riskSgov = toEtfPricePoints(parseCsv("risk-sgov.csv"));
  const riskVgsh = toEtfPricePoints(parseCsv("risk-vgsh.csv"));
  const riskGldm = toEtfPricePoints(parseCsv("risk-gldm.csv"));
  const riskBrka = toEtfPricePoints(parseCsv("risk-brka.csv"));

  const rawRiskByTicker: Record<string, PricePoint[]> = {
    SGOV: riskSgov,
    VGSH: riskVgsh,
    GLDM: riskGldm,
    "BRK.B": riskBrka,
  };

  const etfPricePointsByName = {
    UPRO: toEtfPricePoints(parseCsv("etf-upro.csv")),
  };

  const configs: EtfConfig[] = [
    createPresetEtfConfig("upro", ETF_PRESETS.UPRO, {
      smaEnabled: true,
      smaPeriod: smaSpPeriod,
      smaUpperBuffer: smaSpBufferPct, smaLowerBuffer: smaSpBufferPct,
      riskOffAsset,
    }),
  ];

  const riskOffPricesByAsset = {
    SGOV: riskSgov,
    VGSH: riskVgsh,
    GLDM: riskGldm,
    "BRK.B": riskBrka,
  } as Partial<Record<EtfConfig["riskOffAsset"], PricePoint[]>>;

  const etfBacktest = await runParallelBacktest({
    prices: spIndex,
    rates,
    startDate: backtestStart,
    endDate: backtestEnd,
    configs,
    riskOffPricesByAsset,
    etfPricePointsByName,
    pricesByIndex: { sp500: spIndex, nasdaq100: nqIndex },
  });

  const upro = etfBacktest.etfResults.find((r) => r.id === "upro-sma");
  if (!upro) {
    throw new Error("Missing UPRO SMA result (expected id upro-sma)");
  }

  const spInRange = spIndex.filter((p) => p.date >= futuresStart && p.date <= futuresEnd);
  const tickers = getRiskOffFetchTickers(riskOffAsset);
  const { closeByTicker: riskOffCloseByTicker, openByTicker: riskOffOpenByTicker } = buildRiskOffAligned(
    spInRange,
    rawRiskByTicker,
    tickers,
  );

  const futuresBundle = simulateFuturesSmaStrategy({
    index: "sp500",
    prices: spIndex,
    rates,
    startDate: futuresStart,
    endDate: futuresEnd,
    initialEquity: amount,
    targetLeverage: 3,
    smaPeriod: smaSpPeriod,
    smaUpperBuffer: smaSpBufferPct, smaLowerBuffer: smaSpBufferPct,
    riskOffAsset,
    riskOffCloseByTicker,
    riskOffOpenByTicker,
    leverageTolerancePct,
  });

  const futures = futuresBundle.etfResult;
  const rollDates = new Set<string>();
  for (const row of futuresBundle.transactions) {
    if (row.symbol?.includes("(ROLL)")) rollDates.add(row.date);
  }

  const scale = CONSTANT_INITIAL_INVESTMENT > 0 ? amount / CONSTANT_INITIAL_INVESTMENT : 1;
  const uproScaled = upro.dailyValues.map((v) => v * scale);

  const mapUpro = new Map<string, number>();
  for (let i = 0; i < upro.dates.length; i++) {
    const v = uproScaled[i];
    if (Number.isFinite(v)) mapUpro.set(upro.dates[i]!, v);
  }
  const mapFut = new Map<string, number>();
  for (let i = 0; i < futures.dates.length; i++) {
    const v = futures.dailyValues[i];
    if (Number.isFinite(v)) mapFut.set(futures.dates[i]!, v);
  }

  const common = upro.dates
    .filter((d) => d >= futuresStart && d <= futuresEnd && mapFut.has(d) && mapUpro.has(d))
    .sort();

  const u0First = mapUpro.get(common[0]!)!;
  const f0First = mapFut.get(common[0]!)!;
  const rebUpro = Number.isFinite(u0First) && u0First > 0 ? amount / u0First : 1;
  const rebFut = Number.isFinite(f0First) && f0First > 0 ? amount / f0First : 1;

  const rows: string[] = [
    "date,upro_equity_rebased_usd,futures_equity_rebased_usd,upro_simple_ret,futures_simple_ret,log_ret_diff_fut_minus_upro",
  ];

  const startD = common[0]!;
  rows.push(
    `${startD},${(mapUpro.get(startD)! * rebUpro).toFixed(6)},${(mapFut.get(startD)! * rebFut).toFixed(6)},,,`,
  );

  for (let i = 1; i < common.length; i++) {
    const d0 = common[i - 1]!;
    const d1 = common[i]!;
    const u0 = mapUpro.get(d0)! * rebUpro;
    const u1 = mapUpro.get(d1)! * rebUpro;
    const f0 = mapFut.get(d0)! * rebFut;
    const f1 = mapFut.get(d1)! * rebFut;
    const ur = u0 > 0 ? u1 / u0 - 1 : NaN;
    const fr = f0 > 0 ? f1 / f0 - 1 : NaN;
    let logDiffStr = "";
    if (Number.isFinite(ur) && Number.isFinite(fr)) {
      logDiffStr = Math.log((1 + fr) / (1 + ur)).toFixed(8);
    }
    rows.push(
      `${d1},${u1.toFixed(6)},${f1.toFixed(6)},${Number.isFinite(ur) ? ur.toFixed(8) : ""},${Number.isFinite(fr) ? fr.toFixed(8) : ""},${logDiffStr}`,
    );
  }

  const uproLog = dailyLogReturns(common.map((d) => mapUpro.get(d)!));
  const futLog = dailyLogReturns(common.map((d) => mapFut.get(d)!));
  const n = Math.min(uproLog.length, futLog.length);
  const pairedU = uproLog.slice(0, n);
  const pairedF = futLog.slice(0, n);
  const diffLog = pairedU.map((u, i) => pairedF[i]! - u);

  const teDaily = stddev(diffLog);
  const teAnn = teDaily * Math.sqrt(252);
  const corr = pearson(pairedU, pairedF);
  const madLog = mean(diffLog.map((d) => Math.abs(d)));

  try {
    mkdirSync(dirname(outPath), { recursive: true });
  } catch {
    /* ignore */
  }
  writeFileSync(outPath, rows.join("\n") + "\n", "utf-8");

  console.log(
    `Wrote ${common.length} overlapping calendar days (${common.length - 1} daily return rows; equities rebased to AMT=${amount} on ${common[0]}) → ${outPath}`,
  );
  console.log(
    `Daily log-return correlation: ${corr.toFixed(6)}  mean|Δlog|: ${(madLog * 10000).toFixed(3)} bps  TE≈${(teAnn * 100).toFixed(2)}%/yr`,
  );

  const thresholdCorr = 0.995;
  const thresholdMad = 0.0008;
  const investigate = !Number.isFinite(corr) || corr < thresholdCorr || madLog > thresholdMad;

  if (investigate) {
    console.log(
      `\nInvestigation (corr < ${thresholdCorr} or mean|Δlog| > ${thresholdMad}): synthetic 3× futures path != simulated UPRO path is expected in places — expense ratio, borrow, rebalance timing, roll slippage, and LETF daily compounding.`,
    );

    const indexed = diffLog.map((d, i) => ({ i, d: Math.abs(d), raw: d }));
    indexed.sort((a, b) => b.d - a.d);
    console.log("\nTop 25 days by |Δ daily log return| (futures − UPRO):");
    for (let k = 0; k < 25 && k < indexed.length; k++) {
      const { i, raw } = indexed[k]!;
      const day = common[i + 1];
      const rollTx = day ? rollDates.has(day) : false;
      console.log(`  ${day}  Δlog=${raw.toFixed(6)}  futures_roll_tx=${rollTx}`);
    }
  } else {
    console.log("\nDaily returns are close enough over the overlap (no deep-dive table).");
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
