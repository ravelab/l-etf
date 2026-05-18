import { readFileSync } from "node:fs";
import { join } from "node:path";
import puppeteer from "puppeteer";
import { startProdServer } from "./lib/prod-server.mjs";

// Suppress the in-app /tools auto-refresh (it'd kick off a fetch-data run
// mid-test on dev machines with TIINGO + FRED keys configured, slowing the
// suite and potentially mutating data/ underneath us).
if (process.env.AUTO_REFRESH_DATA == null) {
  process.env.AUTO_REFRESH_DATA = "false";
}

// Snapshot tests run against a production build to avoid dev-server / Turbopack
// hydration flakiness. Set SNAPSHOT_TEST_BASE_URL to point at a server you
// already have running and skip the managed build/start lifecycle.
// SNAPSHOT_TEST_SKIP_BUILD=1 reuses the existing .next directory.
const EXTERNAL_BASE_URL = process.env.SNAPSHOT_TEST_BASE_URL ?? null;
let BASE_URL = EXTERNAL_BASE_URL ?? "http://127.0.0.1:3000";
const SNAPSHOT_DIR = join(process.cwd(), "src", "lib", "tool-snapshots");

// Performance knobs (overridable via env).
const CONCURRENCY = Number(process.env.SNAPSHOT_TEST_CONCURRENCY ?? 4);
const RETRIES = Number(process.env.SNAPSHOT_TEST_RETRIES ?? 1);
const RESULTS_WAIT_TIMEOUT_MS = Number(process.env.SNAPSHOT_TEST_TIMEOUT_MS ?? 180_000);
const STABILITY_TICKS = Number(process.env.SNAPSHOT_TEST_STABILITY_TICKS ?? 3);
const STABILITY_TICK_MS = Number(process.env.SNAPSHOT_TEST_STABILITY_TICK_MS ?? 250);

