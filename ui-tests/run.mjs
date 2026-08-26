import { readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";
import { getBaseUrl } from "./config.mjs";
import { createReporter } from "./reporter.mjs";
import { startProdServer } from "../scripts/lib/prod-server.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

if (!process.env.UI_TEST_TIMEOUT_MS) {
  process.env.UI_TEST_TIMEOUT_MS = "90000";
}
if (!process.env.UI_TEST_SPEC_TIMEOUT_MS) {
  process.env.UI_TEST_SPEC_TIMEOUT_MS = "120000";
}
if (!process.env.UI_TEST_PROGRESS_MS) {
  process.env.UI_TEST_PROGRESS_MS = "10000";
}
// Box-trades is feature-flagged off by default; UI tests exercise it, so opt
// in for the build that the test server runs.
if (!process.env.NEXT_PUBLIC_DISPLAY_BOX_TRADES) {
  process.env.NEXT_PUBLIC_DISPLAY_BOX_TRADES = "true";
}
// Disable lazy auto-refresh during UI tests — it kicks off a full fetch-data
// run on /tools navigation which slows the suite and isn't what's under test.
if (!process.env.AUTO_REFRESH_DATA) {
  process.env.AUTO_REFRESH_DATA = "false";
}

// UI tests run against a production build by default. Set UI_TEST_BASE_URL or
// SNAPSHOT_TEST_BASE_URL to point at an existing server and skip the managed
// build/start lifecycle. UI_TEST_SKIP_BUILD=1 reuses the existing .next dir.
const EXTERNAL_BASE_URL =
  process.env.UI_TEST_BASE_URL ?? process.env.SNAPSHOT_TEST_BASE_URL ?? null;

function parseArgs(argv) {
  let grep = "";
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--grep" && argv[i + 1]) {
      grep = argv[i + 1];
      i++;
    }
  }
  return { grep };
}

async function loadSpecs() {
  const dir = join(__dirname, "specs");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".spec.mjs")).sort();
  /** @type {Array<{ name: string; tags: string[]; run: (ctx: unknown) => Promise<void> }>} */
  const specs = [];
  for (const file of files) {
    const mod = await import(join(dir, file));
    const name = mod.name ?? file.replace(/\.spec\.mjs$/, "");
    const run = mod.run;
    if (typeof run !== "function") {
      throw new Error(`${file}: expected export async function run(ctx)`);
    }
    const tags = Array.isArray(mod.tags)
      ? mod.tags.filter((t) => typeof t === "string")
      : [];
    specs.push({ name, tags, run });
  }
  return specs;
}

function selectedTags() {
  const raw = process.env.UI_TEST_TAGS ?? "";
  return raw
    .split(/[,\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

async function runSpecs(baseUrl) {
  const { grep } = parseArgs(process.argv);
  const tags = selectedTags();
  const specs = (await loadSpecs()).filter((s) => {
    if (grep && !s.name.includes(grep)) return false;
    if (tags.length === 0) return true;
    return tags.every((tag) => s.tags.includes(tag));
  });
  if (specs.length === 0) {
    console.error("No specs matched.");
    process.exitCode = 1;
    return;
  }

  const reporter = createReporter();
  // Default CDP callback timeout is 180s; heavy tool sims can stall the main thread longer than that
  // while waitForFunction polls, causing Runtime.callFunctionOn to fail unless raised or disabled.
  // GitHub-hosted runners (Ubuntu 24+) disable unprivileged user namespaces, so Chromium's sandbox
  // cannot start without --no-sandbox. Restrict that to CI so local runs keep the sandbox.
  const inCi = Boolean(process.env.CI || process.env.GITHUB_ACTIONS);
  const browser = await puppeteer.launch({
    headless: true,
    protocolTimeout: 0,
    args: inCi ? ["--no-sandbox", "--disable-setuid-sandbox"] : [],
  });
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET ?? "";
  const specTimeoutMs = Number(process.env.UI_TEST_SPEC_TIMEOUT_MS);
  const progressMs = Number(process.env.UI_TEST_PROGRESS_MS);
  const failFast = process.env.UI_TEST_FAIL_FAST !== "0";
  const t0 = Date.now();

  try {
    for (const [index, spec] of specs.entries()) {
      const page = await browser.newPage();
      if (bypass) {
        await page.setExtraHTTPHeaders({
          "x-vercel-protection-bypass": bypass,
          "x-vercel-set-bypass-cookie": "samesitenone",
        });
      }
      const started = Date.now();
      console.log(
        `[RUN] ${index + 1}/${specs.length} ${spec.name} (timeout ${specTimeoutMs}ms)...`,
      );
      const progress = setInterval(() => {
        const elapsed = Date.now() - started;
        console.log(`[WAIT] ${spec.name} still running after ${elapsed}ms at ${page.url()}`);
      }, progressMs);
      try {
        await withTimeout(
          spec.run({ browser, baseUrl, page }),
          specTimeoutMs,
          () => `Spec ${spec.name} exceeded ${specTimeoutMs}ms at ${page.url()}`,
        );
        reporter.add(spec.name, true, Date.now() - started);
      } catch (err) {
        const message = err instanceof Error ? err.stack ?? err.message : String(err);
        reporter.add(spec.name, false, Date.now() - started, message);
        if (failFast) {
          console.log(
            `[STOP] ${spec.name} failed; stopping early. Set UI_TEST_FAIL_FAST=0 to run every spec.`,
          );
          break;
        }
      } finally {
        clearInterval(progress);
        await page.close().catch(() => {});
      }
    }
  } finally {
    await browser.close();
  }

  const totalMs = Date.now() - t0;
  reporter.writeArtifacts(totalMs);
  reporter.printSummary(totalMs);

  const failed = reporter.getResults().some((r) => !r.ok);
  if (failed) process.exitCode = 1;
}

function withTimeout(promise, timeoutMs, message) {
  let timeout;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(message())), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timeout));
}

async function main() {
  if (EXTERNAL_BASE_URL) {
    console.log(`Using external server at ${EXTERNAL_BASE_URL}`);
    await runSpecs(getBaseUrl());
    return;
  }

  const server = await startProdServer();
  try {
    await runSpecs(server.baseUrl);
  } finally {
    await server.stop();
  }
}

await main();
