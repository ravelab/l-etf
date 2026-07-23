"use client";

import { useCallback, useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toValidRunSummary } from "@/lib/hooks/use-run-summary-inputs";
import {
  buildToolsUrl,
  canonicalNormalizedToolsHrefKey,
  persistedPageCacheMatchesToolUrl,
  requestToolAutorunSuppressForHistoryHref,
  TOOL_TABS,
  type ToolTab,
} from "@/lib/tools-route";
import {
  clearToolRunHistory,
  deleteToolRunHistoryEntry,
  moveToolRunToTop,
  readToolRunHistory,
  skipNextToolRunHistoryRecord,
  subscribeToolRunHistory,
  type ToolRunHistoryEntry,
} from "@/lib/tool-run-history";

const HISTORY_TYPE_COLORS: Record<ToolTab, { accent: string; bg: string; hover: string }> = {
  strategies: {
    accent: "#16f3ce",
    bg: "rgba(22, 243, 206, 0.09)",
    hover: "rgba(22, 243, 206, 0.15)",
  },
  "sma-period": {
    accent: "#60a5fa",
    bg: "rgba(96, 165, 250, 0.1)",
    hover: "rgba(96, 165, 250, 0.16)",
  },
  "sma-buffer": {
    accent: "#f97316",
    bg: "rgba(249, 115, 22, 0.1)",
    hover: "rgba(249, 115, 22, 0.16)",
  },
  riskoff: {
    accent: "#22c55e",
    bg: "rgba(34, 197, 94, 0.1)",
    hover: "rgba(34, 197, 94, 0.16)",
  },
  statistics: {
    accent: "#a855f7",
    bg: "rgba(168, 85, 247, 0.1)",
    hover: "rgba(168, 85, 247, 0.16)",
  },
  backtest: {
    accent: "#eab308",
    bg: "rgba(234, 179, 8, 0.1)",
    hover: "rgba(234, 179, 8, 0.16)",
  },
  futures: {
    accent: "#ec4899",
    bg: "rgba(236, 72, 153, 0.1)",
    hover: "rgba(236, 72, 153, 0.16)",
  },
};

const WORST_TIME_BACKTEST_BASE_PARAMS = {
  letf: "UPRO+TQQQ",
  smaPsp: "186",
  smaPnq: "150",
  smatsp: "3.6",
  smatnq: "11.9",
  ro: "BRK.B+GLDM+VGSH",
} as const;

/**
 * Famous "worst time to invest" anchors from index TR: GFC, 1970s bear, Covid, dot-com, 1987.
 * Each window runs from that episode's **peak** through the **first close** where total return is
 * back at or above that peak (time underwater until break-even on TR), so backtests cover the full
 * grind including recovery — e.g. Nasdaq-100 from 2000-03-27 through 2015-02-19. Drawdown % is still
 * the peak→trough depth within the episode.
 */
const WORST_TIME_TO_INVEST_ITEMS = [
  { index: "S&P 500" as const, startDate: "2007-10-09", endDate: "2012-08-16", days: 1773, drawdown: "-55.2%" },
  { index: "S&P 500" as const, startDate: "1973-01-11", endDate: "1976-07-09", days: 1275, drawdown: "-44.9%" },
  { index: "S&P 500" as const, startDate: "2020-02-19", endDate: "2020-08-10", days: 173, drawdown: "-34.0%" },
  { index: "Nasdaq 100" as const, startDate: "2000-03-27", endDate: "2015-02-19", days: 5442, drawdown: "-83.0%" },
  { index: "Nasdaq 100" as const, startDate: "1987-10-02", endDate: "1989-05-19", days: 595, drawdown: "-39.9%" },
] as const;

function buildWorstTimeBacktestParams(startDate: string, endDate: string): URLSearchParams {
  const params = new URLSearchParams();
  params.set("letf", WORST_TIME_BACKTEST_BASE_PARAMS.letf);
  params.set("sd", startDate);
  params.set("ed", endDate);
  params.set("smaPsp", WORST_TIME_BACKTEST_BASE_PARAMS.smaPsp);
  params.set("smaPnq", WORST_TIME_BACKTEST_BASE_PARAMS.smaPnq);
  params.set("smatsp", WORST_TIME_BACKTEST_BASE_PARAMS.smatsp);
  params.set("smatnq", WORST_TIME_BACKTEST_BASE_PARAMS.smatnq);
  params.set("ro", WORST_TIME_BACKTEST_BASE_PARAMS.ro);
  return params;
}

