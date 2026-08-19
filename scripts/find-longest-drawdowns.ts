/**
 * Longest declines of the **strategy** equity curve (UPRO-SMA / TQQQ-SMA), which is
 * what the "Worst time to invest" menu in `ToolRunHistoryMenu.tsx` links to.
 *
 * Ranking the raw index total-return path (what this script used to do) answers a
 * different question: the index's worst stretches are not the strategy's worst
 * stretches, because the SMA exits sidestep some of them and whipsaw through others.
 * The 1890s and 1909-15 windows below don't appear on any index-drawdown list, and
 * the index's famous 1973-74 / 2000-02 / 2007-09 bears don't make the strategy's top 3.
 *
 * Parameters come from the shipped defaults (`simulation/defaults.ts`), so this stays
 * in sync with the calibrated SMA periods/buffers and the default risk-off basket.
 * Windows run peak → trough (the decline itself), and `drawdown` is that depth.
 *
 * Run: node --import tsx scripts/find-longest-drawdowns.ts
 *
 * Current output (paste into WORST_TIME_TO_INVEST_ITEMS):
 *
 *   UPRO SMA 186 (-3.6%/+3.6%) — 1885-03-20 .. today
 *     1890-06-04 → 1897-04-19   6.87y   -76.2%
 *     1909-08-17 → 1915-05-14   5.74y   -54.4%
 *     1929-09-03 → 1933-04-21   3.63y   -90.0%
 *   TQQQ SMA 150 (-11.9%/+11.9%) — 1971-02-05 .. today
 *     1987-10-05 → 1990-10-11   3.02y   -79.9%
 *     1983-06-24 → 1985-10-08   2.29y   -78.5%
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

/** How many declines to list per strategy. */
const TOP_N = 8;

interface Decline {
  readonly peakDate: string;
  readonly troughDate: string;
  readonly recoveryDate: string | null;
  readonly depthPct: number;
  readonly declineDays: number;
  readonly underwaterDays: number;
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

/**
 * Split an equity curve into its peak-to-trough declines. Each decline runs from one
 * all-time high to the lowest close before the curve makes a new high, so the episodes
 * partition the series and never overlap.
 */
function findDeclines(dates: readonly string[], values: readonly number[]): Decline[] {
  const declines: Decline[] = [];
  let peak = values[0] ?? 0;
  let peakDate = dates[0] ?? "";
  let trough = peak;
  let troughDate = peakDate;
  let inDecline = false;

  const close = (recoveryDate: string | null, lastDate: string): Decline => ({
    peakDate,
    troughDate,
    recoveryDate,
    depthPct: ((trough - peak) / peak) * 100,
    declineDays: daysBetween(peakDate, troughDate),
    underwaterDays: daysBetween(peakDate, recoveryDate ?? lastDate),
  });

  for (let i = 1; i < values.length; i++) {
    const value = values[i]!;
    if (value >= peak) {
      if (inDecline) declines.push(close(dates[i]!, dates[i]!));
      inDecline = false;
      peak = value;
      peakDate = dates[i]!;
      trough = value;
      troughDate = dates[i]!;
    } else {
      inDecline = true;
      if (value < trough) {
        trough = value;
        troughDate = dates[i]!;
      }
    }
  }
  if (inDecline) declines.push(close(null, dates[dates.length - 1]!));
  return declines;
}

/** Simulate one preset with its shipped SMA defaults over that index's full history. */
async function simulateStrategy(presetKey: "UPRO" | "TQQQ") {
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

  // An SMA config is expanded into a "-base" (no-SMA) and a "-sma" result; the menu
  // windows describe the strategy, so select "-sma" by id rather than by position.
  const strategy = result.etfResults.find((r) => r.id === `${config.id}-sma`);
  if (!strategy) throw new Error(`No SMA result for ${presetKey}.`);

  return { config, smaPeriod, smaBuffer, dates: result.dates, values: strategy.dailyValues };
}

async function report(presetKey: "UPRO" | "TQQQ"): Promise<void> {
  const { smaPeriod, smaBuffer, dates, values } = await simulateStrategy(presetKey);
  const declines = findDeclines(dates, values)
    .sort((a, b) => b.declineDays - a.declineDays)
    .slice(0, TOP_N);

  console.log(
    `\n${presetKey} SMA ${smaPeriod} (-${smaBuffer}%/+${smaBuffer}%) — ` +
      `${dates[0]} .. ${dates[dates.length - 1]} (${dates.length} sessions)`,
  );
  console.log("Longest peak-to-trough declines:");
  console.table(
    declines.map((d) => ({
      Peak: d.peakDate,
      Trough: d.troughDate,
      Years: (d.declineDays / 365.25).toFixed(2),
      Days: d.declineDays,
      Depth: `${d.depthPct.toFixed(1)}%`,
      Recovered: d.recoveryDate ?? "(not yet)",
      "Underwater y": (d.underwaterDays / 365.25).toFixed(2),
      Item: `{ letf: "${presetKey}" as const, startDate: "${d.peakDate}", endDate: "${d.troughDate}", days: ${d.declineDays}, drawdown: "${d.depthPct.toFixed(1)}%" },`,
    })),
  );
}

async function main(): Promise<void> {
  await report("UPRO");
  await report("TQQQ");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
