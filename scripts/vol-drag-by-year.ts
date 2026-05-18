// Compute per-year realized vol, index return, actual 3× leveraged ETF return,
// and compare actual drag vs the ½·L·(L−1)·σ² = 3σ² approximation.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const DATA_DIR = join(process.cwd(), "data");

type Row = { date: string; close: number };

async function readCsv(file: string, closeCol: string): Promise<Row[]> {
  const text = await readFile(join(DATA_DIR, file), "utf-8");
  const lines = text.trim().split("\n");
  const header = lines[0].split(",");
  const dateIdx = header.indexOf("date");
  const closeIdx = header.indexOf(closeCol);
  const rows: Row[] = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(",");
    const date = parts[dateIdx];
    const close = Number(parts[closeIdx]);
    if (!date || !Number.isFinite(close) || close <= 0) continue;
    rows.push({ date, close });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return rows;
}

function yearStats(rows: Row[], year: number): { ret: number; vol: number; n: number } | null {
  const inYear = rows.filter((r) => r.date.startsWith(`${year}-`));
  if (inYear.length < 50) return null;
  const logRets: number[] = [];
  for (let i = 1; i < inYear.length; i++) {
    logRets.push(Math.log(inYear[i].close / inYear[i - 1].close));
  }
  const ret = inYear[inYear.length - 1].close / inYear[0].close - 1;
  const mean = logRets.reduce((s, v) => s + v, 0) / logRets.length;
  const variance = logRets.reduce((s, v) => s + (v - mean) ** 2, 0) / (logRets.length - 1);
  const vol = Math.sqrt(variance) * Math.sqrt(252);
  return { ret, vol, n: inYear.length };
}

function pct(n: number, digits = 1): string {
  return (n * 100).toFixed(digits) + "%";
}

async function analyze(label: string, indexFile: string, etfFile: string, expenseRatio: number): Promise<void> {
  const index = await readCsv(indexFile, "adj_close");
  const etf = await readCsv(etfFile, "adj_close");
  const etfStartYear = Number(etf[0].date.slice(0, 4));
  const etfEndYear = Number(etf[etf.length - 1].date.slice(0, 4));

  console.log(`\n=== ${label} ===`);
  console.log(
    `Year | IdxVol | IdxRet | 3×Naive | DragApx | Expected | Actual | Diff`,
  );
  console.log(`-----+--------+--------+---------+---------+----------+--------+------`);

  for (let y = etfStartYear; y <= etfEndYear; y++) {
    const idx = yearStats(index, y);
    const lev = yearStats(etf, y);
    if (!idx || !lev) continue;
    const naive3x = 3 * idx.ret;
    const dragApprox = 3 * idx.vol * idx.vol; // ½·L·(L−1)·σ² = 3σ² for L=3
    // Expected compounded 3× return: (1 + idx.ret)^3 / compounding gap ... simpler:
    // expected = naive - drag - fees, but this over-simplifies; use:
    //   expected ≈ exp(3·μ_arith − 3·σ²) − 1, where μ_arith ≈ ln(1+ret) + σ²/2
    const muArith = Math.log(1 + idx.ret) + 0.5 * idx.vol * idx.vol;
    const expectedLog = 3 * muArith - 3 * idx.vol * idx.vol - expenseRatio;
    const expected = Math.exp(expectedLog) - 1;
    const diff = lev.ret - expected;
    console.log(
      `${y} | ${pct(idx.vol).padStart(6)} | ${pct(idx.ret).padStart(6)} | ${pct(naive3x).padStart(7)} | ${pct(dragApprox).padStart(7)} | ${pct(expected).padStart(8)} | ${pct(lev.ret).padStart(6)} | ${pct(diff).padStart(5)}`,
    );
  }
}

async function main(): Promise<void> {
  console.log("Columns:");
  console.log("  IdxVol   = realized annualized vol of daily log returns");
  console.log("  IdxRet   = index total return for the year");
  console.log("  3×Naive  = 3 × IdxRet (wrong — ignores compounding)");
  console.log("  DragApx  = ½·L·(L−1)·σ² = 3σ² approximation");
  console.log("  Expected = exp(3·μ_arith − 3σ² − ER) − 1 (theoretical 3× compounded)");
  console.log("  Actual   = realized 3× ETF total return");
  console.log("  Diff     = Actual − Expected (positive = outperformance vs formula)");

  await analyze("SPX vs UPRO (ER 0.91%)", "index-sp.csv", "etf-upro.csv", 0.0091);
  await analyze("NDX vs TQQQ (ER 0.84%)", "index-nq.csv", "etf-tqqq.csv", 0.0084);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