function buildSavedRunMeta(entry: ToolRunHistoryEntry): string {
  const summary = toValidRunSummary(entry.summary);
  if (!summary) return "";
  const flags = entry.summaryDisplay;
  const pieces = [];
  if (flags?.showLetf ?? true) pieces.push(summary.letf);
  if (flags?.showRiskOffAsset ?? true) pieces.push(`Risk-Off ${summary.riskOffAsset}`);
  const spxParts = [
    (flags?.showSmaSpPeriod ?? true) ? `${summary.smaSpPeriod}` : null,
    (flags?.showSmaSpBuffer ?? true) ? `−${summary.smaSpLowerBuffer}/${summary.smaSpUpperBuffer}` : null,
  ].filter((p): p is string => p !== null);
  if (spxParts.length > 0) pieces.push(`SPX ${spxParts.join("/")}`);
  const ndxParts = [
    (flags?.showSmaNqPeriod ?? true) ? `${summary.smaNqPeriod}` : null,
    (flags?.showSmaNqBuffer ?? true) ? `−${summary.smaNqLowerBuffer}/${summary.smaNqUpperBuffer}` : null,
  ].filter((p): p is string => p !== null);
  if (ndxParts.length > 0) pieces.push(`NDX ${ndxParts.join("/")}`);
  return pieces.join(" - ");
}

function parseToolsHref(href: string): { tab: ToolTab; restParams: URLSearchParams } | null {
  try {
    const q = href.indexOf("?");
    const search = q >= 0 ? href.slice(q + 1) : "";
    const params = new URLSearchParams(search);
    const tabRaw = params.get("tab");
    if (!tabRaw || !TOOL_TABS.includes(tabRaw as ToolTab)) return null;
    const tab = tabRaw as ToolTab;
    const rest = new URLSearchParams();
    for (const [k, v] of params.entries()) {
      if (k !== "tab") rest.append(k, v);
    }
    return { tab, restParams: rest };
  } catch {
    return null;
  }
}

