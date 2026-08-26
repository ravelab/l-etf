/**
 * Chrome V8 JS coverage for the Puppeteer browser suite.
 * Nothing instruments the shipped bundles, so we record what Chrome actually ran
 * and fetch each script's source map while the origin is still reachable.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** @param {import("puppeteer").Page} page */
export async function startPageJsCoverage(page) {
  await page.coverage
    .startJSCoverage({ includeRawScriptCoverage: true, resetOnNavigation: false })
    .catch(() => {});
}

/**
 * @param {import("puppeteer").Page[]} pages
 * @param {{ outDir: string, fetchHeaders?: Record<string, string> }} opts
 */
export async function collectPagesJsCoverage(pages, { outDir, fetchHeaders = {} }) {
  await mkdir(outDir, { recursive: true });
  const entries = [];
  for (const page of pages) {
    if (page.isClosed()) continue;
    try {
      const result = await page.coverage.stopJSCoverage();
      for (const item of result) {
        if (!item.url || !item.url.startsWith("http")) continue;
        const marker = /\/\/# sourceMappingURL=(.+)\s*$/m.exec(item.text ?? "");
        let sourceMap = null;
        if (marker) {
          const mapUrl = new URL(marker[1].trim(), item.url).href;
          sourceMap = await fetch(mapUrl, { headers: fetchHeaders })
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null);
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
  }
  const outFile = path.join(outDir, "client-coverage.json");
  await writeFile(outFile, JSON.stringify(entries), "utf8");
  process.stdout.write(`- browser coverage: ${entries.length} scripts -> ${outDir}\n`);
  return entries.length;
}
