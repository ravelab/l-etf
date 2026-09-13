// Declared output shapes for the tools whose payloads are stable enough to
// promise. An `outputSchema` is a contract an agent can plan against without
// calling the tool first, and it is what lets the text block carry a summary
// instead of a second copy of the data (see `toolSuccessTyped`).
//
// The SDK validates `structuredContent` against these on every call and raises
// a protocol error on a mismatch, so a schema here is only worth declaring
// where the payload is pinned by a test — see `mcp-output-schema.test.ts`.
//
// Every metric is `.nullable()`: payloads pass through `sanitizeNonFinite`, and
// a degenerate window genuinely has no Sharpe ratio or CAGR. Counts and dates,
// which are always produced, stay strict.

import { z } from "zod/v4";

/** A computed metric, null when the inputs made it undefined. */
const metric = z.number().nullable();

const dateRange = z.object({ start: z.string(), end: z.string() });

const disclaimer = z.string();

const backtestSchema = z.object({
  name: z.string(),
  index: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  finalMultiple: metric,
  cagrPct: metric,
  sharpeRatio: metric,
  maxDrawdownPct: metric,
  maxDrawdownDates: dateRange.optional(),
  longestDrawdownDays: z.number(),
  bestMonthPct: metric,
  worstMonthPct: metric,
  totalTradingCostPct: metric,
  smaStartInvested: z.boolean().optional(),
  numTrades: z.number(),
  trades: z.array(
    z.object({
      date: z.string(),
      type: z.enum(["buy", "sell"]),
      price: metric,
    }),
  ),
  benchmark: z.object({ name: z.string(), finalMultiple: metric }),
  noSmaComparison: z
    .object({ finalMultiple: metric, cagrPct: metric, maxDrawdownPct: metric })
    .optional(),
});

export const runBacktestOutput = {
  backtest: backtestSchema,
  /** Opens this exact run in the site's backtesting tool. Preset runs only. */
  permalink: z.string().optional(),
  disclaimer,
};

export const runFuturesBacktestOutput = {
  futures: z.object({
    name: z.string(),
    index: z.string(),
    startDate: z.string(),
    endDate: z.string(),
    targetLeverage: metric,
    maxLeverage: metric,
    initialEquity: metric,
    finalEquity: metric,
    cagrPct: metric,
    sharpeRatio: metric,
    maxDrawdownPct: metric,
    totalTradingCostPct: metric,
    numSignals: z.number(),
    futuresTransactions: z.number(),
    avgActualLeverageRiskOn: metric,
    maxAbsLeverageDeltaRiskOnPct: metric,
    riskOffSessionDayCount: z.number(),
    sessionDayCount: z.number(),
  }),
  /** Opens the site's futures ladder with this configuration. Rung leverages only. */
  permalink: z.string().optional(),
  disclaimer,
};

const sweepRowSchema = z.object({
  id: z.string(),
  label: z.string(),
  avgReturnPct: metric,
  avgCagrPct: metric.optional(),
  bestReturnPct: metric,
  worstReturnPct: metric,
  avgMaxDrawdownPct: metric,
  worstMaxDrawdownPct: metric,
  winRatePct: metric.optional(),
  avgTrades: metric,
  avgWindowYears: metric.optional(),
});

const percentileBlock = z.object({
  p5: metric,
  p10: metric,
  p25: metric,
  p50: metric,
  p75: metric,
  p90: metric,
  p95: metric,
});

const distributionSchema = z.object({
  windowCount: z.number(),
  winRateVs1xPct: metric,
  percentiles: z.object({
    cagrPct: percentileBlock,
    totalReturnPct: percentileBlock,
    maxDrawdownPct: percentileBlock,
    finalMultiple: percentileBlock,
  }),
  histogram: z.array(
    z.object({ fromCagrPct: metric, toCagrPct: metric, count: z.number() }),
  ),
  sampled: z.boolean(),
  sampleStride: z.number().optional(),
  windows: z
    .array(
      z.object({
        startDate: z.string(),
        endDate: z.string(),
        cagrPct: metric,
        totalReturnPct: metric,
        finalMultiple: metric,
        maxDrawdownPct: metric,
        beat1x: z.boolean(),
        trades: z.number(),
      }),
    )
    .optional(),
});

export const runRollingWindowOutput = {
  windowLengthYears: z.number(),
  startDate: z.string(),
  endDate: z.string(),
  analysis: sweepRowSchema,
  distribution: distributionSchema.optional(),
  disclaimer,
};

const bufferGridRowSchema = sweepRowSchema.extend({
  upperBuffer: metric,
  lowerBuffer: metric,
  score: metric,
});

