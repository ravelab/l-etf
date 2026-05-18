import test from "node:test";
import assert from "node:assert/strict";
import {
  hasMeaningfulSearchParams,
  canonicalNormalizedToolsHrefKey,
  buildToolsUrl,
  getToolTabForPathname,
  shouldQueueToolAutorun
} from "../src/lib/tools-route";

test("hasMeaningfulSearchParams ignores tab and autorun", () => {
  assert.equal(hasMeaningfulSearchParams(new URLSearchParams("tab=backtest")), false);
  assert.equal(hasMeaningfulSearchParams(new URLSearchParams("autorun=1")), false);
  assert.equal(hasMeaningfulSearchParams(new URLSearchParams("sd=2020-01-01")), true);
});

test("buildToolsUrl creates correct paths", () => {
  const params = new URLSearchParams("sd=2020-01-01");
  const url = buildToolsUrl("backtest", params);
  assert.equal(url, "/tools?tab=backtest&sd=2020-01-01");
  
  const urlAuto = buildToolsUrl("strategies", params, { autorun: true });
  assert.equal(urlAuto, "/tools?tab=strategies&autorun=1&sd=2020-01-01");
});

test("canonicalNormalizedToolsHrefKey normalizes legacy routes", () => {
  const params = new URLSearchParams("sd=2020-01-01");
  // /compare-letfs maps to 'strategies' tab
  const key = canonicalNormalizedToolsHrefKey("/compare-letfs", params);
  const u = new URL(key, "http://localhost");
  assert.equal(u.pathname, "/tools");
  assert.equal(u.searchParams.get("tab"), "strategies");
  assert.equal(u.searchParams.get("sd"), "2020-01-01");
});

test("getToolTabForPathname maps correctly", () => {
  assert.equal(getToolTabForPathname("/compare-letfs"), "strategies");
  assert.equal(getToolTabForPathname("/backtesting-tool"), "backtest");
  assert.equal(getToolTabForPathname("/invalid"), null);
});

test("shouldQueueToolAutorun runs explicit URL params even when cache exists", () => {
  assert.equal(
    shouldQueueToolAutorun(
      new URLSearchParams("tab=strategies&sd=2000-03-27"),
      {
        allowInitialSearchAutoRun: true,
        suppressAutoRun: false,
        shouldAutoRunFromSearch: () => true,
        hasCachedResults: true,
      },
      "/tools"
    ),
    true
  );
});

test("shouldQueueToolAutorun ignores tab-only navigation", () => {
  assert.equal(
    shouldQueueToolAutorun(
      new URLSearchParams("tab=strategies"),
      {
        allowInitialSearchAutoRun: true,
        suppressAutoRun: false,
        shouldAutoRunFromSearch: () => true,
        hasCachedResults: false,
      },
      "/tools"
    ),
    false
  );
});
