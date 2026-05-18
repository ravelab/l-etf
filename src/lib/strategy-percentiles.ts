import { annualizedInflationForRange } from "@/lib/inflation";
import type { RollingSimulationPoint } from "@/lib/simulation/rolling";

export type PercentilePoint = {
  x: number;
  y: number;
};

export type StrategyPercentileSeries = {
  label: string;
  color: string;
  points: PercentilePoint[];
};

export function transformRealEndValue(value: number, logScale: boolean): number {
  if (!logScale) return value;
  if (value === 0) return 0;
  return Math.log1p(value);
}

export function inverseTransformRealEndValue(value: number, logScale: boolean): number {
  if (!logScale) return value;
  if (value === 0) return 0;
  return Math.expm1(value);
}

function getYearsBetween(startDate: string, endDate: string): number {
  const startMs = new Date(`${startDate}T00:00:00Z`).getTime();
  const endMs = new Date(`${endDate}T00:00:00Z`).getTime();
  return Math.max(0, (endMs - startMs) / (365.25 * 24 * 60 * 60 * 1000));
}

export function percentile(sortedValues: number[], percentileRank: number): number {
  if (sortedValues.length === 0) return Number.NaN;
  if (sortedValues.length === 1) return sortedValues[0];

  const clamped = Math.min(1, Math.max(0, percentileRank));
  const position = (sortedValues.length - 1) * clamped;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  if (lowerIndex === upperIndex) return sortedValues[lowerIndex];

  const weight = position - lowerIndex;
  return sortedValues[lowerIndex] * (1 - weight) + sortedValues[upperIndex] * weight;
}

export function computeRealEndValue(
  run: Pick<RollingSimulationPoint, "startDate" | "endDate" | "finalValue">,
  monthlyCpi: Array<{ date: string; value: number }>,
): number {
  const inflation = monthlyCpi.length >= 2
    ? annualizedInflationForRange(monthlyCpi, run.startDate, run.endDate)
    : 0;
  const years = getYearsBetween(run.startDate, run.endDate);
  const inflationAdjustedValue = monthlyCpi.length >= 2
    ? run.finalValue / Math.pow(1 + inflation, years)
    : run.finalValue;
  return inflationAdjustedValue;
}

export function buildRealEndValuePercentileSeries(params: {
  strategies: Array<{
    label: string;
    color: string;
    runs: Array<Pick<RollingSimulationPoint, "startDate" | "endDate" | "finalValue">>;
  }>;
  monthlyCpi: Array<{ date: string; value: number }>;
  pointCount?: number;
}): StrategyPercentileSeries[] {
  const pointCount = Math.max(1, Math.floor(params.pointCount ?? 101));
  const denom = Math.max(1, pointCount - 1);

  return params.strategies
    .map((strategy) => {
      const values = strategy.runs
        .map((run) => computeRealEndValue(run, params.monthlyCpi))
        .filter((value): value is number => Number.isFinite(value))
        .sort((a, b) => a - b);

      if (values.length === 0) return null;

      const points = Array.from({ length: pointCount }, (_, idx) => {
        const rank = idx / denom;
        return {
          x: rank * 100,
          y: percentile(values, rank),
        };
      });

      return {
        label: strategy.label,
        color: strategy.color,
        points,
      };
    })
    .filter((series): series is StrategyPercentileSeries => series !== null);
}
