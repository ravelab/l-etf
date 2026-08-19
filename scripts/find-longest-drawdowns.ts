/**
 * The "Worst time to invest" windows in `ToolRunHistoryMenu.tsx`, measured on the **strategy**
 * equity curve (UPRO-SMA / TQQQ-SMA) rather than the index. The index's worst stretches are not
 * the strategy's: the SMA exits sidestep some of them and whipsaw through others, and the menu
 * backtests the strategy.
 *
 * Each window starts at a record high and ends at the last close still below that high **in real
 * terms**, so every one spans a stretch that ended with less purchasing power than it started
 * with and the tool reports a negative real CAGR. Nominal break-even lands much earlier in the
 * inflationary eras; that is the dollar shrinking, not the position growing, which is the whole
 * point of the exercise.
 *
 * Two outputs: a ranking of the longest such spans (one per episode, so a cluster of record highs
 * days apart doesn't fill the list) and `ERAS`, the curated set the menu ships. The menu keeps
 * recognizable episodes rather than the top of the ranking, which reaches back to eras nobody has
 * heard of — but within each era it takes the record high that stretches the span furthest, which
 * is usually months before the episode's actual top.
 *
 * Run: node --import tsx scripts/find-longest-drawdowns.ts
 */
import { INDEX_DATE_RANGES } from "@/lib/constants";
import { alignRiskOffPriceSeries, getMarketDataWarmUpStartDate } from "@/lib/fetch-market-data";
import {
  loadBorrowRates,
  loadIndexPrices,
  loadInflation,
  loadRiskOffRawSeries,
} from "@/lib/mcp/server-data";
import { simulateWithWarmUp } from "@/lib/simulation/engine";
import {
  DEFAULT_RISK_OFF_ASSET,
  getDefaultSmaBuffer,
  getDefaultSmaPeriod,
} from "@/lib/simulation/defaults";
import { DEFAULT_SMA_EXECUTION_MODE } from "@/lib/input-normalization";
import { ETF_PRESETS } from "@/lib/simulation/presets";
import type { EtfConfig } from "@/lib/simulation/types";

type PresetKey = "UPRO" | "TQQQ";

/** How many spans to list per strategy in the ranking. */
const TOP_N = 8;

/**
 * Two spans count as the same episode when they overlap by more than this share of the shorter
 * one. Record highs cluster days apart and each spawns a near-identical span; without this the
 * ranking is a dozen views of one bear market.
 */
const SAME_EPISODE_OVERLAP = 0.5;

/** The windows the menu ships, as (strategy, year the window's record high falls in). */
interface EraWindow {
  readonly letf: PresetKey;
  readonly peakYear: string;
}

const ERAS: readonly EraWindow[] = [
  { letf: "UPRO", peakYear: "1964" },
  { letf: "UPRO", peakYear: "1929" },
  { letf: "UPRO", peakYear: "2006" },
  { letf: "TQQQ", peakYear: "2000" },
  { letf: "TQQQ", peakYear: "1987" },
];

interface Span {
  readonly peakIndex: number;
  readonly endIndex: number;
  readonly peakDate: string;
  readonly endDate: string;
  readonly days: number;
}

