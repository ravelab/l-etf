"use client";

import { Suspense, useEffect, useMemo, useState, type ComponentType } from "react";
import { useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import { DEFAULT_TOOL_TAB, TOOL_TABS, type ToolTab } from "@/lib/tools-route";

type ToolPanelProps = {
  active?: boolean;
  suppressAutoRun?: boolean;
  allowInitialSearchAutoRun?: boolean;
};

type ToolPanel = {
  Panel: ComponentType<ToolPanelProps>;
  preload: () => Promise<unknown>;
};

/**
 * A tab panel whose code can be fetched ahead of the click.
 *
 * `next/dynamic` alone wraps each tab in a `React.lazy` under its own Suspense boundary with a
 * null fallback. Its first render after a page load suspends even when the chunk is already
 * cached, so the tab paints blank and React 19 then holds the reveal for up to 300ms: the
 * window loses its scrollbar meanwhile and the centered header jumps. A panel whose module
 * was preloaded therefore renders it directly. The choice is fixed at mount, because flipping
 * from the lazy tree to the direct one under a live tab would remount it and drop its state.
 */
function preloadablePanel(load: () => Promise<ComponentType<ToolPanelProps>>): ToolPanel {
  let loaded: ComponentType<ToolPanelProps> | null = null;
  let pending: Promise<ComponentType<ToolPanelProps>> | null = null;
  const preload = () => {
    pending ??= load().then(
      (component) => (loaded = component),
      (error: unknown) => {
        // Let the next attempt retry rather than replay a failed chunk load forever.
        pending = null;
        throw error;
      },
    );
    return pending;
  };
  const Dynamic = dynamic(preload, { ssr: false });

  function Panel(props: ToolPanelProps) {
    const [Preloaded] = useState(() => loaded);
    return Preloaded ? <Preloaded {...props} /> : <Dynamic {...props} />;
  }
  return { Panel, preload };
}

const TAB_PANELS: Record<ToolTab, ToolPanel> = {
  strategies: preloadablePanel(() => import("@/app/compare-letfs/page").then((mod) => mod.CompareLETFsPageContent)),
  "sma-period": preloadablePanel(() => import("@/app/compare-sma-strategies/page").then((mod) => mod.CompareSmaStrategiesPageContent)),
  "sma-buffer": preloadablePanel(() => import("@/app/compare-threshold-strategies/page").then((mod) => mod.CompareBufferStrategiesPageContent)),
  riskoff: preloadablePanel(() => import("@/app/compare-riskoff-assets/page").then((mod) => mod.CompareRiskOffAssetsPageContent)),
  statistics: preloadablePanel(() => import("@/app/statistical-analysis/page").then((mod) => mod.StatisticalAnalysisPageContent)),
  backtest: preloadablePanel(() => import("@/app/backtesting-tool/page").then((mod) => mod.BacktestingPageContent)),
  futures: preloadablePanel(() => import("@/app/futures-tool/page").then((mod) => mod.FuturesPageContent)),
};

/** How long to wait for an idle moment before fetching the other tabs' code anyway. */
const PRELOAD_IDLE_TIMEOUT_MS = 2000;

/** Fetch every tab's code once the first tab has settled, so later clicks render at once. */
function usePreloadTabPanels() {
  useEffect(() => {
    const preloadAll = () => {
      for (const { preload } of Object.values(TAB_PANELS)) {
        // Best effort: a failed preload leaves the click to load (and report) it.
        preload().catch(() => undefined);
      }
    };
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(preloadAll, { timeout: PRELOAD_IDLE_TIMEOUT_MS });
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(preloadAll, PRELOAD_IDLE_TIMEOUT_MS);
    return () => window.clearTimeout(id);
  }, []);
}

export default function ToolsPage() {
  return (
    <Suspense fallback={null}>
      <ToolsPageContent />
    </Suspense>
  );
}

function ToolsPageContent() {
  const searchParams = useSearchParams();
  const activeTab = useMemo<ToolTab>(() => {
    const requested = searchParams.get("tab");
    return requested && TOOL_TABS.includes(requested as ToolTab)
      ? (requested as ToolTab)
      : DEFAULT_TOOL_TAB;
  }, [searchParams]);
  usePreloadTabPanels();
  const ActivePanel = TAB_PANELS[activeTab].Panel;

  return (
    <ActivePanel
      key={activeTab}
      active
      allowInitialSearchAutoRun
    />
  );
}
