// Server-safe core for `compare_strategies` mode `asymmetric_buffers`: search
// the 2-D (upper, lower) SMA-buffer surface over rolling windows.
//
// The symmetric sweep (`sma_buffers`) can only move both sides of the band
// together, but upper governs re-entry and lower governs the exit — moving them
// together moves the trapdoor rather than widening the band (see the futures
// ladder note in AGENTS.md). This mirrors /compare-threshold-strategies, reusing
// the page's own grid planner and objective scoring so rankings agree.

import { annualizedInflationForRange } from "@/lib/inflation";
import { scoreRow, type AsymmetricSweepRow, type ObjectiveKey } from "@/lib/simulation/buffer-grid-search";
import type { EtfConfig } from "@/lib/simulation/types";
import { buildAsymmetricBufferConfigs, type AsymmetricBufferGridSpec } from "@/lib/mcp/compare-configs";
import { runRollingSweep } from "@/lib/mcp/sweep-core";
import { formatSweepRow, type FormattedSweepRow } from "@/lib/mcp/format";
import { loadInflation } from "@/lib/mcp/server-data";
import { McpToolError } from "@/lib/mcp/tool-result";

export interface BufferGridRow extends FormattedSweepRow {
  upperBuffer: number;
  lowerBuffer: number;
  score: number;
}

export interface BufferGridResult {
  objective: ObjectiveKey;
  inflationPct: number;
  cells: number;
  results: BufferGridRow[];
  best: BufferGridRow;
  /** Same LETF held with no SMA timing, for reference. Absent if it wiped out. */
  baseline?: FormattedSweepRow;
}

/**
 * Run one flat pass over the (upper, lower) grid and rank the cells by
 * `objective`. Inflation is measured over the evaluated range because two of
 * the objectives are stated in real terms.
 */
export async function runAsymmetricBufferGrid(params: {
  base: EtfConfig;
  index: "sp500" | "nasdaq100";
  spec: AsymmetricBufferGridSpec;
  objective: ObjectiveKey;
  windowLength: number;
  startDate: string;
  endDate: string;
  onProgress?: (fraction: number, label?: string) => void;
}): Promise<BufferGridResult> {
  const { base, index, spec, objective, windowLength, startDate, endDate, onProgress } = params;
  const { configs, grid } = buildAsymmetricBufferConfigs(base, spec);

  const [rows, monthlyCpi] = await Promise.all([
    runRollingSweep({ index, configs, windowLength, startDate, endDate, onProgress }),
    loadInflation(startDate, endDate),
  ]);
  if (rows.length === 0) {
    throw new McpToolError("No valid rolling windows for this buffer grid and range.");
  }
  // `annualizedInflationForRange` returns a fraction; `scoreRow` subtracts this
  // from `avgReturn`, which is a percent. These sweep rows are nominal — MCP
  // never passes monthlyCpi into the engine, so nothing has deflated them yet —
  // which is the same case the compare pages handle by scaling to a percent.
  const inflationPct = annualizedInflationForRange(monthlyCpi, startDate, endDate) * 100;

  const results: BufferGridRow[] = [];
  let baseline: FormattedSweepRow | undefined;
  for (const row of rows) {
    const cell = grid.get(row.id);
    if (!cell) {
      if (row.id === "baseline") baseline = formatSweepRow(row.id, row.label, row.stats);
      continue;
    }
    const scored: AsymmetricSweepRow = {
      ...row.stats,
      upperBuffer: cell.upperBuffer,
      lowerBuffer: cell.lowerBuffer,
      stage: "coarse",
    };
    results.push({
      ...formatSweepRow(row.id, row.label, row.stats),
      upperBuffer: cell.upperBuffer,
      lowerBuffer: cell.lowerBuffer,
      score: scoreRow(scored, objective, inflationPct),
    });
  }
  if (results.length === 0) {
    throw new McpToolError("Every cell in this buffer grid wiped out over the requested windows.");
  }

  // Rank by objective; ties fall back to the lower/tighter band so repeated
  // calls with the same inputs return the same ordering.
  results.sort(
    (a, b) =>
      b.score - a.score || a.upperBuffer - b.upperBuffer || a.lowerBuffer - b.lowerBuffer,
  );

  return {
    objective,
    inflationPct,
    cells: results.length,
    results,
    best: results[0],
    ...(baseline ? { baseline } : {}),
  };
}
