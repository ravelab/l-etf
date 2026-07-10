import type { ReactNode } from "react";
import type { Metadata } from "next";
import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "Compare SMA Risk-Off Assets",
  description:
    "Compare defensive risk-off assets — SGOV, VGSH, GLDM, BRK.B, and equal-weight mixes — used when an SMA leveraged ETF strategy steps aside.",
  path: "/compare-riskoff-assets",
});

export default function CompareRiskOffAssetsLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
