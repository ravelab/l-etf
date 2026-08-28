/**
 * One coverage number for unit + browser (Puppeteer) suites over all of src/**.
 *
 *   - unit    : NODE_V8_COVERAGE from the Node unit suite → coverage/unit-v8/
 *   - browser : Chrome V8 from e2e-tests (test:e2e) → coverage/browser-v8/
 *
 * Unloaded src files are filled at 0% so the % is overall, not "files we happened
 * to import". Browser coverage maps bundled scripts back onto src/** via source
 * maps fetched while the origin is still up.
 *
 * Usage:
 *   node scripts/coverage-combined.mjs           # run unit + local browser, merge
 *   node scripts/coverage-combined.mjs --no-run  # merge artifacts already on disk
 */
import { readFile, mkdir, rm } from "node:fs/promises";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

import libCoverage from "istanbul-lib-coverage";
import libReport from "istanbul-lib-report";
import reports from "istanbul-reports";
import {
  root,
  addV8Script,
  loadNodeV8Dir,
  loadIstanbulJson,
  fillUncoveredSrcFiles,
  mergeCoverageMap,
  summarize,
  pct,
  formatCoverageLine,
} from "./lib/coverage-map.mjs";

const OUT = path.join(root, "coverage", "combined");
const UNIT_V8 = path.join(root, "coverage", "unit-v8");
const UNIT_JSDOM = path.join(root, "coverage", "unit-jsdom", "coverage-final.json");
const BROWSER_DIR = path.join(root, "coverage", "browser-v8");

const run = (cmd, args, env = {}) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("exit", (code) => resolve(code ?? 1));
  });

async function loadBrowserClient(map) {
  const file = path.join(BROWSER_DIR, "client-coverage.json");
  if (!existsSync(file)) return 0;
  const entries = JSON.parse(await readFile(file, "utf8"));
  let added = 0;
  for (const entry of entries) {
    let sourceMap = entry.sourceMap ?? null;
    if (!sourceMap && entry.url?.includes("/_next/static/")) {
      try {
        const base = path.basename(new URL(entry.url).pathname);
        const candidates = [
          path.join(root, ".next", "static", "chunks", `${base}.map`),
          path.join(root, ".next", "static", "css", `${base}.map`),
        ];
        for (const candidate of candidates) {
          if (existsSync(candidate)) {
            sourceMap = JSON.parse(await readFile(candidate, "utf8"));
            break;
          }
        }
        if (!sourceMap) {
          const staticRoot = path.join(root, ".next", "static");
          if (existsSync(staticRoot)) {
            const stack = [staticRoot];
            while (stack.length && !sourceMap) {
              const dir = stack.pop();
              for (const name of readdirSync(dir)) {
                const full = path.join(dir, name);
                if (statSync(full).isDirectory()) stack.push(full);
                else if (name === `${base}.map`) {
                  sourceMap = JSON.parse(await readFile(full, "utf8"));
                  break;
                }
              }
            }
          }
        }
      } catch {
        // ignore
      }
    }
    // A chunk's map names its sources relative to where the map sits, so that is where those
    // relative paths have to be resolved from.
    let sourceBase = path.join(root, ".next");
    try {
      sourceBase = path.join(root, ".next", path.dirname(new URL(entry.url).pathname));
    } catch {
      // Not a URL with a directory in it; the build root will do.
    }
    const merged = await addV8Script({
      map,
      url: entry.url,
      code: entry.text,
      functions: entry.functions ?? [],
      sourceBase,
      ...(sourceMap ? { sourceMap } : {}),
    });
    if (merged) added += 1;
  }
  return added;
}

async function main() {
  const skipRun = process.argv.includes("--no-run");
  if (!skipRun) {
    await rm(path.join(root, "coverage"), { recursive: true, force: true });
    console.log("\n[1/3] unit tests with coverage...");
    const unitCode = await run("npm", ["run", "test:unit"], {
      NODE_V8_COVERAGE: UNIT_V8,
    });
    if (unitCode !== 0) process.exitCode = 1;

    console.log("\n[2/3] browser E2E suite with client coverage...");
    await mkdir(BROWSER_DIR, { recursive: true });
    const uiCode = await run("npm", ["run", "test:e2e"], {
      LETF_BROWSER_COVERAGE_DIR: BROWSER_DIR,
    });
    if (uiCode !== 0) process.exitCode = 1;
  }

  console.log("\n[3/3] merging...");
  const map = libCoverage.createCoverageMap({});
  const stages = [];
  let previous = { files: 0, covered: 0 };
  for (const [name, load] of [
    ["unit", (m) => loadNodeV8Dir(m, UNIT_V8)],
    ["jsdom", (m) => loadIstanbulJson(m, UNIT_JSDOM)],
    ["browser", loadBrowserClient],
  ]) {
    // Each suite is read into a map of its own first, so it can be reported the way the unit run
    // reports itself — its own percentage over every src file — before it joins the others. What
    // it adds to the total is a different question from what it covers.
    const stageMap = libCoverage.createCoverageMap({});
    const scripts = await load(stageMap);
    const alone = libCoverage.createCoverageMap(JSON.parse(JSON.stringify(stageMap.data)));
    await fillUncoveredSrcFiles(alone);
    const own = summarize(alone);
    mergeCoverageMap(map, stageMap);
    const totals = summarize(map);
    const current = { files: map.files().length, covered: totals.statements[0] };
    stages.push({
      name,
      scripts,
      own,
      newFiles: current.files - previous.files,
      newStatements: current.covered - previous.covered,
    });
    previous = current;
  }
  for (const stage of stages) {
    console.log(
      `  ${stage.name.padEnd(8)}: ${String(stage.scripts).padStart(4)} scripts -> +${stage.newFiles} files, +${stage.newStatements} covered statements`,
    );
    console.log(`            ${formatCoverageLine("on its own", stage.own).replace("✓ ", "")}`);
  }

  const filled = await fillUncoveredSrcFiles(map);
  console.log(`  filled  : ${filled} unloaded src files at 0%`);

  // Scripts read is not the same as coverage landed: a stage whose source maps never resolve onto
  // src/** merges silently into nothing, and the combined figure then quietly becomes the figure
  // of the stages that did work. Both are failures worth stopping for.
  const empty = stages.filter(
    (stage) =>
      stage.name !== "jsdom" &&
      (stage.scripts === 0 || stage.newStatements === 0),
  );
  if (empty.length) {
    console.error(
      `\n  !! ${empty.map((s) => s.name).join(", ")} contributed NOTHING — figures below are incomplete.`,
    );
    process.exitCode = 1;
  }

  await mkdir(OUT, { recursive: true });
  const context = libReport.createContext({ dir: OUT, coverageMap: map });
  reports.create("text-summary").execute(context);
  reports.create("html").execute(context);
  reports.create("lcov").execute(context);
  reports.create("json").execute(context);
  reports.create("json-summary").execute(context);

  const totals = summarize(map);
  console.log("\n=== COMBINED (unit + browser E2E) over all src/** ===");
  for (const [key, value] of Object.entries(totals)) {
    console.log(`  ${key.padEnd(11)} ${pct(value).padStart(6)}%  (${value[0]}/${value[1]})`);
  }
  const line = formatCoverageLine("combined coverage", totals);
  console.log(`\n${line}`);
  console.log(`  files measured: ${map.files().length}`);
  console.log(`  html report   : ${path.relative(root, OUT)}/index.html`);
}

const entry = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (entry && import.meta.url === entry) await main();
