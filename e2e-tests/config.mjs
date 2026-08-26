/**
 * Shared Puppeteer waits and URL defaults for E2E browser tests.
 * Env: E2E_TEST_BASE_URL or SNAPSHOT_TEST_BASE_URL (default http://127.0.0.1:3000)
 */

export function getBaseUrl() {
  return (
    process.env.E2E_TEST_BASE_URL ??
    process.env.SNAPSHOT_TEST_BASE_URL ??
    "http://127.0.0.1:3000"
  );
}

/** Headers for fetch() against a Vercel-protected preview. */
export function vercelBypassHeaders() {
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (!bypass) return {};
  return {
    "x-vercel-protection-bypass": bypass,
    "x-vercel-set-bypass-cookie": "samesitenone",
  };
}

/**
 * fetch() that can reach Vercel SSO-protected preview URLs.
 *
 * Do not also send `x-vercel-set-bypass-cookie` here: undici follows the 307 to
 * `/` and loops. The query-string bypass is enough for one-shot API GETs.
 * Puppeteer navigations still use the header form via setExtraHTTPHeaders.
 */
export function fetchWithVercelBypass(url, init = {}) {
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  let finalUrl = url;
  if (bypass) {
    const parsed = new URL(url);
    parsed.searchParams.set("x-vercel-protection-bypass", bypass);
    finalUrl = parsed.toString();
  }
  return fetch(finalUrl, init);
}

function isContextDestroyed(err) {
  const message = err instanceof Error ? err.message : String(err);
  return /Execution context was destroyed|Cannot find context|Target closed|Navigating frame/i.test(
    message,
  );
}

/**
 * Retry page.evaluate / waitForFunction when a soft navigation tears down the
 * isolated world mid-wait (common on tool pages that router.replace after load).
 * @template T
 * @param {(timeoutMs: number) => Promise<T>} fn
 * @param {{ deadlineMs: number; pauseMs?: number }} opts
 * @returns {Promise<T>}
 */
async function withNavigationRetry(fn, opts) {
  const pauseMs = opts.pauseMs ?? 250;
  const deadline = Date.now() + opts.deadlineMs;
  let lastErr;
  while (Date.now() < deadline) {
    const remaining = Math.max(500, deadline - Date.now());
    try {
      return await fn(remaining);
    } catch (err) {
      lastErr = err;
      if (!isContextDestroyed(err) || Date.now() + pauseMs >= deadline) throw err;
      await new Promise((r) => setTimeout(r, pauseMs));
    }
  }
  throw lastErr;
}

/** @param {import('puppeteer').Page} page */
export function applyDefaultTimeouts(page) {
  const timeoutMs = Number(process.env.E2E_TEST_TIMEOUT_MS ?? 90000);
  page.setDefaultTimeout(timeoutMs);
  page.setDefaultNavigationTimeout(timeoutMs);
}

/**
 * Navigate with `load` (not `domcontentloaded`) so the JS bundle runs before we wait on async tool simulations.
 * @param {import('puppeteer').Page} page
 * @param {string} url
 */
export async function gotoUi(page, url) {
  applyDefaultTimeouts(page);
  const waitMs = Number(process.env.E2E_TEST_TIMEOUT_MS ?? 90000);
  console.log(`[NAV] ${url}`);
  await page.goto(url, { waitUntil: "load", timeout: waitMs });
  // Tool pages often router.replace once snapshot/query state settles; wait for
  // that hop so waitForFunction is not bound to a dying execution context.
  await page
    .waitForNetworkIdle({ idleTime: 500, timeout: Math.min(waitMs, 15000) })
    .catch(() => {});
  console.log(`[NAV] loaded ${page.url()}`);
}

/**
 * Wait until sweep tables have rows or empty state, simulation finished, run summary exists and text stabilizes.
 * Adapted from scripts/test-snapshots.mjs.
 * @param {import('puppeteer').Page} page
 * @param {{ requireSweepTable?: boolean; timeoutMs?: number }} [options]
 *   When `requireSweepTable` is false (e.g. statistics / backtest tabs), readiness is satisfied when the run
 *   summary has substantial non-busy text even if no `snapshot-tool-sweep` tables exist.
 */
