import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PricePoint, RatePoint, EtfConfig } from "@/lib/simulation/types";
import { runParallelBacktest, runParallelVariants } from "@/lib/simulation/parallel";
import { createPresetEtfConfig, ETF_PRESETS } from "@/lib/simulation/presets";

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

function toIndex(rows: CsvRow[]): PricePoint[] {
  return rows.map((r) => ({
    date: r.date!,
    adj_close: Number(r.adj_close),
    close: Number(r.close),
    adj_open: r.adj_open ? Number(r.adj_open) : undefined,
    open: r.open ? Number(r.open) : undefined,
  }));
}

function toEtf(rows: CsvRow[]): PricePoint[] {
  return rows.map((r) => ({
    date: r.date!,
    adj_close: Number(r.adj_close),
    close: Number(r.adj_close),
    adj_open: r.adj_open ? Number(r.adj_open) : undefined,
    open: r.adj_open ? Number(r.adj_open) : undefined,
  }));
}

function toRates(rows: CsvRow[]): RatePoint[] {
  return rows.map((r) => ({ date: r.date!, rateType: "borrow", rateValue: Number(r.value) }));
}

async function main() {
  const startDate = "2006-05-01";
  const endDate = "2026-05-02";
  const windowLength = 21;
  const smaSpPeriod = 185;
  const smaSpBuffer = 3.6;
  const riskOffAsset = "BRK.B+GLDM+VGSH" as const;

  const sp = toIndex(parseCsv("index-sp.csv"));
  const rates = toRates(parseCsv("rate-borrow.csv"));
  const etfUpro = toEtf(parseCsv("etf-upro.csv"));
  const riskBrk = toEtf(parseCsv("risk-brka.csv"));
  const riskGldm = toEtf(parseCsv("risk-gldm.csv"));
  const riskVgsh = toEtf(parseCsv("risk-vgsh.csv"));

  const cfg: EtfConfig = createPresetEtfConfig("upro", ETF_PRESETS.UPRO, {
    smaEnabled: true,
    smaPeriod: smaSpPeriod,
    smaUpperBuffer: smaSpBuffer, smaLowerBuffer: smaSpBuffer,
    riskOffAsset,
  });

  // Align risk-off close/open to SP index dates (same alignment logic as tests).
  const dates = sp.filter((p) => p.date >= startDate && p.date <= endDate).map((p) => p.date);
  const align = (rows: PricePoint[], key: "adj_open" | "adj_close") => {
    const m = new Map(rows.map((r) => [r.date, Number(r[key])] as const));
    const out: number[] = [];
    let last = NaN;
    for (const d of dates) {
      const v = m.get(d);
      if (Number.isFinite(v ?? NaN) && (v as number) > 0) last = v as number;
      out.push(last);
    }
    return out;
  };
  const riskOffValuesByAsset: Partial<Record<EtfConfig["riskOffAsset"], number[]>> = {
    "BRK.B": align(riskBrk, "adj_close"),
    GLDM: align(riskGldm, "adj_close"),
    VGSH: align(riskVgsh, "adj_close"),
  };
  const riskOffOpenValuesByAsset: Partial<Record<EtfConfig["riskOffAsset"], number[]>> = {
    "BRK.B": align(riskBrk, "adj_open"),
    GLDM: align(riskGldm, "adj_open"),
    VGSH: align(riskVgsh, "adj_open"),
  };

  const backtest = await runParallelBacktest({
    prices: sp,
    rates,
    startDate,
    endDate,
    configs: [cfg],
    riskOffPricesByAsset: {
      "BRK.B": riskBrk,
      GLDM: riskGldm,
      VGSH: riskVgsh,
    } satisfies Partial<Record<EtfConfig["riskOffAsset"], PricePoint[]>>,
    etfPricePointsByName: { UPRO: etfUpro },
    pricesByIndex: { sp500: sp, nasdaq100: sp },
  });
  const back = backtest.etfResults[0]!;

  const variants = await runParallelVariants({
    prices: sp,
    rates,
    windowLength,
    startDate,
    endDate,
    variants: [{ config: cfg, label: "UPRO SMA" }],
    riskOffValuesByAsset,
    riskOffOpenValuesByAsset,
  });
  const lastWindow = variants[0]?.simulations?.[variants[0].simulations.length - 1];

  console.log("backtest finalValue", back.finalValue, "date", back.dates.at(-1));
  console.log("strategies lastWindow finalValue", lastWindow?.finalValue, "start", lastWindow?.startDate, "end", lastWindow?.endDate);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

