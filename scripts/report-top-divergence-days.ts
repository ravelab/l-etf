/**
 * Lists top N UPRO vs 3x futures SMA daily log-return gaps and prints index + SMA context.
 * Run: node --import tsx scripts/report-top-divergence-days.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PricePoint } from "@/lib/simulation/types";
import { generateSmaSignals } from "@/lib/simulation/sma";
import { buildInvestedForNextDayOpenExecution } from "@/lib/simulation/engine";

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
async function main() {
  const topN = Number(process.env.N ?? "20");
  const csvPath = process.env.CSV ?? join(process.cwd(), "scripts", "output", "upro-vs-futures-3x-daily.csv");
  const lines = readFileSync(csvPath, "utf-8").trim().split("\n");
  const rows = lines
    .slice(1)
    .map((l) => {
      const c = l.split(",");
      const d = parseFloat(c[5] ?? "");
      if (!c[0] || Number.isNaN(d)) return null;
      return { date: c[0], ur: +c[3], fr: +c[4], dlog: d };
    })
    .filter(Boolean) as { date: string; ur: number; fr: number; dlog: number }[];
  rows.sort((a, b) => Math.abs(b.dlog) - Math.abs(a.dlog));
  const top = rows.slice(0, topN);

  const spIndex = toIndexPricePoints(parseCsv("index-sp.csv"));
  const fullCloses = spIndex.map((p) => (Number.isFinite(p.close) ? p.close : p.adj_close));
  const fullSma = generateSmaSignals(
    spIndex.map((p) => p.date),
    fullCloses,
    185,
    3.6,
  );
  /** Mirrors ETF + futures: next-session-open execution of raw `generateSmaSignals` invested flags. */
  const investedExecFull = buildInvestedForNextDayOpenExecution(fullSma.invested);
  const execByDate = new Map(spIndex.map((p, i) => [p.date, investedExecFull[i]!]));

  const spInRange = spIndex.filter((p) => p.date >= "2006-05-02" && p.date <= "2026-05-02");

  console.log("rank\tdate\t|Δlog|bps\tupro%\tfut%\tidxC2C%\texecTransition?");
  for (let r = 0; r < top.length; r++) {
    const { date, ur, fr, dlog } = top[r]!;
    const j = spInRange.findIndex((p) => p.date === date);
    let idxC2C = NaN;
    if (j > 0) {
      const p0 = spInRange[j - 1]!;
      const p1 = spInRange[j]!;
      const c0 = Number.isFinite(p0.close) ? p0.close : p0.adj_close;
      const c1 = Number.isFinite(p1.close) ? p1.close : p1.adj_close;
      idxC2C = (c1 / c0 - 1) * 100;
    }
    const d = date;
    const prev = j > 0 ? spInRange[j - 1]!.date : "";
    const trans =
      prev !== "" && execByDate.get(d) !== undefined && execByDate.get(prev) !== undefined
        ? execByDate.get(d) !== execByDate.get(prev)
        : false;
    console.log(
      [
        r + 1,
        date,
        (Math.abs(dlog) * 10000).toFixed(1),
        (ur * 100).toFixed(3),
        (fr * 100).toFixed(3),
        Number.isFinite(idxC2C) ? idxC2C.toFixed(3) : "",
        trans ? "Y" : "",
      ].join("\t"),
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
