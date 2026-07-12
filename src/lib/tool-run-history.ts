import type { RunSummary } from "@/lib/run-summary";
import { TOOLS_AUTORUN_PARAM, type ToolTab } from "@/lib/tools-route";

const TOOL_RUN_HISTORY_STORAGE_KEY = "toolRunHistory:v1";
const TOOL_RUN_HISTORY_SKIP_NEXT_STORAGE_KEY = "toolRunHistory:skipNext:v1";
const TOOL_RUN_HISTORY_MAX_ENTRIES = 30;

const TOOL_RUN_HISTORY_CHANGED_EVENT = "tool-run-history-changed";

export type ToolRunHistorySummaryDisplay = {
  showLetf?: boolean;
  showRiskOffAsset?: boolean;
  showSmaSpPeriod?: boolean;
  showSmaSpBuffer?: boolean;
  showSmaNqPeriod?: boolean;
  showSmaNqBuffer?: boolean;
};

export type ToolRunHistoryEntry = {
  id: string;
  /** `/tools?tab=...&...` without `autorun` */
  href: string;
  tab: ToolTab;
  tabLabel: string;
  summary: RunSummary;
  summaryDisplay?: ToolRunHistorySummaryDisplay;
  savedAt: string;
};

function sortSearchParamsStable(params: URLSearchParams): string {
  const entries = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
  const next = new URLSearchParams();
  for (const [k, v] of entries) {
    next.append(k, v);
  }
  return next.toString();
}

/** Stable dedupe key: pathname + query without autorun, keys sorted */
function normalizeToolsHref(href: string): string {
  try {
    const pathAndQuery = href.startsWith("/tools") ? href : `/tools${href.startsWith("?") ? href : `?${href}`}`;
    const qIndex = pathAndQuery.indexOf("?");
    const pathname = qIndex >= 0 ? pathAndQuery.slice(0, qIndex) : pathAndQuery;
    const search = qIndex >= 0 ? pathAndQuery.slice(qIndex + 1) : "";
    const params = new URLSearchParams(search);
    params.delete(TOOLS_AUTORUN_PARAM);
    const qs = sortSearchParamsStable(params);
    return qs ? `${pathname}?${qs}` : pathname;
  } catch {
    return href;
  }
}

function emitChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(TOOL_RUN_HISTORY_CHANGED_EVENT));
}

export function readToolRunHistory(): ToolRunHistoryEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(TOOL_RUN_HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is ToolRunHistoryEntry =>
        e &&
        typeof e === "object" &&
        typeof (e as ToolRunHistoryEntry).href === "string" &&
        typeof (e as ToolRunHistoryEntry).tab === "string" &&
        typeof (e as ToolRunHistoryEntry).tabLabel === "string"
    );
  } catch {
    return [];
  }
}

function writeToolRunHistory(entries: ToolRunHistoryEntry[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(TOOL_RUN_HISTORY_STORAGE_KEY, JSON.stringify(entries));
    emitChanged();
  } catch {
    try {
      const trimmed = entries.slice(0, Math.floor(TOOL_RUN_HISTORY_MAX_ENTRIES / 2));
      window.localStorage.setItem(TOOL_RUN_HISTORY_STORAGE_KEY, JSON.stringify(trimmed));
      emitChanged();
    } catch {
      // ignore quota
    }
  }
}

function stripAutorunFromHref(href: string): string {
  try {
    const qIndex = href.indexOf("?");
    if (qIndex < 0) return href;
    const base = href.slice(0, qIndex);
    const params = new URLSearchParams(href.slice(qIndex + 1));
    params.delete(TOOLS_AUTORUN_PARAM);
    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
  } catch {
    return href;
  }
}

/** Insert or refresh entry at top; dedupe by normalized href */
function pushToolRunHistory(
  entry: Omit<ToolRunHistoryEntry, "id" | "savedAt"> & { savedAt?: string }
): void {
  const hrefClean = stripAutorunFromHref(entry.href);
  const normalized = normalizeToolsHref(hrefClean);
  const id = normalized;
  const savedAt = entry.savedAt ?? new Date().toISOString();
  const full: ToolRunHistoryEntry = {
    ...entry,
    id,
    href: hrefClean,
    savedAt,
  };

  const prev = readToolRunHistory();
  const filtered = prev.filter((e) => normalizeToolsHref(e.href) !== normalized);
  const next = [full, ...filtered].slice(0, TOOL_RUN_HISTORY_MAX_ENTRIES);
  writeToolRunHistory(next);
}

/** Move existing entry to top by normalized href */
export function moveToolRunToTop(hrefOrNormalized: string): void {
  const normalized = hrefOrNormalized.includes("?")
    ? normalizeToolsHref(hrefOrNormalized)
    : hrefOrNormalized;
  const prev = readToolRunHistory();
  const idx = prev.findIndex((e) => normalizeToolsHref(e.href) === normalized);
  if (idx < 0) return;
  const item = { ...prev[idx]!, savedAt: new Date().toISOString() };
  const next = [item, ...prev.filter((_, i) => i !== idx)].slice(0, TOOL_RUN_HISTORY_MAX_ENTRIES);
  writeToolRunHistory(next);
}

export function deleteToolRunHistoryEntry(hrefOrNormalized: string): void {
  const normalized = hrefOrNormalized.includes("?")
    ? normalizeToolsHref(hrefOrNormalized)
    : hrefOrNormalized;
  const prev = readToolRunHistory();
  const next = prev.filter((e) => normalizeToolsHref(e.href) !== normalized);
  if (next.length === prev.length) return;
  writeToolRunHistory(next);
}

export function clearToolRunHistory(): void {
  writeToolRunHistory([]);
}

export function skipNextToolRunHistoryRecord(href: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(TOOL_RUN_HISTORY_SKIP_NEXT_STORAGE_KEY, normalizeToolsHref(href));
  } catch {
    // ignore storage
  }
}

function shouldSkipNextToolRunHistoryRecord(href: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    const normalized = normalizeToolsHref(href);
    const pending = window.sessionStorage.getItem(TOOL_RUN_HISTORY_SKIP_NEXT_STORAGE_KEY);
    if (pending !== normalized) return false;
    window.sessionStorage.removeItem(TOOL_RUN_HISTORY_SKIP_NEXT_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

export function recordSuccessfulToolRun(args: {
  tab: ToolTab;
  tabLabel: string;
  href: string;
  summary: RunSummary;
  summaryDisplay?: ToolRunHistorySummaryDisplay;
}): void {
  if (typeof window === "undefined") return;
  if (shouldSkipNextToolRunHistoryRecord(args.href)) return;
  pushToolRunHistory({
    href: args.href,
    tab: args.tab,
    tabLabel: args.tabLabel,
    summary: args.summary,
    summaryDisplay: args.summaryDisplay,
  });
}

export function subscribeToolRunHistory(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(TOOL_RUN_HISTORY_CHANGED_EVENT, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(TOOL_RUN_HISTORY_CHANGED_EVENT, listener);
    window.removeEventListener("storage", listener);
  };
}
