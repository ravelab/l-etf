import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EraEvaluatedCombo } from "./sma-sweep-context";
import { comboKey } from "../../src/lib/simulation/sma-search";

/** Resume expensive searches only when their scoring code and data match. */
export function presetScoreCache(index: string, endDate: string) {
  const hash = createHash("sha256").update(endDate);
  for (const file of readdirSync("src/lib/simulation").filter((file) => file.endsWith(".ts")).sort())
    hash.update(readFileSync(join("src/lib/simulation", file)));
  for (const file of ["scripts/lib/sma-sweep-context.ts", "scripts/lib/sweep-data.ts", "src/lib/constants.ts", "src/lib/inflation.ts", "src/lib/fetch-market-data.ts"])
    hash.update(readFileSync(file));
  for (const file of readdirSync("data").filter((file) => file.endsWith(".csv")).sort()) {
    const stat = statSync(join("data", file));
    hash.update(`${file}|${stat.size}|${stat.mtimeMs}`);
  }
  const path = join(tmpdir(), `l-etf-preset-scores-${index}-${hash.digest("hex").slice(0, 16)}.json`);
  const rows: EraEvaluatedCombo[] = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
  const cache = new Map(rows.map((row) => [comboKey(row.combo), { ...row, combo: {
    smaPeriod: row.combo.smaPeriod, smaUpperBuffer: row.combo.smaUpperBuffer, smaLowerBuffer: row.combo.smaLowerBuffer,
  } }]));
  return { cache, save: () => {
    const pendingPath = `${path}.pending`;
    writeFileSync(pendingPath, JSON.stringify([...cache.values()]));
    renameSync(pendingPath, path);
  } };
}
