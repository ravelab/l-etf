import test from "node:test";
import assert from "node:assert/strict";
import {
  hasMeaningfulSearchParams,
  canonicalNormalizedToolsHrefKey,
  buildToolsUrl,
  getToolTabForPathname,
  shouldQueueToolAutorun,
  persistedToolStateMatchesUrl,
  requestToolAutorunSuppressForHistoryHref,
  TOOL_TABS,
  DEFAULT_TOOL_TAB,
} from "../src/lib/tools-route";

test("hasMeaningfulSearchParams ignores tab and autorun", () => {
  assert.equal(hasMeaningfulSearchParams(new URLSearchParams("tab=backtest")), false);
  assert.equal(hasMeaningfulSearchParams(new URLSearchParams("autorun=1")), false);
  assert.equal(hasMeaningfulSearchParams(new URLSearchParams("sd=2020-01-01")), true);
  assert.equal(hasMeaningfulSearchParams({ sd: "2020-01-01", tab: "strategies" }), true);
  assert.equal(hasMeaningfulSearchParams("sd=2020-01-01"), true);
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
  const key = canonicalNormalizedToolsHrefKey("/compare-letfs", params);
  const u = new URL(key, "http://localhost");
  assert.equal(u.pathname, "/tools");
  assert.equal(u.searchParams.get("tab"), "strategies");
  assert.equal(u.searchParams.get("sd"), "2020-01-01");
});

test("getToolTabForPathname maps every legacy tool page", () => {
  assert.equal(getToolTabForPathname("/compare-letfs"), "strategies");
  assert.equal(getToolTabForPathname("/compare-sma-strategies"), "sma-period");
  assert.equal(getToolTabForPathname("/compare-threshold-strategies"), "sma-buffer");
  assert.equal(getToolTabForPathname("/compare-riskoff-assets"), "riskoff");
  assert.equal(getToolTabForPathname("/statistical-analysis"), "statistics");
  assert.equal(getToolTabForPathname("/backtesting-tool"), "backtest");
  assert.equal(getToolTabForPathname("/futures-tool"), "futures");
  assert.equal(getToolTabForPathname("/invalid"), null);
  assert.equal(DEFAULT_TOOL_TAB, "strategies");
  assert.ok(TOOL_TABS.includes("futures"));
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

test("shouldQueueToolAutorun suppresses history replays until the URL changes", () => {
  const params = new URLSearchParams("tab=strategies&sd=2020-01-01");
  const href = canonicalNormalizedToolsHrefKey("/tools", params);
  requestToolAutorunSuppressForHistoryHref(href);
  assert.equal(
    shouldQueueToolAutorun(
      params,
      {
        allowInitialSearchAutoRun: true,
        suppressAutoRun: false,
        shouldAutoRunFromSearch: () => true,
        hasCachedResults: false,
      },
      "/tools"
    ),
    false,
  );
  assert.equal(
    shouldQueueToolAutorun(
      new URLSearchParams("tab=strategies&sd=2020-01-01&autorun=1"),
      {
        allowInitialSearchAutoRun: true,
        suppressAutoRun: false,
        shouldAutoRunFromSearch: () => true,
        hasCachedResults: false,
      },
      "/tools"
    ),
    true,
  );
});

test("persistedToolStateMatchesUrl requires every present URL field to agree", () => {
  const state = {
    letf: "UPRO",
    startDate: "2000-01-01",
    endDate: "2020-01-01",
    windowLength: 10,
    smaSpPeriod: 200,
    smaNqPeriod: 150,
    smaSpUpperBuffer: 3,
    smaSpLowerBuffer: 3,
    smaNqUpperBuffer: 5,
    smaNqLowerBuffer: 5,
    riskOffAsset: "SGOV",
    leverageTolerancePct: 2,
  };
  assert.equal(
    persistedToolStateMatchesUrl(state, new URLSearchParams("letf=UPRO&sd=2000-01-01&ed=2020-01-01&py=10&ro=SGOV")),
    true,
  );
  assert.equal(
    persistedToolStateMatchesUrl(state, new URLSearchParams("letf=TQQQ&sd=2000-01-01")),
    false,
  );
  assert.equal(
    persistedToolStateMatchesUrl(state, new URLSearchParams("sd=2000-01-01&ro=GLDM")),
    false,
  );
  assert.equal(
    persistedToolStateMatchesUrl(state, new URLSearchParams("sd=2000-01-01&py=5")),
    false,
  );
  assert.equal(
    persistedToolStateMatchesUrl(state, new URLSearchParams("preset=UPRO&sd=2000-01-01")),
    true,
  );
  assert.equal(
    persistedToolStateMatchesUrl(state, new URLSearchParams("sd=2000-01-01&lt=2")),
    true,
  );
  assert.equal(
    persistedToolStateMatchesUrl(state, new URLSearchParams("sd=2000-01-01&lt=9")),
    false,
  );
  assert.equal(
    persistedToolStateMatchesUrl(state, new URLSearchParams("sd=1999-01-01")),
    false,
  );
  assert.equal(
    persistedToolStateMatchesUrl(state, new URLSearchParams("ed=2019-01-01")),
    false,
  );
});

test("shouldQueueToolAutorun respects suppressAutoRun and shouldAutoRunFromSearch", () => {
  const params = new URLSearchParams("tab=strategies&sd=2020-01-01");
  assert.equal(
    shouldQueueToolAutorun(params, {
      allowInitialSearchAutoRun: true,
      suppressAutoRun: true,
      shouldAutoRunFromSearch: () => true,
      hasCachedResults: false,
    }),
    false,
  );
  assert.equal(
    shouldQueueToolAutorun(params, {
      allowInitialSearchAutoRun: true,
      suppressAutoRun: false,
      shouldAutoRunFromSearch: () => false,
      hasCachedResults: false,
    }),
    false,
  );
});

test("canonicalNormalizedToolsHrefKey sorts params and strips autorun", () => {
  const key = canonicalNormalizedToolsHrefKey(
    "/tools",
    new URLSearchParams("ed=2020-01-01&autorun=1&sd=2000-01-01&tab=backtest"),
  );
  assert.equal(key, "/tools?ed=2020-01-01&sd=2000-01-01&tab=backtest");
});

test("hasMeaningfulSearchParams accepts empty and nullish inputs", () => {
  assert.equal(hasMeaningfulSearchParams(), false);
  assert.equal(hasMeaningfulSearchParams({ sd: null, ed: undefined }), false);
});
