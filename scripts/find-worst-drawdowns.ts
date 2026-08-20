/**
 * The "Worst time to invest" windows in `ToolRunHistoryMenu.tsx`, measured on the **strategy**
 * equity curve (UPRO-SMA / TQQQ-SMA) rather than the index. The index's worst stretches are not
 * the strategy's: the SMA exits sidestep some of them and whipsaw through others, and the menu
 * backtests the strategy.
 *
 * Each window runs peak to bottom. It starts at a record high and ends at the lowest close
 * before the strategy takes that high back, so it covers the whole decline and none of the
 * recovery — bought at the worst possible day, sold at the worst possible day.
 *
 * Two outputs: a ranking of the deepest such declines and `ERAS`, the curated set the menu
 * ships. The menu keeps recognizable episodes rather than the top of the ranking, which reaches
 * back to eras nobody has heard of.
 *
 * Run: node --import tsx scripts/find-worst-drawdowns.ts
 */
import { INDEX_DATE_RANGES } from "@/lib/constants";
import { alignRiskOffPriceSeries, getMarketDataWarmUpStartDate } from "@/lib/fetch-market-data";
import { loadBorrowRates, loadIndexPrices, loadRiskOffRawSeries } from "@/lib/mcp/server-data";
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

/** How many declines to list per strategy in the ranking. */
const TOP_N = 10;

/** The windows the menu ships, as (strategy, year the window's record high falls in). */
interface EraWindow {
  readonly letf: PresetKey;
  readonly peakYear: string;
}

const ERAS: readonly EraWindow[] = [
  { letf: "UPRO", peakYear: "1929" },
  { letf: "UPRO", peakYear: "2007" },
  { letf: "UPRO", peakYear: "1968" },
  { letf: "TQQQ", peakYear: "2000" },
  { letf: "TQQQ", peakYear: "1987" },
];

interface Decline {
  readonly peakIndex: number;
  readonly bottomIndex: number;
  readonly peakDate: string;
  readonly bottomDate: string;
  readonly days: number;
  /** Peak-to-bottom decline as a negative percentage. */
  readonly declinePct: number;
}

interface Curve {
  readonly dates: string[];
  /** Strategy equity in nominal dollars — what the backtest tool charts. */
  readonly values: number[];
  readonly declines: Decline[];
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

/**
 * One entry per drawdown episode: the record high that starts it and the lowest close before
 * the curve takes that high back. Episodes are disjoint by construction — a new record high
 * closes the one in progress — so a cluster of highs days apart can't fill the ranking with a
 * dozen views of the same bear market.
 */
function findDeclines(dates: readonly string[], values: readonly number[]): Decline[] {
  const declines: Decline[] = [];
  let peakIndex = 0;
  let bottomIndex = 0;

  const close = () => {
    if (bottomIndex <= peakIndex) return;
    declines.push({
      peakIndex,
      bottomIndex,
      peakDate: dates[peakIndex]!,
      bottomDate: dates[bottomIndex]!,
      days: daysBetween(dates[peakIndex]!, dates[bottomIndex]!),
      declinePct: ((values[bottomIndex]! - values[peakIndex]!) / values[peakIndex]!) * 100,
    });
  };

  for (let i = 1; i < values.length; i++) {
    if (values[i]! >= values[peakIndex]!) {
      close();
      peakIndex = i;
      bottomIndex = i;
    } else if (values[i]! < values[bottomIndex]!) {
      bottomIndex = i;
    }
  }
  close();

  return declines.sort((a, b) => a.declinePct - b.declinePct);
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

  const [prices, rates, rawRiskOff] = await Promise.all([
    loadIndexPrices(index, warmUpStart, endDate),
    loadBorrowRates(warmUpStart, endDate),
    loadRiskOffRawSeries(config.riskOffAsset, warmUpStart, endDate),
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

  const curve: Curve = {
    dates: result.dates,
    values: strategy.dailyValues,
    declines: findDeclines(result.dates, strategy.dailyValues),
  };
  return { smaPeriod, smaBuffer, curve };
}

/** Trading days the strategy needed to take the peak back, or null if it never has. */
function daysToRecover(curve: Curve, decline: Decline): string {
  const peak = curve.values[decline.peakIndex]!;
  for (let i = decline.bottomIndex + 1; i < curve.values.length; i++) {
    if (curve.values[i]! >= peak) {
      return `${(daysBetween(decline.peakDate, curve.dates[i]!) / 365.25).toFixed(2)}y`;
    }
  }
  return "never";
}

function describe(curve: Curve, decline: Decline): Record<string, string | number> {
  return {
    Peak: decline.peakDate,
    Bottom: decline.bottomDate,
    Years: (decline.days / 365.25).toFixed(2),
    Days: decline.days,
    Decline: `${decline.declinePct.toFixed(1)}%`,
    "Peak retaken after": daysToRecover(curve, decline),
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
    console.log("Deepest peak-to-bottom declines:");
    console.table(curve.declines.slice(0, TOP_N).map((decline) => describe(curve, decline)));
  }

  console.log("\nWORST_TIME_TO_INVEST_ITEMS (paste into ToolRunHistoryMenu.tsx):\n");
  for (const era of ERAS) {
    const curve = curves.get(era.letf);
    // Declines are depth-sorted, so the first one peaking in the era's year is that era's worst.
    const decline = curve?.declines.find((d) => d.peakDate.startsWith(era.peakYear));
    if (!curve || !decline) {
      console.log(`  // no ${era.letf} decline peaking in ${era.peakYear}`);
      continue;
    }
    console.log(
      `  { letf: "${era.letf}" as const, startDate: "${decline.peakDate}", ` +
        `endDate: "${decline.bottomDate}", days: ${decline.days}, ` +
        `drawdown: "${decline.declinePct.toFixed(1)}%" },`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
