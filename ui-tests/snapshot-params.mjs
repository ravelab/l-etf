/**
 * Builds URL query params from src/lib/tool-snapshots/*.json the same way as
 * scripts/test-snapshots.mjs to avoid drift.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SNAPSHOT_DIR = join(process.cwd(), "src", "lib", "tool-snapshots");

function withCommonParams(entries, pageState) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(entries)) {
    if (value == null) continue;
    params.set(key, String(value));
  }
  if (pageState.historyWrap === false) {
    params.set("tw", "0");
  }
  params.set("autorun", "1");
  return params;
}

export function readSnapshot(pageKey) {
  const snapshotPath = join(SNAPSHOT_DIR, `${pageKey}.json`);
  return JSON.parse(readFileSync(snapshotPath, "utf8"));
}

/** compare-letfs → strategies tab */
export function buildCompareLetfsParams(pageState) {
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
      smaExec: pageState.smaExecutionMode,
    },
    pageState
  );
}

/** compare-riskoff-assets → riskoff tab */
export function buildCompareRiskoffParams(pageState) {
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
      smaExec: pageState.smaExecutionMode,
    },
    pageState
  );
}

/** compare-sma → sma-period tab */
export function buildCompareSmaParams(pageState) {
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
      smaExec: pageState.smaExecutionMode,
    },
    pageState
  );
}

/**
 * Minimal query string for the SMA Period tab so the client bundle hydrates in Puppeteer + next dev.
 * Longer URLs (py, minP, sweep fields, etc.) leave `main` stuck on the RSC placeholder in headless Chrome.
 * Simulation still uses snapshot-backed defaults from tool state / shared inputs after load.
 */
export function buildCompareSmaHydrationParams(pageState) {
  return withCommonParams(
    {
      preset: pageState.preset,
      sd: pageState.startDate,
      ed: pageState.endDate,
    },
    pageState
  );
}

/** compare-threshold → sma-buffer tab */
export function buildCompareThresholdParams(pageState) {
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
      smaExec: pageState.smaExecutionMode,
    },
    pageState
  );
}

/** Same hydration constraint as {@link buildCompareSmaHydrationParams} for the SMA Buffer tab. */
export function buildCompareThresholdHydrationParams(pageState) {
  return withCommonParams(
    {
      preset: pageState.preset,
      sd: pageState.startDate,
      ed: pageState.endDate,
    },
    pageState
  );
}

/** statistical-analysis → statistics tab (shared tool form query shape) */
export function buildStatisticalAnalysisParams(pageState) {
  return withCommonParams(
    {
      letf: pageState.preset,
      sd: pageState.startDate,
      ed: pageState.endDate,
      py: pageState.windowLength,
      smaPsp: pageState.smaSpPeriod,
      smaPnq: pageState.smaNqPeriod,
      smatsp: pageState.smaSpBuffer,
      smatnq: pageState.smaNqBuffer,
      ro: pageState.riskOffAsset,
      smaExec: pageState.smaExecutionMode,
    },
    pageState
  );
}

/** backtesting → backtest tab */
export function buildBacktestParams(pageState) {
  const entries = {
    letf: pageState.preset,
    sd: pageState.startDate,
    ed: pageState.endDate,
    smaPsp: pageState.smaSpPeriod,
    smaPnq: pageState.smaNqPeriod,
    smatsp: pageState.smaSpBuffer,
    smatnq: pageState.smaNqBuffer,
    ro: pageState.riskOffAsset,
  };
  if (pageState.smaMode === 0) {
    entries.sma = "0";
  }
  return withCommonParams(entries, pageState);
}

export function buildToolUrl(baseUrl, tab, params) {
  const nextParams = new URLSearchParams(params ? params.toString() : "");
  nextParams.set("tab", tab);
  return `${baseUrl.replace(/\/$/, "")}/tools?${nextParams.toString()}`;
}
