// Writes the rate-hike shock episodes (`src/lib/tool-snapshots/rate-hike-shock.json`)
// from `data/rate-borrow.csv`. A signal rule sees only index closes, so the extra
// strategy reads these bundled episodes; `fetch-data` rewrites them whenever it
// touches the rate file, and the monthly data commit picks the file up.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  RATE_HIKE_SHOCK,
  computeRateHikeShockEpisodes,
  type RateHikeShockModule,
} from "../../src/lib/simulation/rate-hike-shock";

const MODULE_PATH = join(process.cwd(), "src/lib/tool-snapshots/rate-hike-shock.json");

export function writeRateHikeShockModule(dataDir = join(process.cwd(), "data")): void {
  const rows = readFileSync(join(dataDir, "rate-borrow.csv"), "utf8").trim().split(/\r?\n/).slice(1).map((line) => {
    const [date, value] = line.split(",");
    return { date, value: Number(value) };
  });
  if (rows.length === 0 || rows.some((r) => !Number.isFinite(r.value))) {
    throw new Error("rate-borrow.csv has no usable rows for the rate-hike shock");
  }
  const bundle: RateHikeShockModule = {
    params: RATE_HIKE_SHOCK,
    dataEndDate: rows[rows.length - 1].date,
    episodes: computeRateHikeShockEpisodes(rows).episodes,
  };
  writeFileSync(MODULE_PATH, `${JSON.stringify(bundle, null, 2)}\n`);
  console.log(`[rate-hike-shock] wrote ${bundle.episodes.length} episodes through ${bundle.dataEndDate}`);
}