const PAGE_CONFIGS = [
  {
    pageKey: "compare-letfs",
    tab: "strategies",
    buildParams(pageState) {
      return withCommonParams(
        {
          sd: pageState.startDate,
          ed: pageState.endDate,
          py: pageState.windowLength,
          smaPsp: pageState.smaSpPeriod,
          smaPnq: pageState.smaNqPeriod,
          smatsp: pageState.smaSpBuffer,
          smatnq: pageState.smaNqBuffer,
          ro: pageState.riskOffAsset,
        },
        pageState
      );
    },
  },
  {
    pageKey: "compare-sma",
    tab: "sma-period",
    buildParams(pageState) {
      return withCommonParams(
        {
          preset: pageState.preset,
          sd: pageState.startDate,
          ed: pageState.endDate,
          py: pageState.windowLength,
          minP: pageState.minSmaPeriod,
          maxP: pageState.maxSmaPeriod,
          step: pageState.stepSize,
          smatsp: pageState.smaSpBuffer,
          smatnq: pageState.smaNqBuffer,
          ro: pageState.riskOffAsset,
        },
        pageState
      );
    },
  },
  {
    pageKey: "compare-threshold",
    tab: "sma-buffer",
    buildParams(pageState) {
      return withCommonParams(
        {
          preset: pageState.preset,
          sd: pageState.startDate,
          ed: pageState.endDate,
          py: pageState.windowLength,
          smaPsp: pageState.smaSpPeriod,
          smaPnq: pageState.smaNqPeriod,
          ro: pageState.riskOffAsset,
          minT: pageState.minBuffer,
          maxT: pageState.maxBuffer,
          stepT: pageState.bufferStep,
        },
        pageState
      );
    },
  },
  {
    pageKey: "compare-riskoff-assets",
    tab: "riskoff",
    buildParams(pageState) {
      return withCommonParams(
        {
          preset: pageState.preset,
          sd: pageState.startDate,
          ed: pageState.endDate,
          py: pageState.windowLength,
          smaPsp: pageState.smaSpPeriod,
          smaPnq: pageState.smaNqPeriod,
          smatsp: pageState.smaSpBuffer,
          smatnq: pageState.smaNqBuffer,
        },
        pageState
      );
    },
  },
  {
    pageKey: "statistical-analysis",
    tab: "statistics",
    buildParams(pageState) {
      return withCommonParams(
        {
          sd: pageState.startDate,
          ed: pageState.endDate,
          py: pageState.windowLength,
          smaPsp: pageState.smaSpPeriod,
          smaPnq: pageState.smaNqPeriod,
          smatsp: pageState.smaSpBuffer,
          smatnq: pageState.smaNqBuffer,
          ro: pageState.riskOffAsset,
          letf: pageState.letf,
        },
        pageState
      );
    },
  },
  {
    pageKey: "backtesting",
    tab: "backtest",
    buildParams(pageState) {
      const params = withCommonParams(
        {
          letf: pageState.letf || pageState.preset,
          sd: pageState.startDate,
          ed: pageState.endDate,
          smaPsp: pageState.smaSpPeriod,
          smaPnq: pageState.smaNqPeriod,
          smatsp: pageState.smaSpBuffer,
          smatnq: pageState.smaNqBuffer,
          ro: pageState.riskOffAsset,
        },
        pageState
      );
      if (pageState.etfConfigs && pageState.etfConfigs.length > 0) {
        pageState.etfConfigs.forEach((cfg, i) => {
          params.set(`e${i}_n`, cfg.name);
        });
      } else {
        const preset = pageState.letf || pageState.preset;
        if (preset === "UPRO+TQQQ") {
          params.set("e0_n", "UPRO");
          params.set("e1_n", "TQQQ");
        }
      }
      return params;
    },
  },
  {
    pageKey: "futures",
    tab: "futures",
    buildParams(pageState) {
      return withCommonParams(
        {
          sd: pageState.startDate,
          ed: pageState.endDate,
          py: pageState.windowLength,
          smaPsp: pageState.smaSpPeriod,
          smaPnq: pageState.smaNqPeriod,
          smatsp: pageState.smaSpBuffer,
          smatnq: pageState.smaNqBuffer,
          ro: pageState.riskOffAsset,
          amt: pageState.amount,
          lt: pageState.leverageTolerancePct,
        },
        pageState
      );
    },
  },
];

function withCommonParams(entries, pageState) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(entries)) {
    if (value == null) continue;
    params.set(key, String(value));
  }
  if (pageState.endDate) params.set("ed", pageState.endDate);
  if (pageState.historyWrap === false) params.set("tw", "0");
  params.set("autorun", "1");
  return params;
}

function readSnapshot(pageKey) {
  const snapshotPath = join(SNAPSHOT_DIR, `${pageKey}.json`);
  return JSON.parse(readFileSync(snapshotPath, "utf8"));
}

