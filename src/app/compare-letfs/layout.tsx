import type { ReactNode } from "react";
import type { Metadata } from "next";
import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "Compare Leveraged ETF Strategies",
  description:
    "Compare simulated and real leveraged ETF strategies across rolling historical windows, with percentile return distributions and drawdown stats.",
  path: "/compare-letfs",
});

export default function CompareLetfsLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
