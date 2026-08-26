/**
 * One coverage number for unit + browser (Puppeteer) suites over src/**.
 *
 *   - unit    : NODE_V8_COVERAGE from the Node unit suite → coverage/unit-v8/
 *   - browser : Chrome V8 from ui-tests (test:ui) → coverage/browser-v8/
 *
 * Browser coverage maps bundled scripts back onto src/** via source maps fetched
 * while the origin is still up. Deployed previews have no NODE_V8_COVERAGE
 * (remote process), so server hits there are client-only.
 *
 * Usage:
 *   node scripts/coverage-combined.mjs           # run unit + local browser, merge
 *   node scripts/coverage-combined.mjs --no-run  # merge artifacts already on disk
 */
import { readFile, readdir, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

import libCoverage from "istanbul-lib-coverage";
import libReport from "istanbul-lib-report";
import reports from "istanbul-reports";
import { convert } from "ast-v8-to-istanbul";
import { parseAstAsync } from "vite";
import { decode, encode } from "@jridgewell/sourcemap-codec";

const root = process.cwd();
const OUT = path.join(root, "coverage", "combined");
const UNIT_V8 = path.join(root, "coverage", "unit-v8");
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

function isAppSource(file) {
  if (!file) return false;
  const rel = path.relative(root, file);
  return (
    rel.startsWith("src" + path.sep) &&
    /\.(ts|tsx|js|jsx|mjs)$/.test(rel) &&
    !rel.includes(`${path.sep}node_modules${path.sep}`) &&
    !/\.d\.ts$/.test(rel)
  );
}

function flattenSourceMap(map) {
  if (!map || !Array.isArray(map.sections)) return map;
  const sources = [];
  const sourcesContent = [];
  const names = [];
  const lines = [];
  for (const section of map.sections) {
    const inner = section.map;
    if (!inner?.mappings) continue;
    const lineOffset = section.offset?.line ?? 0;
    const columnOffset = section.offset?.column ?? 0;
    const sourceBase = sources.length;
    const nameBase = names.length;
    sources.push(...(inner.sources ?? []));
    sourcesContent.push(
      ...(inner.sourcesContent ?? (inner.sources ?? []).map(() => null)),
    );
    names.push(...(inner.names ?? []));
    const decoded = decode(inner.mappings);
    decoded.forEach((segments, index) => {
      const target = lineOffset + index;
      while (lines.length <= target) lines.push([]);
      for (const segment of segments) {
        const generatedColumn = index === 0 ? segment[0] + columnOffset : segment[0];
        if (segment.length === 1) lines[target].push([generatedColumn]);
        else if (segment.length === 4) {
          lines[target].push([
            generatedColumn,
            segment[1] + sourceBase,
            segment[2],
            segment[3],
          ]);
        } else {
          lines[target].push([
            generatedColumn,
            segment[1] + sourceBase,
            segment[2],
            segment[3],
            segment[4] + nameBase,
          ]);
        }
      }
    });
  }
  for (const line of lines) line.sort((a, b) => a[0] - b[0]);
  return {
    version: 3,
    sources,
    sourcesContent: sourcesContent.some(Boolean) ? sourcesContent : undefined,
    names,
    mappings: encode(lines),
  };
}

async function addV8Script({ map, url, code, functions, sourceMap }) {
  if (!code || !functions?.length) return;
  try {
    const flat = flattenSourceMap(sourceMap);
    const fileUrl = url.startsWith("file://")
      ? url
      : pathToFileURL(
          path.join(root, ".next", "v8", encodeURIComponent(url).slice(-120)),
        ).href;
    const data = await convert({
      code,
      ast: await parseAstAsync(code),
      wrapperLength: 0,
      coverage: { scriptId: "0", url: fileUrl, functions },
      ...(flat ? { sourceMap: flat } : {}),
    });
    for (const [file, entry] of Object.entries(data)) {
      const resolved = file.startsWith("file://")
        ? fileURLToPath(file)
        : path.resolve(root, file);
      if (!isAppSource(resolved)) continue;
      map.merge({ [resolved]: { ...entry, path: resolved } });
    }
  } catch {
    // Unmappable bundle — skip, never abort the report.
  }
}

async function loadNodeV8Dir(map, dir) {
  if (!existsSync(dir)) return 0;
  let added = 0;
  for (const name of await readdir(dir)) {
    if (!name.endsWith(".json")) continue;
    const raw = JSON.parse(await readFile(path.join(dir, name), "utf8"));
    for (const script of raw.result ?? []) {
      if (!script.url?.startsWith("file://")) continue;
      const file = fileURLToPath(script.url);
      const isBuilt =
        file.includes(`${path.sep}.next${path.sep}`) && file.endsWith(".js");
      if (!isBuilt && !isAppSource(file)) continue;
      const code = await readFile(file, "utf8").catch(() => null);
      if (!code) continue;
      const sourceMap = isBuilt
        ? await readFile(`${file}.map`, "utf8")
            .then(JSON.parse)
            .catch(() => null)
        : null;
      await addV8Script({
        map,
        url: pathToFileURL(file).href,
        code,
        functions: script.functions,
        ...(sourceMap ? { sourceMap } : {}),
      });
      added += 1;
    }
  }
  return added;
}

async function loadBrowserClient(map) {
  const file = path.join(BROWSER_DIR, "client-coverage.json");
  if (!existsSync(file)) return 0;
  const entries = JSON.parse(await readFile(file, "utf8"));
  let added = 0;
  for (const entry of entries) {
    await addV8Script({
      map,
      url: entry.url,
      code: entry.text,
      functions: entry.functions,
      ...(entry.sourceMap ? { sourceMap: entry.sourceMap } : {}),
    });
    added += 1;
  }
  return added;
}

function summarize(map) {
  const totals = {
    statements: [0, 0],
    branches: [0, 0],
    functions: [0, 0],
    lines: [0, 0],
  };
  for (const file of map.files()) {
    const s = map.fileCoverageFor(file).toSummary();
    for (const key of Object.keys(totals)) {
      totals[key][0] += s[key].covered;
      totals[key][1] += s[key].total;
    }
  }
  return totals;
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

    console.log("\n[2/3] browser UI suite with client coverage...");
    await mkdir(BROWSER_DIR, { recursive: true });
    const uiCode = await run("npm", ["run", "test:ui"], {
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
    ["browser", loadBrowserClient],
  ]) {
    const scripts = await load(map);
    const totals = summarize(map);
    const current = { files: map.files().length, covered: totals.statements[0] };
    stages.push({
      name,
      scripts,
      newFiles: current.files - previous.files,
      newStatements: current.covered - previous.covered,
    });
    previous = current;
  }
  for (const stage of stages) {
    console.log(
      `  ${stage.name.padEnd(8)}: ${String(stage.scripts).padStart(4)} scripts -> +${stage.newFiles} files, +${stage.newStatements} covered statements`,
    );
  }

  const empty = stages.filter((stage) => stage.scripts === 0);
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
  const pct = ([covered, total]) =>
    total ? ((100 * covered) / total).toFixed(2) : "0.00";
  console.log("\n=== COMBINED (unit + browser UI) over src/** ===");
  for (const [key, value] of Object.entries(totals)) {
    console.log(`  ${key.padEnd(11)} ${pct(value).padStart(6)}%  (${value[0]}/${value[1]})`);
  }
  const line = `✓ combined coverage · ${pct(totals.statements)}% statements · ${pct(totals.branches)}% branches · ${pct(totals.functions)}% functions · ${pct(totals.lines)}% lines`;
  console.log(`\n${line}`);
  console.log(`  files measured: ${map.files().length}`);
  console.log(`  html report   : ${path.relative(root, OUT)}/index.html`);
}

const entry = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (entry && import.meta.url === entry) await main();
