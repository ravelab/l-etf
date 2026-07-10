import type { ReactNode } from "react";
import type { Metadata } from "next";
import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "Compare SMA Buffer Levels",
  description:
    "Test SMA buffer thresholds to reduce whipsaw trades in leveraged ETF timing strategies, and compare returns, drawdowns, and trade frequency.",
  path: "/compare-threshold-strategies",
});

export default function CompareThresholdStrategiesLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
