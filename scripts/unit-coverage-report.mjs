/**
 * Overall unit coverage over all of src/** (unloaded files count as 0%).
 *
 * Merges:
 *   - NODE_V8_COVERAGE dumps from node:test (coverage/unit-v8)
 *   - Vitest/jsdom Istanbul JSON (coverage/unit-jsdom/coverage-final.json)
 *
 * Then fills every other src file as uncovered and prints one summary line.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import libCoverage from "istanbul-lib-coverage";
import libReport from "istanbul-lib-report";
import reports from "istanbul-reports";
import {
  root,
  loadNodeV8Dir,
  loadIstanbulJson,
  fillUncoveredSrcFiles,
  summarize,
  formatCoverageLine,
  listSrcFiles,
} from "./lib/coverage-map.mjs";

const UNIT_V8 = process.env.NODE_V8_COVERAGE || path.join(root, "coverage", "unit-v8");
const JSDOM_JSON = path.join(root, "coverage", "unit-jsdom", "coverage-final.json");
const OUT = path.join(root, "coverage", "unit");

async function main() {
  const map = libCoverage.createCoverageMap({});
  const scripts = await loadNodeV8Dir(map, UNIT_V8);
  const afterNode = map.files().length;
  const jsdomNew = await loadIstanbulJson(map, JSDOM_JSON);
  const afterJsdom = map.files().length;
  const filled = await fillUncoveredSrcFiles(map);
  const totals = summarize(map);

  await mkdir(OUT, { recursive: true });
  const context = libReport.createContext({ dir: OUT, coverageMap: map });
  reports.create("json-summary").execute(context);
  reports.create("text-summary").execute(context);

  const line = formatCoverageLine("unit coverage (all src/**)", totals);
  console.log(line);
  console.log(
    `  files · ${map.files().length}/${listSrcFiles().length} src · ` +
      `node:test ${afterNode} · jsdom +${jsdomNew} (now ${afterJsdom}) · ${filled} filled at 0% · ${scripts} V8 scripts`,
  );
  console.log(`  html/json · ${path.relative(root, OUT)}/`);
}

const entry = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (entry && import.meta.url === entry) await main();