async function waitForResults(page) {
  page.setDefaultTimeout(RESULTS_WAIT_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(RESULTS_WAIT_TIMEOUT_MS);

  const debugBody = async (label) => {
    const url = page.url();
    const text = await page
      .evaluate(() => (document.body?.innerText ?? "").slice(0, 1200))
      .catch(() => "<unable to read body text>");
    throw new Error(`[${label}] ${url}\n\n${text}`);
  };

  // Single combined wait: sweep rows OR empty-state present AND no loading
  // text. Polled by puppeteer at chart-js's ~250ms tick; no hardcoded
  // initial sleep. The page hydrates and autoruns; we wait for the network
  // of states (no-data / has-rows) to settle into a non-loading state.
  try {
    await page.waitForFunction(
      function () {
        const text = document.body.innerText;
        const lower = text.toLowerCase();
        if (
          lower.includes("loading market data") ||
          lower.includes("running simulations") ||
          lower.includes("running strategy simulations") ||
          lower.includes("computing yearly growth") ||
          lower.includes("loading risk-off") ||
          lower.includes("preparing risk-off") ||
          lower.includes("preparing results") ||
          lower.includes("loading rates") ||
          lower.includes("loading inflation") ||
          text.includes("Cancel")
        ) {
          return false;
        }
        if (text.includes("No snapshot available") || text.includes("No valid simulations")) return true;
        const tables = document.querySelectorAll('table[data-testid^="snapshot-tool-sweep"]');
        for (const table of tables) {
          if (table.querySelectorAll("tbody tr").length > 0) return true;
        }
        return false;
      },
      { polling: 250 }
    );
  } catch {
    await debugBody("Timeout waiting for results");
  }

  // Run summary must exist and stabilize. Tightened from 6×500ms to a
  // configurable shorter window.
  try {
    await page.waitForFunction(
      () => Boolean(document.querySelector('[data-testid="simulation-run-summary"]')),
      { polling: 250 }
    );
  } catch {
    await debugBody("Timeout waiting for run summary element");
  }

  const deadline = Date.now() + Math.max(STABILITY_TICKS * STABILITY_TICK_MS * 4, 15_000);
  let last = "";
  let stable = 0;
  while (Date.now() < deadline) {
    const cur = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="simulation-run-summary"]');
      return el ? (el.textContent ?? "").replace(/\s+/g, " ").trim() : "";
    });
    const busy = !cur || /\b(Running|Loading|Cancel)\b/i.test(cur);
    if (!busy && cur === last) {
      stable += 1;
      if (stable >= STABILITY_TICKS) break;
    } else {
      stable = 0;
    }
    last = cur;
    await new Promise((r) => setTimeout(r, STABILITY_TICK_MS));
  }
  if (stable < STABILITY_TICKS) {
    await debugBody("Run summary did not stabilize");
  }
}

async function extractRenderable(page) {
  return page.evaluate(() => {
    const normalize = (value) => (value ?? "")
      .replace(/\d+([.,]\d+)*/g, "#")
      .replace(/\s+/g, " ")
      .trim();
    const summaryEl = document.querySelector('[data-testid="simulation-run-summary"]');
    const runSummary = summaryEl ? normalize(summaryEl.textContent) : null;
    const rows = [];
    document.querySelectorAll('table[data-testid^="snapshot-tool-sweep"]').forEach((table) => {
      for (const row of table.querySelectorAll("tbody tr")) {
        rows.push(
          Array.from(row.querySelectorAll("td,th"))
            .map((cell) => normalize(cell.textContent))
            .join(" | ")
        );
      }
    });
    rows.sort();
    return { runSummary, rows };
  });
}

async function openIsolatedPage(browser, url) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  // Clear localStorage to prevent stale state interference.
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.clear());
  if (process.env.DEBUG_SNAPSHOTS) {
    page.on("response", async (response) => {
      const u = response.url();
      if (u.includes("/api/prices") || u.includes("/api/interest-rates")) {
        try {
          const data = await response.json();
          if (Array.isArray(data) && data.length > 0) {
            console.error(`  [API DEBUG] ${u.split("?")[1] || u}`);
            console.error(`    Count: ${data.length}`);
            console.error(`    First: ${JSON.stringify(data[0])}`);
            console.error(`    Last:  ${JSON.stringify(data[data.length - 1])}`);
          }
        } catch {
          // ignore
        }
      }
    });
  }
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await waitForResults(page);
  return { context, page };
}

function buildToolUrl(tab, params) {
  const nextParams = new URLSearchParams(params ? params.toString() : "");
  nextParams.set("tab", tab);
  return `${BASE_URL}/tools?${nextParams.toString()}`;
}

