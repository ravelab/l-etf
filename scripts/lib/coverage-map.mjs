/**
 * Shared V8 → Istanbul mapping over src/** for unit and combined coverage.
 * Unloaded app sources are filled as 0% so percentages are overall, not
 * "only the files the suite happened to import".
 */
import { readFile, readdir } from "node:fs/promises";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { convert } from "ast-v8-to-istanbul";
import { parseAstAsync } from "vite";
import { transformSync } from "esbuild";
import { decode, encode } from "@jridgewell/sourcemap-codec";

export const root = process.cwd();

export function isAppSource(file) {
  if (!file) return false;
  const rel = path.relative(root, file);
  return (
    rel.startsWith("src" + path.sep) &&
    /\.(ts|tsx|js|jsx|mjs)$/.test(rel) &&
    !rel.includes(`${path.sep}node_modules${path.sep}`) &&
    !/\.d\.ts$/.test(rel)
  );
}

export function listSrcFiles() {
  const out = [];
  const stack = [path.join(root, "src")];
  while (stack.length) {
    const dir = stack.pop();
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) stack.push(full);
      else if (isAppSource(full)) out.push(full);
    }
  }
  return out.sort();
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

function rewriteSourceMapPaths(map) {
  if (!map) return map;
  const rewrite = (source) => {
    if (typeof source !== "string") return source;
    const project = source.match(/^turbopack:\/\/\/\[project\]\/(.*)$/);
    if (project) return path.join(root, project[1]);
    const webpack = source.match(/^webpack:\/\/\/?(?:\.[/\\])?(.*)$/);
    if (webpack) return path.join(root, webpack[1].replace(/^\/+/, ""));
    return source;
  };
  if (Array.isArray(map.sources)) {
    return { ...map, sources: map.sources.map(rewrite) };
  }
  if (Array.isArray(map.sections)) {
    return {
      ...map,
      sections: map.sections.map((section) =>
        section.map
          ? { ...section, map: rewriteSourceMapPaths(section.map) }
          : section,
      ),
    };
  }
  return map;
}

/**
 * @param {{ map: import("istanbul-lib-coverage").CoverageMap, url: string, code: string, functions?: unknown[], sourceMap?: unknown }} args
 */
export async function addV8Script({ map, url, code, functions, sourceMap }) {
  if (!code || !Array.isArray(functions)) return;
  try {
    const flat = rewriteSourceMapPaths(flattenSourceMap(sourceMap));
    const fileUrl = url.startsWith("file://")
      ? url
      : pathToFileURL(
          path.join(root, ".next", "v8", encodeURIComponent(url).slice(-120)),
        ).href;
    let parseCode = code;
    if (/\.[cm]?tsx?$/i.test(fileUrl) || /\.[cm]?tsx?$/i.test(url)) {
      const loader = /\.tsx$/i.test(fileUrl) || /\.tsx$/i.test(url) ? "tsx" : "ts";
      parseCode = transformSync(code, { loader, format: "esm", sourcemap: false }).code;
    }
    const data = await convert({
      code: parseCode,
      ast: await parseAstAsync(parseCode),
      wrapperLength: 0,
      coverage: { scriptId: "0", url: fileUrl, functions },
      ...(flat ? { sourceMap: flat } : {}),
    });
    for (const [file, entry] of Object.entries(data)) {
      let resolved = file.startsWith("file://")
        ? fileURLToPath(file)
        : path.resolve(root, file);
      const glued = resolved.match(/\[project\][\\/](.*)$/);
      if (glued) resolved = path.join(root, glued[1]);
      if (!isAppSource(resolved)) continue;
      map.merge({ [resolved]: { ...entry, path: resolved } });
    }
  } catch {
    // Unmappable — skip.
  }
}

export async function loadNodeV8Dir(map, dir) {
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
        functions: script.functions ?? [],
        ...(sourceMap ? { sourceMap } : {}),
      });
      added += 1;
    }
  }
  return added;
}

/** Add every src/** file not already in the map as 0% coverage. */
export async function fillUncoveredSrcFiles(map) {
  const present = new Set(map.files());
  let filled = 0;
  for (const file of listSrcFiles()) {
    if (present.has(file)) continue;
    const code = await readFile(file, "utf8").catch(() => null);
    if (!code) continue;
    await addV8Script({
      map,
      url: pathToFileURL(file).href,
      code,
      functions: [],
    });
    if (map.files().includes(file) || map.data?.[file]) filled += 1;
    present.add(file);
  }
  return filled;
}

export function summarize(map) {
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

export function pct([covered, total]) {
  return total ? ((100 * covered) / total).toFixed(2) : "0.00";
}

export function formatCoverageLine(label, totals) {
  return (
    `✓ ${label} · ${pct(totals.statements)}% statements · ${pct(totals.branches)}% branches · ` +
    `${pct(totals.functions)}% functions · ${pct(totals.lines)}% lines`
  );
}

/** Merge an Istanbul coverage-final.json (e.g. Vitest V8) into the map. */
export async function loadIstanbulJson(map, file) {
  if (!existsSync(file)) return 0;
  const raw = JSON.parse(await readFile(file, "utf8"));
  const before = map.files().length;
  map.merge(raw);
  return map.files().length - before;
}