export async function waitForRunSummaryStable(page, options = {}) {
  const requireSweepTable = options.requireSweepTable !== false;
  applyDefaultTimeouts(page);
  const waitMs = Number(options.timeoutMs ?? process.env.E2E_TEST_TIMEOUT_MS ?? 90000);

  const debugBody = async (label) => {
    const url = page.url();
    const text = await withNavigationRetry(async () =>
      page.evaluate(function () {
        return (document.body?.innerText ?? "").slice(0, 1200);
      }),
      { deadlineMs: 10000 },
    ).catch(() => "<unable to read body text>");
    throw new Error(`[${label}] ${url}\n\n${text}`);
  };

  /** Mirrors scripts/test-snapshots.mjs: sweep rows (or non-sweep summary) can appear while fetch/sim text is still visible — do not gate phase 1 on “loading”. */
  const phase1Predicate = function (requireSweep) {
    const text = document.body.innerText;
    if (text.includes("No snapshot available") || text.includes("No valid simulations")) return true;
    if (requireSweep) {
      const tables = document.querySelectorAll('table[data-testid^="snapshot-tool-sweep"]');
      for (const table of tables) {
        if (table.querySelectorAll("tbody tr").length > 0) return true;
      }
      return false;
    }
    const el = document.querySelector('[data-testid="simulation-run-summary"]');
    const raw = el ? (el.textContent ?? "").replace(/\s+/g, " ").trim() : "";
    return raw.length >= 50;
  };

  try {
    console.log(
      `[WAIT] summary phase 1 (${requireSweepTable ? "sweep rows" : "summary text"}) at ${page.url()}`,
    );
    await withNavigationRetry(
      (timeout) => page.waitForFunction(phase1Predicate, { timeout }, requireSweepTable),
      { deadlineMs: waitMs },
    );
    console.log("[WAIT] summary phase 1 complete");
  } catch {
    await new Promise((r) => setTimeout(r, 5000));
    const recovered = await withNavigationRetry(
      async () => page.evaluate(phase1Predicate, requireSweepTable),
      { deadlineMs: 15000 },
    );
    if (!recovered) {
      await debugBody(
        requireSweepTable
          ? "Timeout waiting for sweep rows / empty state"
          : "Timeout waiting for run summary (non-sweep tab)",
      );
    }
  }

  /** Phase 2: simulation finished — avoid matching result-table percentages (see test-snapshots “%” pitfall). */
  const phase2Predicate = function () {
    const text = document.body.innerText;
    const lower = text.toLowerCase();
    const loading =
      lower.includes("loading market data") ||
      lower.includes("running simulations") ||
      lower.includes("running strategy simulations") ||
      lower.includes("computing yearly growth") ||
      lower.includes("loading risk-off") ||
      lower.includes("preparing risk-off") ||
      lower.includes("preparing results") ||
      lower.includes("loading rates") ||
      lower.includes("loading inflation") ||
      text.includes("Cancel");
    return !loading;
  };

  try {
    console.log(`[WAIT] summary phase 2 (not busy) at ${page.url()}`);
    await withNavigationRetry(
      (timeout) => page.waitForFunction(phase2Predicate, { timeout }),
      { deadlineMs: waitMs },
    );
    console.log("[WAIT] summary phase 2 complete");
  } catch {
    await new Promise((r) => setTimeout(r, 5000));
    const recovered = await withNavigationRetry(async () => page.evaluate(phase2Predicate), {
      deadlineMs: 15000,
    });
    if (!recovered) await debugBody("Timeout waiting for simulation to finish");
  }

  try {
    console.log(`[WAIT] summary element at ${page.url()}`);
    await withNavigationRetry(
      (timeout) =>
        page.waitForFunction(
          function () {
            return Boolean(document.querySelector('[data-testid="simulation-run-summary"]'));
          },
          { timeout },
        ),
      { deadlineMs: waitMs },
    );
    console.log("[WAIT] summary element found");
  } catch {
    await debugBody("Timeout waiting for run summary element");
  }

  const stableMs = Number(process.env.E2E_TEST_SUMMARY_STABLE_MS ?? 500);
  const stableTicks = Number(process.env.E2E_TEST_SUMMARY_STABLE_TICKS ?? 6);
  const deadline = Date.now() + Number(process.env.E2E_TEST_SUMMARY_DEADLINE_MS ?? 30000);
  let last = "";
  let stable = 0;
  console.log(
    `[WAIT] summary stability (${stableTicks} ticks, ${stableMs}ms each) at ${page.url()}`,
  );
  while (Date.now() < deadline) {
    const cur = await withNavigationRetry(
      async () =>
        page.evaluate(function () {
          const el = document.querySelector('[data-testid="simulation-run-summary"]');
          return el ? (el.textContent ?? "").replace(/\s+/g, " ").trim() : "";
        }),
      { deadlineMs: 10000 },
    );
    const busy = !cur || /\b(Running|Loading|Cancel)\b/i.test(cur);
    if (!busy && cur === last) {
      stable += 1;
      if (stable >= stableTicks) break;
    } else {
      stable = 0;
    }
    last = cur;
    await new Promise((r) => setTimeout(r, stableMs));
  }

  if (stable < stableTicks) {
    await debugBody("Run summary did not stabilize");
  }
  console.log("[WAIT] summary stable");
}

/**
 * @param {import('puppeteer').Page} page
 * @returns {Promise<string>}
 */
export async function normalizedRunSummaryText(page) {
  return withNavigationRetry(
    async () =>
      page.evaluate(function () {
        const el = document.querySelector('[data-testid="simulation-run-summary"]');
        const raw = el ? (el.textContent ?? "") : "";
        return raw.replace(/\s+/g, " ").trim();
      }),
    { deadlineMs: 15000 },
  );
}
