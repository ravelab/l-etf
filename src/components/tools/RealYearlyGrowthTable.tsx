"use client";

import { useState } from "react";
import { Card } from "@/components/ui/Card";
import { SectionTitleWithInflation } from "@/components/tools/SectionTitleWithInflation";
import { formatPercent } from "@/lib/format";
import { TablePagination } from "@/components/ui/TablePagination";

type YearlyGrowthSeries = {
  years: string[];
  series: Array<{ label: string; values: Array<number | null> }>;
  inflation?: Array<number | null>;
};

const MAX_HEAT_ABS_PERCENT = 40;
const PAGE_SIZE = 10;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function getCellStyle(value: number | null): React.CSSProperties {
  if (value == null || !Number.isFinite(value)) {
    return { color: "var(--muted)" };
  }

  const intensity = clamp01(Math.abs(value) / MAX_HEAT_ABS_PERCENT);
  if (intensity < 0.08) {
    return { color: "var(--foreground)" };
  }

  if (value > 0) {
    return {
      color: `color-mix(in srgb, var(--foreground) ${Math.round((1 - intensity) * 100)}%, var(--positive-text))`,
    };
  }
  if (value < 0) {
    return {
      color: `color-mix(in srgb, var(--foreground) ${Math.round((1 - intensity) * 100)}%, var(--negative-text))`,
    };
  }
  return { color: "var(--foreground)" };
}

export function RealYearlyGrowthTable({
  yearlyGrowthSeries,
  description,
  title = "Real Yearly Growth Rate",
  inflationPct,
}: {
  yearlyGrowthSeries: YearlyGrowthSeries | null;
  description: string;
  title?: string;
  inflationPct?: number | null;
}) {
  const [page, setPage] = useState(0);
  const normalized = yearlyGrowthSeries;
  if (!normalized || normalized.series.length === 0) return null;

  const visibleRows = yearlyGrowthSeries.years
    .map((year, rowIdx) => ({
      year,
      rowIdx,
      hasValue: yearlyGrowthSeries.series.some((series) => series.values[rowIdx] != null),
    }))
    .filter((row) => row.hasValue);

  const pageSafe = Math.min(page, Math.max(0, Math.ceil(visibleRows.length / PAGE_SIZE) - 1));
  const pagedRows = visibleRows.slice(pageSafe * PAGE_SIZE, (pageSafe + 1) * PAGE_SIZE);

  if (visibleRows.length === 0) return null;

  return (
    <Card>
      <div className="mb-3">
        <SectionTitleWithInflation title={title} inflationPct={inflationPct} />
      </div>
      <p className="text-xs text-muted mb-4">{description}</p>
      <TablePagination
        page={page}
        pageSize={PAGE_SIZE}
        totalItems={visibleRows.length}
        onPageChange={setPage}
      />
      <div className="overflow-x-auto">
        <table className="min-w-full border-separate border-spacing-0 text-sm">
          <thead>
            <tr>
              <th className="sticky left-0 z-20 bg-card-bg px-3 py-2 text-left font-medium text-foreground border-b border-card-border whitespace-nowrap">
                Year
              </th>
              {yearlyGrowthSeries.series.map((series) => (
                <th
                  key={series.label}
                  className="bg-card-bg px-3 py-2 text-right font-medium text-foreground border-b border-card-border whitespace-nowrap"
                >
                  {series.label}
                </th>
              ))}
              {yearlyGrowthSeries.inflation && yearlyGrowthSeries.inflation.length > 0 && (
                <th className="bg-card-bg px-3 py-2 text-right font-medium text-foreground border-b border-card-border whitespace-nowrap">
                  Inflation
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {pagedRows.map(({ year, rowIdx }) => (
              <tr key={year}>
                <td className="sticky left-0 z-10 bg-card-bg px-3 py-2 text-left text-muted border-b border-card-border whitespace-nowrap">
                  {year}
                </td>
                {yearlyGrowthSeries.series.map((series) => {
                  const value = series.values[rowIdx] ?? null;
                  return (
                    <td
                      key={`${year}-${series.label}`}
                      className="px-3 py-2 text-right tabular-nums border-b border-card-border whitespace-nowrap"
                      style={getCellStyle(value)}
                    >
                      {value == null ? "\u2014" : formatPercent(value)}
                    </td>
                  );
                })}
                {yearlyGrowthSeries.inflation && yearlyGrowthSeries.inflation.length > 0 && (
                  <td className="px-3 py-2 text-right tabular-nums text-muted border-b border-card-border whitespace-nowrap">
                    {yearlyGrowthSeries.inflation[rowIdx] == null
                      ? "\u2014"
                      : formatPercent(yearlyGrowthSeries.inflation[rowIdx]! * 100)}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
