import type { ReactNode } from "react";
import type { Metadata } from "next";
import { maybeRunAutoRefresh } from "@/lib/data/auto-refresh";
import { pageMetadata } from "@/lib/seo";

export const dynamic = "force-dynamic";

export const metadata: Metadata = pageMetadata({
  title: "Backtesting Tools",
  description:
    "Explore leveraged ETF backtesting tools: strategy comparison, SMA period and buffer sweeps, risk-off asset comparison, holding-period statistics, and futures simulation.",
  path: "/tools",
});

export default function ToolsLayout({ children }: { children: ReactNode }) {
  maybeRunAutoRefresh();
  return <>{children}</>;
}
