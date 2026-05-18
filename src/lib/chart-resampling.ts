import type { ChartData } from "chart.js";

export interface VisibleRange {
  min: number;
  max: number;
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(Math.max(index, 0), length - 1);
}

function lowerBound(values: number[], target: number): number {
  let left = 0;
  let right = values.length;
  while (left < right) {
    const mid = Math.floor((left + right) / 2);
    if (values[mid] < target) left = mid + 1;
    else right = mid;
  }
  return left;
}

function upperBound(values: number[], target: number): number {
  let left = 0;
  let right = values.length;
  while (left < right) {
    const mid = Math.floor((left + right) / 2);
    if (values[mid] <= target) left = mid + 1;
    else right = mid;
  }
  return left;
}

export function getVisibleIndexBounds(labelTimes: number[], range: VisibleRange | null) {
  if (labelTimes.length === 0) return { startIndex: 0, endIndex: -1 };
  if (!range) return { startIndex: 0, endIndex: labelTimes.length - 1 };

  const rawStart = lowerBound(labelTimes, range.min);
  const rawEndExclusive = upperBound(labelTimes, range.max);
  const startIndex = clampIndex(rawStart, labelTimes.length);
  const endIndex = clampIndex(Math.max(startIndex, rawEndExclusive - 1), labelTimes.length);

  return { startIndex, endIndex };
}

export function selectSampledIndices(
  startIndex: number,
  endIndex: number,
  maxPoints: number,
  preserveIndices: number[] = []
): number[] {
  if (endIndex < startIndex) return [];

  const visibleCount = endIndex - startIndex + 1;
  if (visibleCount <= maxPoints) {
    return Array.from({ length: visibleCount }, (_, idx) => startIndex + idx);
  }

  const sampled = new Set<number>([startIndex, endIndex]);
  for (const index of preserveIndices) {
    if (index >= startIndex && index <= endIndex) sampled.add(index);
  }

  const remainingBudget = Math.max(0, maxPoints - sampled.size);
  if (remainingBudget > 0) {
    const step = (visibleCount - 1) / (remainingBudget + 1);
    for (let i = 1; i <= remainingBudget; i += 1) {
      sampled.add(Math.round(startIndex + i * step));
    }
  }

  return [...sampled].sort((a, b) => a - b);
}

export function pickLineChartIndices(
  data: ChartData<"line">,
  indices: number[]
): ChartData<"line"> {
  return {
    labels: indices.map((index) => data.labels?.[index] ?? null),
    datasets: data.datasets.map((dataset) => ({
      ...dataset,
      data: Array.isArray(dataset.data)
        ? indices.map((index) => dataset.data[index] ?? null)
        : dataset.data,
    })),
  };
}
