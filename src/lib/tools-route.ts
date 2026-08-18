import { urlSmaBuffersMatchState } from "@/lib/sma-buffer-url-params";

export const TOOL_TABS = [
  "strategies",
  "sma-period",
  "sma-buffer",
  "riskoff",
  "statistics",
  "backtest",
  "futures",
] as const;

export type ToolTab = (typeof TOOL_TABS)[number];

export const DEFAULT_TOOL_TAB: ToolTab = "strategies";
export const TOOLS_AUTORUN_PARAM = "autorun";

const TOOL_TAB_PAGE_KEYS: Record<ToolTab, string> = {
  strategies: "compare-letfs",
  "sma-period": "compare-sma",
  "sma-buffer": "compare-threshold",
  riskoff: "compare-riskoff-assets",
  statistics: "statistical-analysis",
  backtest: "backtesting",
  futures: "futures",
};

function cloneParams(input?: URLSearchParams | string | Record<string, string | number | boolean | null | undefined>) {
  if (!input) return new URLSearchParams();
  if (input instanceof URLSearchParams) return new URLSearchParams(input.toString());
  if (typeof input === "string") return new URLSearchParams(input);

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value == null) continue;
    params.set(key, String(value));
  }
  return params;
}

function stripToolsTabParam(input?: URLSearchParams | string | Record<string, string | number | boolean | null | undefined>) {
  const params = cloneParams(input);
  params.delete("tab");
  params.delete(TOOLS_AUTORUN_PARAM);
  return params;
}

export function hasMeaningfulSearchParams(input?: URLSearchParams | string | Record<string, string | number | boolean | null | undefined>) {
  return stripToolsTabParam(input).toString().length > 0;
}

function sortSearchParamsStable(params: URLSearchParams): string {
  const entries = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
  const next = new URLSearchParams();
  for (const [k, v] of entries) {
    next.append(k, v);
  }
  return next.toString();
}

/** Canonical `/tools?...` for compare-with-history (autorun stripped, keys sorted; aligns with tool-run-history normalizeToolsHref). */
function normalizedToolsHrefFromSearchParams(params: URLSearchParams): string {
  const p = new URLSearchParams(params.toString());
  p.delete(TOOLS_AUTORUN_PARAM);
  const qs = sortSearchParamsStable(p);
  return qs ? `/tools?${qs}` : "/tools";
}

/**
 * Same normalized key as tool-run-history `entry.id` for the live document (legacy routes like
 * `/compare-letfs` omit `tab` in searchParams — this adds it via buildToolsUrl).
 */
export function canonicalNormalizedToolsHrefKey(pathname: string, params: URLSearchParams): string {
  if (pathname === "/tools") {
    return normalizedToolsHrefFromSearchParams(params);
  }
  const tab = getToolTabForPathname(pathname);
  if (!tab) {
    return normalizedToolsHrefFromSearchParams(params);
  }
  const built = buildToolsUrl(tab, params);
  const q = built.indexOf("?");
  const search = q >= 0 ? built.slice(q + 1) : "";
  return normalizedToolsHrefFromSearchParams(new URLSearchParams(search));
}

/** After History navigates to a URL we already show; blocks autorun until timeout or URL changes (handles hydration + React Strict double effects). */
let historyAutorunSuppressNorm: string | null = null;
let historyAutorunSuppressClearTimer: ReturnType<typeof setTimeout> | null = null;

export function requestToolAutorunSuppressForHistoryHref(normalizedHref: string): void {
  historyAutorunSuppressNorm = normalizedHref;
  if (typeof window === "undefined") return;
  if (historyAutorunSuppressClearTimer) clearTimeout(historyAutorunSuppressClearTimer);
  historyAutorunSuppressClearTimer = setTimeout(() => {
    historyAutorunSuppressNorm = null;
    historyAutorunSuppressClearTimer = null;
  }, 750);
}

function historyAutorunShouldSuppress(
  pathname: string | null | undefined,
  params: URLSearchParams,
  force: boolean
): boolean {
  if (force || historyAutorunSuppressNorm === null) return false;
  const cur =
    pathname != null && pathname !== ""
      ? canonicalNormalizedToolsHrefKey(pathname, params)
      : normalizedToolsHrefFromSearchParams(params);
  if (cur !== historyAutorunSuppressNorm) {
    if (historyAutorunSuppressClearTimer) clearTimeout(historyAutorunSuppressClearTimer);
    historyAutorunSuppressClearTimer = null;
    historyAutorunSuppressNorm = null;
    return false;
  }
  return true;
}

