import type { ReactNode } from "react";
import type { Metadata } from "next";
import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "Holding Period Win Rates & Returns",
  description:
    "See how win rates and returns for leveraged ETF strategies change as the holding period changes, across rolling historical windows.",
  path: "/statistical-analysis",
});

export default function StatisticalAnalysisLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