/**
 * `compare_strategies` answers on two shapes: a flat ranking (`results`) for the
 * 1-D modes, and the 2-D buffer grid, which carries its own scoring, baseline
 * and `best` cell. They share this one schema with each branch's fields
 * optional, because the SDK normalizes an output schema to a single object —
 * a top-level union would not survive that. `mode` says which branch you got.
 */
export const compareStrategiesOutput = {
  mode: z.string(),
  windowLengthYears: z.number(),
  startDate: z.string(),
  endDate: z.string(),
  // Flat ranking branch.
  results: z.array(z.union([sweepRowSchema, bufferGridRowSchema])),
  truncated: z.boolean().optional(),
  evaluatedConfigs: z.number().optional(),
  totalConfigs: z.number().optional(),
  // Buffer-grid branch.
  smaPeriod: z.number().optional(),
  objective: z.string().optional(),
  inflationPct: metric.optional(),
  cells: z.number().optional(),
  best: bufferGridRowSchema.optional(),
  baseline: sweepRowSchema.optional(),
  disclaimer,
};

const scoredCellSchema = sweepRowSchema.extend({
  smaPeriod: z.number(),
  upperBuffer: metric,
  lowerBuffer: metric,
  score: metric,
  rank: z.number(),
});

export const optimizeStrategyOutput = {
  objective: z.string(),
  windowLengthYears: z.number(),
  gridCells: z.number(),
  search: z.object({ startDate: z.string(), endDate: z.string(), inflationPct: metric }),
  best: scoredCellSchema,
  top: z.array(scoredCellSchema),
  stability: z.object({
    neighbours: z.array(
      z.object({
        smaPeriod: z.number(),
        upperBuffer: metric,
        lowerBuffer: metric,
        score: metric,
      }),
    ),
    worstNeighbourScore: metric,
    worstNeighbourDropPct: metric,
    plateau: z.boolean(),
  }),
  outOfSample: z
    .object({
      startDate: z.string(),
      endDate: z.string(),
      inflationPct: metric,
      winnerRank: metric,
      winnerScore: metric,
      ownBest: scoredCellSchema.nullable(),
    })
    .optional(),
  truncated: z.boolean(),
  /** Says plainly that these parameters were chosen on the data they are scored on. */
  caveat: z.string(),
  disclaimer,
};

const episodeSchema = z.object({
  name: z.string(),
  description: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  strategyReturnPct: metric,
  strategyMaxDrawdownPct: metric,
  buyAndHoldReturnPct: metric,
  buyAndHoldMaxDrawdownPct: metric,
  index1xReturnPct: metric,
  trades: z.number(),
  startedInvested: z.boolean().nullable(),
});

export const stressTestOutput = {
  strategy: z.string(),
  index: z.string(),
  windowsTested: z.number(),
  episodes: z.array(episodeSchema),
  worstEpisode: episodeSchema,
  skipped: z.array(z.object({ name: z.string(), reason: z.string() })),
  disclaimer,
};

const smaBandSchema = z.object({
  period: z.number(),
  upperBuffer: metric,
  lowerBuffer: metric,
});

const ladderRungSchema = z.object({
  name: z.string(),
  index: z.string(),
  targetLeverage: metric,
  dualSleeve: z.boolean(),
  finalEquity: metric,
  cagrPct: metric,
  sharpeRatio: metric,
  maxDrawdownPct: metric,
  totalTradingCostPct: metric,
  avgActualLeverageRiskOn: metric,
  maxAbsLeverageDeltaRiskOnPct: metric,
  numSignals: z.number(),
  futuresTransactions: z.number(),
});

export const compareFuturesLadderOutput = {
  startDate: z.string(),
  endDate: z.string(),
  initialEquity: metric,
  riskOffAsset: z.string(),
  emulationMode: z.boolean(),
  bands: z.object({ sp500: smaBandSchema, nasdaq100: smaBandSchema }),
  rungs: z.array(ladderRungSchema),
  best: ladderRungSchema,
  disclaimer,
};

export const forwardSmaReturnsOutput = {
  strategy: z.string(),
  index: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  forwardTradingDays: z.number(),
  observations: z.number(),
  bins: z.array(
    z.object({
      label: z.string(),
      fromGapPct: metric,
      toGapPct: metric,
      count: z.number(),
      medianRealReturnPct: metric,
      p10RealReturnPct: metric,
      p90RealReturnPct: metric,
      minRealReturnPct: metric,
      maxRealReturnPct: metric,
    }),
  ),
  note: z.string(),
  disclaimer,
};
