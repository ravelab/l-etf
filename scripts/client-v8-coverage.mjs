/**
 * Chrome V8 JS coverage for the Puppeteer browser suite.
 * Nothing instruments the shipped bundles, so we record what Chrome actually ran
 * and fetch each script's source map while the origin is still reachable.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** @typedef {{ url: string, text?: string, functions: unknown[], sourceMap: unknown }} CoverageEntry */

/** @param {import("puppeteer").Page} page */
export async function startPageJsCoverage(page) {
  await page.coverage
    .startJSCoverage({ includeRawScriptCoverage: true, resetOnNavigation: false })
    .catch(() => {});
}

/**
 * Stop coverage on one page, fetch source maps, return entries.
 * Call this before closing the page so navigations on later specs stay isolated.
 *
 * @param {import("puppeteer").Page} page
 * @param {{ fetchHeaders?: Record<string, string> }} [opts]
 * @returns {Promise<CoverageEntry[]>}
 */
export async function harvestPageJsCoverage(page, { fetchHeaders = {} } = {}) {
  /** @type {CoverageEntry[]} */
  const entries = [];
  if (page.isClosed()) return entries;
  try {
    const result = await page.coverage.stopJSCoverage();
    for (const item of result) {
      if (!item.url || !item.url.startsWith("http")) continue;
      const marker = /\/\/# sourceMappingURL=(.+)\s*$/m.exec(item.text ?? "");
      let sourceMap = null;
      const mapCandidates = [];
      if (marker) {
        mapCandidates.push(new URL(marker[1].trim(), item.url).href);
      }
      // Next production builds often omit the footer comment even when
      // productionBrowserSourceMaps emitted a sibling `.map`.
      if (item.url.includes("/_next/") && item.url.includes(".js")) {
        mapCandidates.push(`${item.url.split("?")[0]}.map`);
      }
      for (const mapUrl of mapCandidates) {
        sourceMap = await fetch(mapUrl, { headers: fetchHeaders })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null);
        if (sourceMap) break;
      }
      entries.push({
        url: item.url,
        text: item.text,
        functions: item.rawScriptCoverage?.functions ?? [],
        sourceMap,
      });
    }
  } catch {
    // Page already torn down.
  }
  return entries;
}

/**
 * @param {CoverageEntry[]} entries
 * @param {string} outDir
 */
export async function writeBrowserCoverage(entries, outDir) {
  await mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, "client-coverage.json");
  await writeFile(outFile, JSON.stringify(entries), "utf8");
  process.stdout.write(`- browser coverage: ${entries.length} scripts -> ${outDir}\n`);
}
