// Writes the monthly CPI series the SMA engine deflates with
// (`src/lib/tool-snapshots/cpi-monthly.json`) from `data/inflation.csv`. The engine
// runs in browser workers and serverless functions alike, so it imports CPI as a
// bundled module instead of fetching it; the monthly data commit picks the file up.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MonthlyCpiModule } from "../../src/lib/simulation/cpi-deflator";

const CPI_MODULE_PATH = join(process.cwd(), "src/lib/tool-snapshots/cpi-monthly.json");

function nextMonth(month: string): string {
  const [year, m] = month.split("-").map(Number);
  return m === 12 ? `${year + 1}-01` : `${year}-${String(m + 1).padStart(2, "0")}`;
}

/** Contiguous months from the CSV; a month the source skips repeats the prior value. */
export function buildCpiModule(csv: string): MonthlyCpiModule {
  const rows = csv.trim().split(/\r?\n/).slice(1).map((line) => {
    const [month, value] = line.split(",");
    return { month, value: Number(value) };
  }).filter((row) => /^\d{4}-\d{2}$/.test(row.month) && row.value > 0);
  if (rows.length === 0) throw new Error("inflation.csv has no CPI rows");
  const values: number[] = [rows[0].value];
  let month = rows[0].month;
  for (const row of rows.slice(1)) {
    while (nextMonth(month) < row.month) {
      values.push(values[values.length - 1]);
      month = nextMonth(month);
    }
    values.push(row.value);
    month = row.month;
  }
  return { startMonth: rows[0].month, values };
}

export function writeCpiModule(dataDir = join(process.cwd(), "data")): void {
  const cpi = buildCpiModule(readFileSync(join(dataDir, "inflation.csv"), "utf8"));
  writeFileSync(CPI_MODULE_PATH, `${JSON.stringify(cpi)}\n`);
  console.log(`[cpi] wrote ${cpi.values.length} months from ${cpi.startMonth}`);
}
