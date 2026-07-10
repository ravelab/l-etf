import type { ReactNode } from "react";
import type { Metadata } from "next";
import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "Leveraged ETF Backtesting Tool",
  description:
    "Run a historical backtest of leveraged ETF SMA strategies (UPRO, TQQQ, SSO, QLD) with trade logs, drawdown charts, and inflation-adjusted returns.",
  path: "/backtesting-tool",
});

export default function BacktestingToolLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
