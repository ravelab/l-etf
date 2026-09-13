// `stress_test_strategy` orchestration: run one configuration through each
// named historical drawdown and report what it did in each.
//
// Each episode is a real backtest over its own range, with SMA warm-up loaded
// before it so the strategy enters the crisis in whatever regime the preceding
// trend actually put it in — which is the single most informative thing here,
// and is exactly what a sliced-out sub-range would get wrong.

import { INDEX_DATE_RANGES } from "@/lib/constants";
import { runBacktestCore } from "@/lib/mcp/tools/run-backtest";
import { resolveBacktest, type BacktestInput } from "@/lib/mcp/backtest-config";
import { episodesForRange, type CrisisEpisode } from "@/lib/mcp/crisis-episodes";
import { McpToolError } from "@/lib/mcp/tool-result";
import { throwIfAborted } from "@/lib/abort";

interface EpisodeResult {
  name: string;
  description: string;
  startDate: string;
  endDate: string;
  /** Total return of the timed strategy over the episode, in percent. */
  strategyReturnPct: number;
  strategyMaxDrawdownPct: number;
  /** The same LETF held through the episode with no timing rule. */
  buyAndHoldReturnPct: number | null;
  buyAndHoldMaxDrawdownPct: number | null;
  /** The unleveraged index over the same window, for scale. */
  index1xReturnPct: number;
  trades: number;
  /** Whether the strategy was holding the LETF when the episode opened. */
  startedInvested: boolean | null;
}

interface StressTestResult {
  strategy: string;
  index: string;
  windowsTested: number;
  episodes: EpisodeResult[];
  worstEpisode: EpisodeResult;
  skipped: Array<{ name: string; reason: string }>;
}

const toPct = (multiple: number): number => (multiple - 1) * 100;

/**
 * Run `input`'s configuration through every catalogued episode the index has
 * data for. An episode that cannot produce a result (too little data at the
 * very start of the series, say) is reported as skipped rather than dropped, so
 * the caller can see the coverage they actually got.
 */
export async function runStressTest(
  input: BacktestInput,
  options?: { episodes?: readonly CrisisEpisode[]; signal?: AbortSignal },
): Promise<StressTestResult> {
  const { config, index } = resolveBacktest(input);
  const bounds = INDEX_DATE_RANGES[index];
  if (!bounds) throw new McpToolError(`No date range known for index "${index}".`);

  const today = new Date().toISOString().slice(0, 10);
  const candidates =
    options?.episodes ?? episodesForRange(bounds.min, today < bounds.max ? today : bounds.max);
  if (candidates.length === 0) {
    throw new McpToolError(
      `No catalogued drawdown episodes fall inside the ${index} data range.`,
    );
  }

  const episodes: EpisodeResult[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];

  for (const episode of candidates) {
    throwIfAborted(options?.signal);
    try {
      const formatted = await runBacktestCore({
        ...input,
        startDate: episode.startDate,
        endDate: episode.endDate,
      });
      episodes.push({
        name: episode.name,
        description: episode.description,
        startDate: formatted.startDate,
        endDate: formatted.endDate,
        strategyReturnPct: toPct(formatted.finalMultiple),
        strategyMaxDrawdownPct: formatted.maxDrawdownPct,
        buyAndHoldReturnPct: formatted.noSmaComparison
          ? toPct(formatted.noSmaComparison.finalMultiple)
          : null,
        buyAndHoldMaxDrawdownPct: formatted.noSmaComparison?.maxDrawdownPct ?? null,
        index1xReturnPct: toPct(formatted.benchmark.finalMultiple),
        trades: formatted.numTrades,
        startedInvested: formatted.smaStartInvested ?? null,
      });
    } catch (error) {
      // One unrunnable episode must not lose the other eight.
      skipped.push({
        name: episode.name,
        reason: error instanceof McpToolError ? error.message : "Could not be simulated.",
      });
    }
  }

  if (episodes.length === 0) {
    throw new McpToolError("No episode could be simulated for this configuration.");
  }

  const worstEpisode = episodes.reduce((worst, e) =>
    e.strategyReturnPct < worst.strategyReturnPct ? e : worst,
  );

  return {
    strategy: config.name,
    index,
    windowsTested: episodes.length,
    episodes,
    worstEpisode,
    skipped,
  };
}
