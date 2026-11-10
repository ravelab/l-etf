"use client";

import { formatPercent } from "@/lib/format";

export function SectionTitleWithInflation({
  title,
  startDate,
  inflationPct,
  avgTradesPerYear,
  riskOffPct,
  className = "text-lg font-semibold",
}: {
  title: string;
  startDate?: string | null;
  inflationPct?: number | null;
  avgTradesPerYear?: number | null;
  /** Average share of time spent risk-off, in percent. */
  riskOffPct?: number | null;
  className?: string;
}) {
  return (
    <h2 className={className}>
      {title}
      {startDate && (
        <span className="text-sm font-normal text-muted">
          {" "}· Start Date: <span className="text-foreground">{startDate}</span>
        </span>
      )}
      {avgTradesPerYear != null && (
        <span className="text-sm font-normal text-muted">
          {" "}· Avg Trades/Year: <span className="text-foreground">{avgTradesPerYear.toFixed(2)}</span>
        </span>
      )}
      {riskOffPct != null && (
        <span className="text-sm font-normal text-muted">
          {" "}· Time Risk-Off: <span className="text-foreground">{riskOffPct.toFixed(1)}%</span>
        </span>
      )}
      {inflationPct != null && (
        <span className="text-sm font-normal text-muted">
          {" "}· Avg Inflation: <span className="text-foreground">{formatPercent(inflationPct)}</span>
        </span>
      )}
    </h2>
  );
}
