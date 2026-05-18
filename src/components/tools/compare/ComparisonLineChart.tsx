"use client";

import { ZoomableChart } from "@/components/ui/ZoomableChart";
import { Card } from "@/components/ui/Card";
import type { SmaComparisonRow } from "@/lib/simulation/types";

interface ChartSeries {
  label: string;
  metric: (row: SmaComparisonRow) => number;
  color: string;
  rows?: SmaComparisonRow[];
  borderDash?: number[];
}

export function ComparisonLineChart({
  title,
  rows,
  baseline,
  chartOptions,
  series,
  baselineSeries,
}: {
  title: string;
  rows: SmaComparisonRow[];
  baseline: SmaComparisonRow | null;
  chartOptions: object;
  series: ChartSeries[];
  baselineSeries: ChartSeries[];
}) {
  const allRows = series.flatMap((s) => s.rows ?? rows);
  const minVal = Math.min(...allRows.map((r) => r.parameterValue));
  const maxVal = Math.max(...allRows.map((r) => r.parameterValue));
  const datasets = [
    ...series.map((s) => {
      const data = (s.rows ?? rows).map((row) => ({ x: row.parameterValue, y: s.metric(row) }));
      return {
        label: s.label,
        data,
        borderColor: s.color,
        borderWidth: 1.5,
        borderDash: s.borderDash ?? [],
        pointRadius: 0,
        tension: 0,
        fill: false,
      };
    }),
    ...(baseline && isFinite(minVal) && isFinite(maxVal)
      ? baselineSeries.map((s) => {
          const y = s.metric(s.rows?.[0] ?? baseline);
          return {
            label: s.label,
            data: [
              { x: minVal, y },
              { x: maxVal, y },
            ],
            borderColor: s.color,
            borderWidth: 1,
            borderDash: s.borderDash ?? [6, 4],
            pointRadius: 0,
            tension: 0,
            fill: false,
          };
        })
      : []),
  ];

  return (
    <Card className="p-4">
      <h3 className="text-sm font-semibold mb-2">{title}</h3>
      <div className="h-[280px]">
        <ZoomableChart data={{ datasets }} options={chartOptions} />
      </div>
    </Card>
  );
}
