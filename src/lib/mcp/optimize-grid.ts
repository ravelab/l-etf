// Pure planning for `optimize_strategy`: the joint (SMA period x upper buffer x
// lower buffer) grid, its neighbourhood, and the in/out-of-sample split.
//
// Kept free of data loading and the engine so the search geometry — which is
// where an optimizer quietly goes wrong — can be tested on its own.

import { McpToolError } from "@/lib/mcp/tool-result";

/** Buffers step in tenths of a percent, so axis values round to 3 decimals. */
const AXIS_PRECISION = 1e3;

export interface GridCell {
  id: string;
  smaPeriod: number;
  upperBuffer: number;
  lowerBuffer: number;
}

interface GridSpec {
  periods: number[];
  uppers: number[];
  lowers: number[];
}

export interface DateRange {
  startDate: string;
  endDate: string;
}

/**
 * Inclusive min..max on `step`. The endpoint appears only when the step lands
 * on it, so `buildAxis(100, 210, 25)` stops at 200 rather than inventing a 210
 * the caller did not ask for.
 */
export function buildAxis(min: number, max: number, step: number): number[] {
  if (!Number.isFinite(step) || step <= 0) {
    throw new McpToolError(`Step must be positive, received ${step}.`);
  }
  if (min > max) throw new McpToolError(`Range ${min}..${max} is inverted.`);

  const values: number[] = [];
  const count = Math.floor((max - min) / step);
  for (let i = 0; i <= count; i += 1) {
    values.push(Math.round((min + i * step) * AXIS_PRECISION) / AXIS_PRECISION);
  }
  return values;
}

/** Every combination of the three axes, in a stable order with stable ids. */
export function planOptimizationGrid(spec: GridSpec): GridCell[] {
  const cells: GridCell[] = [];
  for (const smaPeriod of spec.periods) {
    for (const upperBuffer of spec.uppers) {
      for (const lowerBuffer of spec.lowers) {
        cells.push({
          id: `opt-p${smaPeriod}-u${upperBuffer}-l${lowerBuffer}`,
          smaPeriod,
          upperBuffer,
          lowerBuffer,
        });
      }
    }
  }
  if (cells.length === 0) throw new McpToolError("The optimization grid is empty.");
  return cells;
}

/**
 * Cells exactly one grid step from `centre` along a single axis.
 *
 * This is what separates a real region from a fitting artifact: an optimum
 * whose immediate neighbours score far worse is a spike the search found in one
 * particular history, not a parameter that would have held up. Diagonals are
 * excluded deliberately — moving two parameters at once says nothing about
 * which one the result was sensitive to.
 */
export function findNeighbours(centre: GridCell, cells: GridCell[]): GridCell[] {
  const axis = (values: number[]) => [...new Set(values)].sort((a, b) => a - b);
  const periods = axis(cells.map((c) => c.smaPeriod));
  const uppers = axis(cells.map((c) => c.upperBuffer));
  const lowers = axis(cells.map((c) => c.lowerBuffer));

  const adjacent = (values: number[], value: number): number[] => {
    const i = values.indexOf(value);
    if (i < 0) return [];
    return [values[i - 1], values[i + 1]].filter((v): v is number => v !== undefined);
  };

  const wanted = [
    ...adjacent(periods, centre.smaPeriod).map((p) => ({ ...centre, smaPeriod: p })),
    ...adjacent(uppers, centre.upperBuffer).map((u) => ({ ...centre, upperBuffer: u })),
    ...adjacent(lowers, centre.lowerBuffer).map((l) => ({ ...centre, lowerBuffer: l })),
  ];

  const byCoords = new Map(
    cells.map((c) => [`${c.smaPeriod}|${c.upperBuffer}|${c.lowerBuffer}`, c]),
  );
  return wanted
    .map((w) => byCoords.get(`${w.smaPeriod}|${w.upperBuffer}|${w.lowerBuffer}`))
    .filter((c): c is GridCell => c !== undefined);
}

/** Shortest range worth splitting: each half still needs room for windows. */
const MIN_SPLIT_YEARS = 10;

/**
 * Split a range at its calendar midpoint into a half to search and a half to
 * check the winner against. The halves meet rather than overlapping, so a
 * parameter chosen on the first has not seen the second.
 */
export function splitRangeInHalf(
  startDate: string,
  endDate: string,
): { inSample: DateRange; outOfSample: DateRange } {
  const start = Date.parse(startDate);
  const end = Date.parse(endDate);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new McpToolError(`Invalid range ${startDate}..${endDate}.`);
  }
  const years = (end - start) / (365.25 * 24 * 3600 * 1000);
  if (years < MIN_SPLIT_YEARS) {
    throw new McpToolError(
      `A split-sample check needs at least ${MIN_SPLIT_YEARS} years; ${startDate}..${endDate} is ` +
        `${years.toFixed(1)}. Widen the range or set \`splitSample\` to false.`,
    );
  }
  const midpoint = new Date(start + (end - start) / 2).toISOString().slice(0, 10);
  return {
    inSample: { startDate, endDate: midpoint },
    outOfSample: { startDate: midpoint, endDate },
  };
}
