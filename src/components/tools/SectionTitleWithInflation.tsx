"use client";

import { formatPercent } from "@/lib/format";

export function SectionTitleWithInflation({
  title,
  startDate,
  inflationPct,
  avgTradesPerYear,
  className = "text-lg font-semibold",
}: {
  title: string;
  startDate?: string | null;
  inflationPct?: number | null;
  avgTradesPerYear?: number | null;
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
      {inflationPct != null && (
        <span className="text-sm font-normal text-muted">
          {" "}· Avg Inflation: <span className="text-foreground">{formatPercent(inflationPct)}</span>
        </span>
      )}
    </h2>
  );
}
