"use client";

import { Suspense, useMemo, type ComponentType } from "react";
import { useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import { DEFAULT_TOOL_TAB, TOOL_TABS, type ToolTab } from "@/lib/tools-route";

type ToolPanelProps = {
  active?: boolean;
  suppressAutoRun?: boolean;
  allowInitialSearchAutoRun?: boolean;
};

const TAB_PANELS: Record<ToolTab, ComponentType<ToolPanelProps>> = {
  strategies: dynamic(() => import("@/app/compare-letfs/page").then((mod) => mod.CompareLETFsPageContent), { ssr: false }),
  "sma-period": dynamic(() => import("@/app/compare-sma-strategies/page").then((mod) => mod.CompareSmaStrategiesPageContent), { ssr: false }),
  "sma-buffer": dynamic(() => import("@/app/compare-threshold-strategies/page").then((mod) => mod.CompareBufferStrategiesPageContent), { ssr: false }),
  riskoff: dynamic(() => import("@/app/compare-riskoff-assets/page").then((mod) => mod.CompareRiskOffAssetsPageContent), { ssr: false }),
  statistics: dynamic(() => import("@/app/statistical-analysis/page").then((mod) => mod.StatisticalAnalysisPageContent), { ssr: false }),
  backtest: dynamic(() => import("@/app/backtesting-tool/page").then((mod) => mod.BacktestingPageContent), { ssr: false }),
  futures: dynamic(() => import("@/app/futures-tool/page").then((mod) => mod.FuturesPageContent), { ssr: false }),
};

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
  const ActivePanel = TAB_PANELS[activeTab];

  return (
    <ActivePanel
      key={activeTab}
      active
      allowInitialSearchAutoRun
    />
  );
}
