import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createReporter() {
  /** @type {Array<{ name: string; ok: boolean; ms: number; error?: string }>} */
  const results = [];

  return {
    /**
     * @param {string} name
     * @param {boolean} ok
     * @param {number} ms
     * @param {string} [error]
     */
    add(name, ok, ms, error) {
      results.push({ name, ok, ms, error });
      if (ok) {
        console.log(`[PASS] ${name} (${ms}ms)`);
      } else {
        console.log(`[FAIL] ${name}`);
        if (error) console.error(error);
      }
    },

    getResults() {
      return results;
    },

    /**
     * @param {number} totalMs
     */
    writeArtifacts(totalMs) {
      const passed = results.filter((r) => r.ok).length;
      const failed = results.length - passed;
      const jsonPath = join(__dirname, "last-run.json");
      const htmlPath = join(__dirname, "report.html");

      writeFileSync(
        jsonPath,
        JSON.stringify(
          {
            totalMs,
            passed,
            failed,
            tests: results.map((r) => ({
              name: r.name,
              ok: r.ok,
              ms: r.ms,
              error: r.error ?? null,
            })),
          },
          null,
          2
        ),
        "utf8"
      );

      const rows = results
        .map(
          (r) =>
            `<tr class="${r.ok ? "ok" : "fail"}"><td>${escapeHtml(r.name)}</td><td>${r.ok ? "PASS" : "FAIL"}</td><td>${r.ms}</td></tr>`
        )
        .join("\n");

      const errors = results
        .filter((r) => !r.ok && r.error)
        .map((r) => `<h3>${escapeHtml(r.name)}</h3><pre>${escapeHtml(r.error ?? "")}</pre>`)
        .join("\n");

      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>UI tests</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 1.5rem; background: #0a0a0a; color: #e4e4e7; }
    table { border-collapse: collapse; width: 100%; max-width: 56rem; }
    th, td { border: 1px solid #3f3f46; padding: 0.5rem 0.75rem; text-align: left; }
    tr.ok { background: #052e16; }
    tr.fail { background: #450a0a; }
    pre { white-space: pre-wrap; background: #18181b; padding: 1rem; border-radius: 6px; overflow: auto; }
    .summary { margin-bottom: 1rem; font-size: 1.1rem; }
  </style>
</head>
<body>
  <p class="summary">${passed} passed, ${failed} failed in ${(totalMs / 1000).toFixed(2)}s</p>
  <table>
    <thead><tr><th>Name</th><th>Result</th><th>ms</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  ${errors ? `<h2>Errors</h2>${errors}` : ""}
</body>
</html>`;

      writeFileSync(htmlPath, html, "utf8");
    },

    printSummary(totalMs) {
      const passed = results.filter((r) => r.ok).length;
      const failed = results.length - passed;
      console.log(`${passed} passed, ${failed} failed in ${(totalMs / 1000).toFixed(2)}s`);
    },
  };
}

function escapeHtml(s) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