function describeDiff(snapshotState, liveState) {
  if (snapshotState.rows.length !== liveState.rows.length) {
    return [
      "Row count mismatch",
      `snapshot rows: ${snapshotState.rows.length}`,
      `live rows: ${liveState.rows.length}`,
      "",
      "Run summary (snapshot):",
      `${snapshotState.runSummary ?? "<null>"}`,
      "",
      "Run summary (live):",
      `${liveState.runSummary ?? "<null>"}`,
    ].join("\n");
  }
  const firstDiffIndex = snapshotState.rows.findIndex((row, index) => row !== liveState.rows[index]);
  if (firstDiffIndex >= 0) {
    return [
      `First row mismatch at index ${firstDiffIndex}`,
      `snapshot: ${snapshotState.rows[firstDiffIndex]}`,
      `live: ${liveState.rows[firstDiffIndex]}`,
    ].join("\n");
  }
  return "Unknown mismatch";
}

async function verifyOnce(browser, config) {
  const snapshot = readSnapshot(config.pageKey);
  const snapshotUrl = buildToolUrl(config.tab);
  const liveUrl = buildToolUrl(config.tab, config.buildParams(snapshot.pageState));

  let snapshotState;
  let liveState;

  const snapshotSession = await openIsolatedPage(browser, snapshotUrl);
  try {
    snapshotState = await extractRenderable(snapshotSession.page);
  } finally {
    await snapshotSession.context.close();
  }

  const liveSession = await openIsolatedPage(browser, liveUrl);
  try {
    liveState = await extractRenderable(liveSession.page);
  } finally {
    await liveSession.context.close();
  }

  const sameRows =
    snapshotState.rows.length === liveState.rows.length &&
    snapshotState.rows.every((row, index) => row === liveState.rows[index]);

  if (!sameRows) {
    const message = describeDiff(snapshotState, liveState);
    throw new Error(
      `${message}\n\nSnapshot URL: ${snapshotUrl}\nLive URL:     ${liveUrl}`,
    );
  }

  return { snapshotEndDate: snapshot.snapshotEndDate };
}

async function verifyPage(browser, config) {
  const start = Date.now();
  let lastError;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const { snapshotEndDate } = await verifyOnce(browser, config);
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      const retryNote = attempt > 0 ? ` (retry ${attempt})` : "";
      console.log(`OK ${config.pageKey} (${snapshotEndDate}) — ${elapsed}s${retryNote}`);
      return true;
    } catch (error) {
      lastError = error;
      if (attempt < RETRIES) {
        console.log(`RETRY ${config.pageKey} (attempt ${attempt + 1} failed: ${error.message.split("\n")[0]})`);
      }
    }
  }
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  console.error(`FAIL ${config.pageKey} — ${elapsed}s\n${message}\n`);
  return false;
}

/**
 * Drain a queue of jobs through a fixed-size worker pool. Each worker pulls
 * the next job and runs it; the pool resolves when the queue is empty.
 */
async function runWithConcurrency(items, worker, concurrency) {
  let cursor = 0;
  const results = new Array(items.length);
  const next = async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, next));
  return results;
}

async function runVerification() {
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  try {
    const start = Date.now();
    const results = await runWithConcurrency(
      PAGE_CONFIGS,
      (config) => verifyPage(browser, config),
      CONCURRENCY,
    );
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const failed = results.filter((ok) => !ok).length;
    if (failed > 0) {
      console.error(`\n${failed} / ${results.length} snapshot test(s) failed — ${elapsed}s total`);
      process.exitCode = 1;
    } else {
      console.log(`\nAll ${results.length} snapshots match UI-generated results — ${elapsed}s total`);
    }
  } finally {
    await browser.close();
  }
}

async function main() {
  if (EXTERNAL_BASE_URL) {
    console.log(`Using external server at ${EXTERNAL_BASE_URL}`);
    BASE_URL = EXTERNAL_BASE_URL;
    await runVerification();
    return;
  }
  const server = await startProdServer();
  BASE_URL = server.baseUrl;
  try {
    await runVerification();
  } finally {
    await server.stop();
  }
}

await main();
