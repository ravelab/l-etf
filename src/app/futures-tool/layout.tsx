import type { ReactNode } from "react";
import type { Metadata } from "next";
import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "Futures SMA Backtesting Tool",
  description:
    "Simulate SMA-timed index futures strategies with margin scenarios, fees, spreads, and transaction-level detail — a closer model of real futures execution.",
  path: "/futures-tool",
});

export default function FuturesToolLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
