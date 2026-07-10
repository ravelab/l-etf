import type { ReactNode } from "react";
import type { Metadata } from "next";
import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "Live SPX & NDX SMA Signals",
  description:
    "Check today's SPX and NDX simple moving average (SMA) signals for leveraged ETF timing strategies, with configurable periods and buffers. Enable push alerts for signal flips.",
  path: "/signals",
});

export default function SignalsLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
