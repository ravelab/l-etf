/**
 * The "Worst time to invest" windows in `ToolRunHistoryMenu.tsx`, measured on the **strategy**
 * equity curve (UPRO-SMA / TQQQ-SMA) rather than the index. The index's worst stretches are not
 * the strategy's: the SMA exits sidestep some of them and whipsaw through others, and the menu
 * backtests the strategy.
 *
 * Each shipped window starts at an era's local max and ends at the last close still below that
 * peak **in real terms** — so every one of them spans a stretch that ended with less purchasing
 * power than it started with, and the tool reports a negative real CAGR. Nominal break-even
 * arrives much earlier in inflationary eras; that is the dollar shrinking, not the position
 * growing, which is exactly what these windows are meant to show.
 *
 * Two outputs: the nominal underwater ranking (for spotting eras worth surfacing) and `ERAS`,
 * the curated set the menu ships. The menu keeps recognizable episodes rather than the top of
 * the ranking, which is dominated by pre-1900 whipsaw eras nobody has heard of.
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

/** How many underwater spans to list per strategy in the full ranking. */
const TOP_N = 10;

/** The windows the menu ships, as (strategy, year the era's local max falls in). */
interface EraWindow {
  readonly letf: "UPRO" | "TQQQ";
  /** Year the strategy's local max falls in; the year's longest underwater span wins. */
  readonly peakYear: string;
}

const ERAS: readonly EraWindow[] = [
  { letf: "UPRO", peakYear: "1965" },
  { letf: "UPRO", peakYear: "1929" },
  { letf: "UPRO", peakYear: "2007" },
  { letf: "TQQQ", peakYear: "2000" },
  { letf: "TQQQ", peakYear: "1987" },
];