/**
 * Whether to queue an automatic simulation run from the current URL.
 * Any meaningful URL params represent an explicit shared/deep link and should
 * run, unless the search update was produced internally by the current tool.
 */
export function shouldQueueToolAutorun(
  params: URLSearchParams,
  opts: {
    allowInitialSearchAutoRun: boolean;
    suppressAutoRun: boolean;
    /** From useSearchSyncRunGuard — false right after an internal URL sync */
    shouldAutoRunFromSearch: () => boolean;
    hasCachedResults: boolean;
  },
  pathname?: string | null
): boolean {
  if (!hasMeaningfulSearchParams(params)) return false;
  const force = params.get(TOOLS_AUTORUN_PARAM) === "1";
  if (historyAutorunShouldSuppress(pathname, params, force)) return false;
  const allowed = opts.allowInitialSearchAutoRun && !opts.suppressAutoRun;
  if (!(force || (allowed && opts.shouldAutoRunFromSearch()))) return false;
  return true;
}

function urlNumMatchesState(params: URLSearchParams, key: string, stateVal: unknown): boolean {
  const raw = params.get(key);
  if (raw == null || raw === "") return true;
  const a = Number(stateVal);
  const b = Number(raw);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return a === b;
}

/**
 * True if persisted page cache matches the tool URL for all params present in the URL.
 * Previously only letf/sd/ed were checked — history links with same dates but different
 * wrap/SMA/window/ro then hydrated stale runs and skipped autorun.
 */
export function persistedToolStateMatchesUrl(state: Record<string, unknown>, params: URLSearchParams): boolean {
  const urlLetf = params.get("letf") ?? params.get("preset");
  if (urlLetf) {
    const stateLetf = state.letf ?? state.preset;
    if (stateLetf == null || String(stateLetf) !== urlLetf) return false;
  }
  const sd = params.get("sd");
  if (sd && (state.startDate == null || String(state.startDate) !== sd)) return false;
  const ed = params.get("ed");
  if (ed && (state.endDate == null || String(state.endDate) !== ed)) return false;

  if (!urlNumMatchesState(params, "py", state.windowLength)) return false;

  if (!urlNumMatchesState(params, "smaPsp", state.smaSpPeriod)) return false;
  if (!urlNumMatchesState(params, "smaPnq", state.smaNqPeriod)) return false;
  if (!urlSmaBuffersMatchState(params, {
    smaSpUpperBuffer: state.smaSpUpperBuffer as number | undefined,
    smaSpLowerBuffer: state.smaSpLowerBuffer as number | undefined,
    smaNqUpperBuffer: state.smaNqUpperBuffer as number | undefined,
    smaNqLowerBuffer: state.smaNqLowerBuffer as number | undefined,
  })) return false;

  const ro = params.get("ro");
  if (ro != null && ro !== "") {
    if (state.riskOffAsset == null || String(state.riskOffAsset) !== ro) return false;
  }

  if (!urlNumMatchesState(params, "lt", state.leverageTolerancePct)) return false;

  return true;
}

export function buildToolsUrl(
  tab: ToolTab,
  params?: URLSearchParams | string | Record<string, string | number | boolean | null | undefined>,
  options?: { autorun?: boolean }
) {
  const sourceParams = cloneParams(params);
  sourceParams.delete("tab");
  sourceParams.delete(TOOLS_AUTORUN_PARAM);

  const orderedParams = new URLSearchParams();
  orderedParams.set("tab", tab);
  if (options?.autorun) orderedParams.set(TOOLS_AUTORUN_PARAM, "1");

  for (const [key, value] of sourceParams.entries()) {
    orderedParams.append(key, value);
  }

  return `/tools?${orderedParams.toString()}`;
}

export function persistedPageCacheMatchesToolUrl(tab: ToolTab, params: URLSearchParams): boolean {
  if (typeof window === "undefined") return false;
  const pageKey = TOOL_TAB_PAGE_KEYS[tab];
  if (!pageKey) return false;
  try {
    const raw = window.localStorage.getItem("pageCache:v3:" + pageKey);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return false;
    return persistedToolStateMatchesUrl(parsed as Record<string, unknown>, params);
  } catch {
    return false;
  }
}

export function getToolTabForPathname(pathname: string | null | undefined): ToolTab | null {
  switch (pathname) {
    case "/compare-letfs":
      return "strategies";
    case "/compare-sma-strategies":
      return "sma-period";
    case "/compare-threshold-strategies":
      return "sma-buffer";
    case "/compare-riskoff-assets":
      return "riskoff";
    case "/statistical-analysis":
      return "statistics";
    case "/backtesting-tool":
      return "backtest";
    case "/futures-tool":
      return "futures";
    default:
      return null;
  }
}
