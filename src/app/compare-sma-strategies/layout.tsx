import type { ReactNode } from "react";
import type { Metadata } from "next";
import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "Compare SMA Periods",
  description:
    "Sweep SMA (moving average) period lengths for leveraged ETF timing strategies and compare faster versus slower trend-following rules.",
  path: "/compare-sma-strategies",
});

export default function CompareSmaStrategiesLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