interface Underwater {
  readonly peakDate: string;
  readonly troughDate: string;
  /** Last close still below the peak; `endDate` of the menu window. */
  readonly lastUnderwaterDate: string;
  /** First close back at or above the peak, or null if still underwater today. */
  readonly recoveryDate: string | null;
  readonly depthPct: number;
  readonly underwaterDays: number;
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

/**
 * Split an equity curve into its underwater spans. Each span runs from one all-time high to
 * the last close below it, so the spans partition the series and never overlap.
 */
function findUnderwaterSpans(dates: readonly string[], values: readonly number[]): Underwater[] {
  const spans: Underwater[] = [];
  let peak = values[0] ?? 0;
  let peakDate = dates[0] ?? "";
  let trough = peak;
  let troughDate = peakDate;
  let inSpan = false;

  const close = (lastUnderwaterDate: string, recoveryDate: string | null): Underwater => ({
    peakDate,
    troughDate,
    lastUnderwaterDate,
    recoveryDate,
    depthPct: ((trough - peak) / peak) * 100,
    underwaterDays: daysBetween(peakDate, lastUnderwaterDate),
  });

  for (let i = 1; i < values.length; i++) {
    const value = values[i]!;
    if (value >= peak) {
      if (inSpan) spans.push(close(dates[i - 1]!, dates[i]!));
      inSpan = false;
      peak = value;
      peakDate = dates[i]!;
      trough = value;
      troughDate = dates[i]!;
    } else {
      inSpan = true;
      if (value < trough) {
        trough = value;
        troughDate = dates[i]!;
      }
    }
  }
  if (inSpan) spans.push(close(dates[dates.length - 1]!, null));
  return spans;
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

  // An SMA config is expanded into a "-base" (no-SMA) and a "-sma" result; the menu
  // windows describe the strategy, so select "-sma" by id rather than by position.
  const strategy = result.etfResults.find((r) => r.id === `${config.id}-sma`);
  if (!strategy) throw new Error(`No SMA result for ${presetKey}.`);

  return {
    smaPeriod,
    smaBuffer,
    dates: result.dates,
    values: strategy.dailyValues,
    realValues: deflate(result.dates, strategy.dailyValues, cpi),
  };
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
 * Last close still below `peakDate`'s level in real terms — where a window ends. Note this is
 * the *last* dip under the peak, not the first recovery: an inflationary era can carry the
 * nominal curve back over the line years before purchasing power follows.
 */
function lastRealCloseBelowPeak(
  dates: readonly string[],
  realValues: readonly number[],
  peakDate: string,
): string | null {
  const peakIndex = dates.indexOf(peakDate);
  if (peakIndex < 0) return null;
  const peakLevel = realValues[peakIndex]!;
  let lastBelow = -1;
  for (let i = peakIndex + 1; i < realValues.length; i++) {
    if (realValues[i]! < peakLevel) lastBelow = i;
  }
  return lastBelow < 0 ? null : dates[lastBelow]!;
}

/** Deepest peak-to-trough decline inside `[from, to]`, as a negative percentage. */
function maxDrawdownInWindow(
  dates: readonly string[],
  values: readonly number[],
  from: string,
  to: string,
): number {
  let peak = -Infinity;
  let worst = 0;
  for (let i = 0; i < dates.length; i++) {
    const date = dates[i]!;
    if (date < from) continue;
    if (date > to) break;
    const value = values[i]!;
    if (value > peak) peak = value;
    const drawdown = ((value - peak) / peak) * 100;
    if (drawdown < worst) worst = drawdown;
  }
  return worst;
}

function menuItem(letf: string, startDate: string, endDate: string, depthPct: number): string {
  return (
    `  { letf: "${letf}" as const, startDate: "${startDate}", endDate: "${endDate}", ` +
    `days: ${daysBetween(startDate, endDate)}, drawdown: "${depthPct.toFixed(1)}%" },`
  );
}

function describe(span: Underwater): Record<string, string | number> {
  return {
    Peak: span.peakDate,
    "Underwater until": span.lastUnderwaterDate,
    Years: (span.underwaterDays / 365.25).toFixed(2),
    Days: span.underwaterDays,
    Depth: `${span.depthPct.toFixed(1)}%`,
    Trough: span.troughDate,
    "Broke even": span.recoveryDate ?? "(not yet)",
  };
}

async function main(): Promise<void> {
  const curves = new Map<
    string,
    { dates: string[]; values: number[]; realValues: number[]; spans: Underwater[] }
  >();

  for (const presetKey of ["UPRO", "TQQQ"] as const) {
    const { smaPeriod, smaBuffer, dates, values, realValues } = await simulateStrategy(presetKey);
    const spans = findUnderwaterSpans(dates, values).sort(
      (a, b) => b.underwaterDays - a.underwaterDays,
    );
    curves.set(presetKey, { dates, values, realValues, spans });

    console.log(
      `\n${presetKey} SMA ${smaPeriod} (-${smaBuffer}%/+${smaBuffer}%) — ` +
        `${dates[0]} .. ${dates[dates.length - 1]} (${dates.length} sessions)`,
    );
    console.log("Longest time underwater:");
    console.table(spans.slice(0, TOP_N).map(describe));
  }

  console.log("\nWORST_TIME_TO_INVEST_ITEMS (paste into ToolRunHistoryMenu.tsx):\n");
  for (const era of ERAS) {
    const curve = curves.get(era.letf);
    const span = curve?.spans.find((s) => s.peakDate.startsWith(era.peakYear));
    if (!curve || !span) {
      console.log(`  // no ${era.letf} underwater span peaking in ${era.peakYear}`);
      continue;
    }
    const endDate = lastRealCloseBelowPeak(curve.dates, curve.realValues, span.peakDate);
    if (!endDate) {
      console.log(`  // ${era.letf} ${span.peakDate} never dips below its real peak again`);
      continue;
    }
    const depthPct = maxDrawdownInWindow(curve.dates, curve.values, span.peakDate, endDate);
    console.log(menuItem(era.letf, span.peakDate, endDate, depthPct));
  }

  console.log("\nReal outcome over each shipped window:");
  console.table(
    ERAS.flatMap((era) => {
      const curve = curves.get(era.letf);
      const span = curve?.spans.find((s) => s.peakDate.startsWith(era.peakYear));
      if (!curve || !span) return [];
      const endDate = lastRealCloseBelowPeak(curve.dates, curve.realValues, span.peakDate);
      if (!endDate) return [];
      const from = curve.dates.indexOf(span.peakDate);
      const to = curve.dates.indexOf(endDate);
      const realMultiple = curve.realValues[to]! / curve.realValues[from]!;
      const span_days = daysBetween(span.peakDate, endDate);
      return [
        {
          Strategy: era.letf,
          Window: `${span.peakDate} .. ${endDate}`,
          Years: (span_days / 365.25).toFixed(2),
          "Real multiple": realMultiple.toFixed(3),
          "Real CAGR": `${((Math.pow(realMultiple, 365.25 / span_days) - 1) * 100).toFixed(2)}%`,
          "Nominal multiple": (curve.values[to]! / curve.values[from]!).toFixed(2),
        },
      ];
    }),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