export function ToolRunHistoryMenu() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ToolRunHistoryEntry[]>([]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const refresh = useCallback(() => {
    setItems(readToolRunHistory());
  }, []);

  useEffect(() => {
    const unsub = subscribeToolRunHistory(refresh);
    queueMicrotask(refresh);
    return unsub;
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const onRowClick = (entry: ToolRunHistoryEntry) => {
    const parsed = parseToolsHref(entry.href);
    if (!parsed) return;
    moveToolRunToTop(entry.href);
    refresh();
    const currentKey = canonicalNormalizedToolsHrefKey(
      pathname,
      new URLSearchParams(searchParams.toString())
    );
    const alreadyShowing = currentKey === entry.id;
    const targetAlreadyCached = persistedPageCacheMatchesToolUrl(parsed.tab, parsed.restParams);
    if (alreadyShowing || targetAlreadyCached) {
      requestToolAutorunSuppressForHistoryHref(entry.id);
    }
    router.push(
      buildToolsUrl(parsed.tab, parsed.restParams, { autorun: !(alreadyShowing || targetAlreadyCached) })
    );
    setOpen(false);
  };

  const onDeleteClick = (entry: ToolRunHistoryEntry) => {
    deleteToolRunHistoryEntry(entry.id);
    refresh();
  };

  const onClearAllClick = () => {
    clearToolRunHistory();
    refresh();
  };

  const onWorstTimeToInvestClick = (startDate: string, endDate: string) => {
    const href = buildToolsUrl("backtest", buildWorstTimeBacktestParams(startDate, endDate), { autorun: true });
    skipNextToolRunHistoryRecord(href);
    router.push(href);
    setOpen(false);
  };

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={menuId}
        aria-haspopup="dialog"
        onClick={() => {
          refresh();
          setOpen((v) => !v);
        }}
        className="px-3 py-1.5 rounded-md text-sm transition-colors text-muted hover:text-foreground hover:bg-white/5 border border-transparent md:border-card-border"
      >
        History
      </button>
      {open && (
        <div
          id={menuId}
          role="dialog"
          aria-label="Simulation run history"
          className="absolute right-0 top-full z-[60] mt-1 w-[min(calc(100vw-2rem),24rem)] max-h-[80vh] overflow-y-auto rounded-lg border border-card-border bg-card-bg shadow-lg md:w-[90vw]"
        >
          <>
            {items.length === 0 ? (
              <p className="p-4 text-sm text-muted">No runs yet. Run a simulation to save it here.</p>
            ) : (
              <>
              <div className="sticky top-0 z-30 flex justify-end border-b border-card-border bg-card-bg/95 px-2 py-2 backdrop-blur">
                <button
                  type="button"
                  onClick={onClearAllClick}
                  className="rounded-md px-2.5 py-1.5 text-xs font-medium text-muted transition-colors hover:bg-white/5 hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-card-bg"
                >
                  Delete all
                </button>
              </div>
              <ul className="p-2 flex flex-col gap-2">
                {items.map((entry) => {
                  const summary = toValidRunSummary(entry.summary);
                  if (!summary) return null;
                  const colors = HISTORY_TYPE_COLORS[entry.tab] ?? HISTORY_TYPE_COLORS.strategies;
                  const meta = buildSavedRunMeta(entry);
                  return (
                    <li
                      key={entry.id}
                      className="relative"
                      style={{
                        "--history-accent": colors.accent,
                        "--history-bg": colors.bg,
                        "--history-hover-bg": colors.hover,
                      } as CSSProperties}
                    >
                      <button
                        type="button"
                        onClick={() => onRowClick(entry)}
                        className="flex w-full items-center gap-3 rounded-lg border border-card-border bg-[var(--history-bg)] px-3 py-2 pr-11 text-left transition-colors hover:border-[var(--history-accent)] hover:bg-[var(--history-hover-bg)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--history-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-card-bg"
                      >
                        <span
                          aria-hidden="true"
                          className="h-8 w-1.5 shrink-0 rounded-full bg-[var(--history-accent)]"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-foreground">
                            {entry.tabLabel}
                          </span>
                          <span className="block truncate text-xs text-muted">
                            {summary.startDate} to {summary.endDate}
                            {meta ? ` - ${meta}` : ""}
                          </span>
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => onDeleteClick(entry)}
                        aria-label={`Delete ${entry.tabLabel} history item`}
                        title="Delete"
                        className="absolute right-2 top-2 z-20 flex h-7 w-7 items-center justify-center rounded-md text-lg leading-none text-muted transition-colors hover:bg-[var(--history-hover-bg)] hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--history-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-card-bg"
                      >
                        <span aria-hidden="true">X</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              </>
            )}
            <div className="border-t border-card-border p-2">
              <div className="px-1.5 pb-2 pt-1 text-xs font-semibold uppercase tracking-wide text-muted">
                Worst time to invest
              </div>
              <ul className="flex flex-col gap-1.5">
                {WORST_TIME_TO_INVEST_ITEMS.map((item) => {
                  const isNasdaq = item.index === "Nasdaq 100";
                  const accent = isNasdaq ? "#a855f7" : "#60a5fa";
                  const bg = isNasdaq ? "rgba(168, 85, 247, 0.09)" : "rgba(96, 165, 250, 0.09)";
                  const hover = isNasdaq ? "rgba(168, 85, 247, 0.15)" : "rgba(96, 165, 250, 0.15)";
                  return (
                    <li
                      key={`${item.index}-${item.startDate}-${item.endDate}`}
                      style={{
                        "--history-accent": accent,
                        "--history-bg": bg,
                        "--history-hover-bg": hover,
                      } as CSSProperties}
                    >
                      <button
                        type="button"
                        onClick={() => onWorstTimeToInvestClick(item.startDate, item.endDate)}
                        className="flex w-full items-center gap-3 rounded-lg border border-card-border bg-[var(--history-bg)] px-3 py-2 text-left transition-colors hover:border-[var(--history-accent)] hover:bg-[var(--history-hover-bg)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--history-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-card-bg"
                      >
                        <span
                          aria-hidden="true"
                          className="h-8 w-1.5 shrink-0 rounded-full bg-[var(--history-accent)]"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium text-foreground">
                            {item.index} · {(item.days / 365.25).toFixed(2)}y window
                          </span>
                          <span className="block text-xs text-muted">
                            {item.drawdown} max decline · {item.startDate} to {item.endDate}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          </>
        </div>
      )}
    </div>
  );
}