interface Curve {
  readonly dates: string[];
  /** Strategy equity in nominal dollars — what the backtest tool charts. */
  readonly values: number[];
  /** The same curve in constant dollars. */
  readonly realValues: number[];
  readonly spans: Span[];
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

/**
 * Restate an equity curve in constant dollars. CPI is monthly, so each session carries its own
 * month's level, holding the last known value over any month the table doesn't cover.
 */
function deflate(
  dates: readonly string[],
  values: readonly number[],
  cpi: ReadonlyArray<{ date: string; value: number }>,
): number[] {
  const byMonth = new Map(cpi.map((row) => [row.date.slice(0, 7), row.value]));
  let level = cpi[0]?.value ?? 1;
  return dates.map((date, i) => {
    level = byMonth.get(date.slice(0, 7)) ?? level;
    return values[i]! / level;
  });
}

/**
 * Every record high, paired with the last close that is still below it in real terms. Note the
 * end is the *last* dip under the high, not the first recovery: an inflationary era can carry
 * the nominal curve back over the line years before purchasing power follows.
 */
function findSpans(dates: string[], values: number[], realValues: number[]): Span[] {
  const spans: Span[] = [];
  let record = -Infinity;

  for (let peakIndex = 0; peakIndex < values.length; peakIndex++) {
    if (values[peakIndex]! < record) continue;
    record = values[peakIndex]!;

    const realPeak = realValues[peakIndex]!;
    let endIndex = -1;
    for (let i = realValues.length - 1; i > peakIndex; i--) {
      if (realValues[i]! < realPeak) {
        endIndex = i;
        break;
      }
    }
    if (endIndex < 0) continue;

    spans.push({
      peakIndex,
      endIndex,
      peakDate: dates[peakIndex]!,
      endDate: dates[endIndex]!,
      days: daysBetween(dates[peakIndex]!, dates[endIndex]!),
    });
  }
  return spans.sort((a, b) => b.days - a.days);
}

/** Longest span per episode, walking a length-sorted list and skipping overlaps. */
function longestPerEpisode(spans: readonly Span[], limit: number): Span[] {
  const kept: Span[] = [];
  for (const span of spans) {
    const overlapsKept = kept.some((other) => {
      const from = Math.max(span.peakIndex, other.peakIndex);
      const to = Math.min(span.endIndex, other.endIndex);
      return to - from > (span.endIndex - span.peakIndex) * SAME_EPISODE_OVERLAP;
    });
    if (overlapsKept) continue;
    kept.push(span);
    if (kept.length >= limit) break;
  }
  return kept;
}

/** Deepest peak-to-trough decline inside a span, nominal, as a negative percentage. */
function maxDrawdown(curve: Curve, span: Span): number {
  let peak = -Infinity;
  let worst = 0;
  for (let i = span.peakIndex; i <= span.endIndex; i++) {
    const value = curve.values[i]!;
    if (value > peak) peak = value;
    const drawdown = ((value - peak) / peak) * 100;
    if (drawdown < worst) worst = drawdown;
  }
  return worst;
}

function realCagrPct(curve: Curve, span: Span): number {
  const multiple = curve.realValues[span.endIndex]! / curve.realValues[span.peakIndex]!;
  return (Math.pow(multiple, 365.25 / span.days) - 1) * 100;
}

/** Simulate one preset with its shipped SMA defaults over that index's full history. */
async function simulateStrategy(presetKey: PresetKey) {
  const preset = ETF_PRESETS[presetKey];
  if (!preset) throw new Error(`Unknown preset "${presetKey}".`);
  const index = preset.index;
  const range = INDEX_DATE_RANGES[index];
  if (!range) throw new Error(`No date range for index "${index}".`);

  const smaPeriod = getDefaultSmaPeriod(index);
  const smaBuffer = getDefaultSmaBuffer(index);
  const startDate = range.min;
  const endDate = new Date().toISOString().slice(0, 10);
  const warmUpStart = getMarketDataWarmUpStartDate(startDate, smaPeriod);

  const config: EtfConfig = {
    id: presetKey.toLowerCase(),
    name: `${presetKey} SMA ${smaPeriod}`,
    leverage: preset.leverage,
    expenseRatio: preset.expenseRatio,
    simulated: true,
    smaEnabled: true,
    smaPeriod,
    smaUpperBuffer: smaBuffer,
    smaLowerBuffer: smaBuffer,
    smaIndex: index,
    smaExecutionMode: DEFAULT_SMA_EXECUTION_MODE,
    riskOffAsset: DEFAULT_RISK_OFF_ASSET,
  };

  const [prices, rates, rawRiskOff, cpi] = await Promise.all([
    loadIndexPrices(index, warmUpStart, endDate),
    loadBorrowRates(warmUpStart, endDate),
    loadRiskOffRawSeries(config.riskOffAsset, warmUpStart, endDate),
    loadInflation(warmUpStart, endDate),
  ]);
  if (prices.length < 2) throw new Error(`Not enough ${index} price data.`);
  const riskOff = alignRiskOffPriceSeries(prices, rawRiskOff);

  const result = simulateWithWarmUp(prices, rates, [config], startDate, smaPeriod, {
    riskOffValuesByAsset: riskOff.closeValuesByAsset,
    riskOffOpenValuesByAsset: riskOff.openValuesByAsset,
    endDate,
  });

  // An SMA config is expanded into a "-base" (no-SMA) and a "-sma" result; the menu windows
  // describe the strategy, so select "-sma" by id rather than by position.
  const strategy = result.etfResults.find((r) => r.id === `${config.id}-sma`);
  if (!strategy) throw new Error(`No SMA result for ${presetKey}.`);

  const realValues = deflate(result.dates, strategy.dailyValues, cpi);
  const curve: Curve = {
    dates: result.dates,
    values: strategy.dailyValues,
    realValues,
    spans: findSpans(result.dates, strategy.dailyValues, realValues),
  };
  return { smaPeriod, smaBuffer, curve };
}

function describe(curve: Curve, span: Span): Record<string, string | number> {
  return {
    "Record high": span.peakDate,
    "Real break-even": span.endDate,
    Years: (span.days / 365.25).toFixed(2),
    Days: span.days,
    "Real CAGR": `${realCagrPct(curve, span).toFixed(2)}%`,
    "Max decline": `${maxDrawdown(curve, span).toFixed(1)}%`,
    "Nominal multiple": (curve.values[span.endIndex]! / curve.values[span.peakIndex]!).toFixed(2),
  };
}

async function main(): Promise<void> {
  const curves = new Map<PresetKey, Curve>();

  for (const presetKey of ["UPRO", "TQQQ"] as const) {
    const { smaPeriod, smaBuffer, curve } = await simulateStrategy(presetKey);
    curves.set(presetKey, curve);
    console.log(
      `\n${presetKey} SMA ${smaPeriod} (-${smaBuffer}%/+${smaBuffer}%) — ` +
        `${curve.dates[0]} .. ${curve.dates[curve.dates.length - 1]} (${curve.dates.length} sessions)`,
    );
    console.log("Longest stretch to real break-even, one per episode:");
    console.table(longestPerEpisode(curve.spans, TOP_N).map((span) => describe(curve, span)));
  }

  console.log("\nWORST_TIME_TO_INVEST_ITEMS (paste into ToolRunHistoryMenu.tsx):\n");
  for (const era of ERAS) {
    const curve = curves.get(era.letf);
    // Spans are length-sorted, so the first record high landing in the era's year is the one
    // that stretches furthest — usually months ahead of where that bear market actually topped.
    const span = curve?.spans.find((s) => s.peakDate.startsWith(era.peakYear));
    if (!curve || !span) {
      console.log(`  // no ${era.letf} span with a record high in ${era.peakYear}`);
      continue;
    }
    console.log(
      `  { letf: "${era.letf}" as const, startDate: "${span.peakDate}", ` +
        `endDate: "${span.endDate}", days: ${span.days}, ` +
        `drawdown: "${maxDrawdown(curve, span).toFixed(1)}%" },`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
