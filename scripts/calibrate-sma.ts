/**
 * Auto-calibrate the SPX/NDX SMA period + buffer by running the same period
 * sweep and asymmetric buffer grid search as the compare-sma-strategies /
 * compare-threshold-strategies tools against real price data, picking the
 * combo with the highest score (src/lib/simulation/score.ts).
 *
 * Runs alternating coordinate ascent (period -> buffer -> period -> ...) per
 * index, capped at a few rounds, since buffer choice shifts which period
 * scores best and vice versa.
 *
 * Usage:
 *   npx tsx scripts/calibrate-sma.ts
 *   npm run calibrate-sma
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  fetchInflationData,
  getLatestSharedTradeDate,
  getSmaWarmupStartDate,
  getUniquePrimitiveRiskOffAssets,
  loadPrices,
  loadRates,
  loadRiskOffValuesForReference,
  runPrecomputedSweep,
  type MonthlyCpiPoint,
} from "./lib/sweep-data";
import { CONSTANT_SP500_SHORTCUT_DATE } from "../src/lib/constants";
import { DEFAULT_RISK_OFF_ASSET, getDefaultSmaBuffer, getDefaultWindowLength } from "../src/lib/simulation/defaults";
import { DEFAULT_COMBO_PRESET, createPresetEtfConfig, getComboSubPresets } from "../src/lib/simulation/presets";
import { buildRollingWindows, summarizeSmaRow, type RollingWindow } from "../src/lib/simulation/rolling";
import { getBestSweepRow } from "../src/lib/sweep";
import {
  dedupePoints,
  pickTopCell,
  planCoarseGrid,
  planFineGrid,
  type AsymmetricSweepRow,
  type BufferPoint,
} from "../src/lib/simulation/buffer-grid-search";
import { scoreRow } from "../src/lib/simulation/score";
import type { EtfConfig, IndexKey, PricePoint, RatePoint, RiskOffAsset } from "../src/lib/simulation/types";
import type { SmaCalibrationIndexResult, SmaCalibrationResult } from "../src/lib/sma-calibration";

const OUTPUT_PATH = join(process.cwd(), "src", "lib", "tool-snapshots", "sma-calibration.json");

const MIN_PERIOD = 20;
const MAX_PERIOD = 280;
const PERIOD_STEP = 5;

const MIN_BUFFER = 0;
const MAX_BUFFER = 24;
const COARSE_STEP = 2;
const FINE_STEP = 0.5;
const FINE_HALF_WIDTH = 1.5;

const MAX_ROUNDS = 3;

type SweepContext = {
  prices: PricePoint[];
  rates: RatePoint[];
  windows: RollingWindow[];
  riskOffValuesByAsset: Partial<Record<RiskOffAsset, number[]>>;
  riskOffOpenValuesByAsset: Partial<Record<RiskOffAsset, number[]>>;
  monthlyCpi: MonthlyCpiPoint[];
  inflPct: number;
  windowLength: number;
};

function runPeriodSweep(
  ctx: SweepContext,
  preset: ReturnType<typeof getComboSubPresets>[number],
  upper: number,
  lower: number
) {
  const configs: EtfConfig[] = [];
  for (let p = MIN_PERIOD; p <= MAX_PERIOD; p += PERIOD_STEP) {
    configs.push(
      createPresetEtfConfig(`sma-${p}`, preset, {
        smaEnabled: true,
        smaPeriod: p,
        smaUpperBuffer: upper,
        smaLowerBuffer: lower,
        riskOffAsset: DEFAULT_RISK_OFF_ASSET,
      })
    );
  }
  const results = runPrecomputedSweep({
    prices: ctx.prices,
    rates: ctx.rates,
    configs,
    windows: ctx.windows,
    riskOffValuesByAsset: ctx.riskOffValuesByAsset,
    riskOffOpenValuesByAsset: ctx.riskOffOpenValuesByAsset,
  });
  const rows = [];
  for (let p = MIN_PERIOD; p <= MAX_PERIOD; p += PERIOD_STEP) {
    const sims = results.get(`sma-${p}`) ?? [];
    rows.push(summarizeSmaRow(p, sims, ctx.monthlyCpi));
  }
  const best = getBestSweepRow(rows, ctx.inflPct, ctx.windowLength);
  if (!best) throw new Error("Period sweep produced no rows");
  return best;
}

function runBufferPoints(
  ctx: SweepContext,
  preset: ReturnType<typeof getComboSubPresets>[number],
  period: number,
  points: BufferPoint[],
  stage: "coarse" | "fine"
): AsymmetricSweepRow[] {
  const configs: EtfConfig[] = points.map(({ upper, lower }) =>
    createPresetEtfConfig(`asym-${upper}-${lower}`, preset, {
      smaEnabled: true,
      smaPeriod: period,
      smaUpperBuffer: upper,
      smaLowerBuffer: lower,
      riskOffAsset: DEFAULT_RISK_OFF_ASSET,
    })
  );
  const results = runPrecomputedSweep({
    prices: ctx.prices,
    rates: ctx.rates,
    configs,
    windows: ctx.windows,
    riskOffValuesByAsset: ctx.riskOffValuesByAsset,
    riskOffOpenValuesByAsset: ctx.riskOffOpenValuesByAsset,
  });
  return points.map(({ upper, lower }) => {
    const sims = results.get(`asym-${upper}-${lower}`) ?? [];
    return {
      ...summarizeSmaRow(upper, sims, ctx.monthlyCpi),
      upperBuffer: upper,
      lowerBuffer: lower,
      stage,
    };
  });
}

function runBufferGridSearch(
  ctx: SweepContext,
  preset: ReturnType<typeof getComboSubPresets>[number],
  period: number
) {
  const coarsePoints = planCoarseGrid({
    minUpper: MIN_BUFFER,
    maxUpper: MAX_BUFFER,
    minLower: MIN_BUFFER,
    maxLower: MAX_BUFFER,
    coarseStep: COARSE_STEP,
  });
  const coarseRows = runBufferPoints(ctx, preset, period, coarsePoints, "coarse");
  const topCoarse = pickTopCell(coarseRows, "score", ctx.inflPct);
  if (!topCoarse) throw new Error("Buffer coarse grid produced no rows");

  const finePoints = dedupePoints(
    planFineGrid({
      centerUpper: topCoarse.upperBuffer,
      centerLower: topCoarse.lowerBuffer,
      halfWidth: FINE_HALF_WIDTH,
      fineStep: FINE_STEP,
      bounds: { minUpper: MIN_BUFFER, maxUpper: MAX_BUFFER, minLower: MIN_BUFFER, maxLower: MAX_BUFFER },
    }),
    coarsePoints
  );
  const fineRows = finePoints.length > 0 ? runBufferPoints(ctx, preset, period, finePoints, "fine") : [];

  const top = pickTopCell([...coarseRows, ...fineRows], "score", ctx.inflPct);
  if (!top) throw new Error("Buffer grid search produced no rows");
  return top;
}

async function calibrateIndex(
  indexKey: IndexKey,
  startDate: string,
  endDate: string,
  windowLength: number
): Promise<SmaCalibrationIndexResult> {
  const preset = getComboSubPresets(DEFAULT_COMBO_PRESET).find((p) => p.index === indexKey);
  if (!preset) throw new Error(`No combo sub-preset for index ${indexKey}`);

  const expandedStartDate = getSmaWarmupStartDate(startDate, MAX_PERIOD);
  const [prices, rates, inflationData] = await Promise.all([
    loadPrices(indexKey, expandedStartDate, endDate),
    loadRates(expandedStartDate, endDate),
    fetchInflationData(startDate, endDate),
  ]);
  const riskOffSeries = await loadRiskOffValuesForReference(
    getUniquePrimitiveRiskOffAssets([DEFAULT_RISK_OFF_ASSET]),
    prices,
    expandedStartDate,
    endDate
  );
  const windows = buildRollingWindows({
    prices,
    windowLength,
    startDateConstraint: startDate,
    endDateConstraint: endDate,
  });

  const inflPct = inflationData.monthlyCpi.length >= 2 ? 0 : inflationData.annualizedInflation * 100;

  const ctx: SweepContext = {
    prices,
    rates,
    windows,
    riskOffValuesByAsset: riskOffSeries.closeValuesByAsset,
    riskOffOpenValuesByAsset: riskOffSeries.openValuesByAsset,
    monthlyCpi: inflationData.monthlyCpi,
    inflPct,
    windowLength,
  };

  let upper = getDefaultSmaBuffer(indexKey);
  let lower = getDefaultSmaBuffer(indexKey);
  let period = MIN_PERIOD;
  let bestBufferRow: AsymmetricSweepRow | null = null;
  let previousPeriod: number | null = null;

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const bestPeriodRow = runPeriodSweep(ctx, preset, upper, lower);
    period = bestPeriodRow.parameterValue;
    console.log(`  [${indexKey}] round ${round}: best period = ${period}d at buffer -${lower}%/${upper}%`);

    bestBufferRow = runBufferGridSearch(ctx, preset, period);
    upper = bestBufferRow.upperBuffer;
    lower = bestBufferRow.lowerBuffer;
    const score = scoreRow(bestBufferRow, inflPct, windowLength);
    console.log(`  [${indexKey}] round ${round}: best buffer = -${lower}%/${upper}% (score ${score.toFixed(2)})`);

    if (previousPeriod !== null && previousPeriod === period) break;
    previousPeriod = period;
  }

  if (!bestBufferRow) throw new Error(`Calibration produced no result for ${indexKey}`);

  return {
    smaPeriod: period,
    smaUpperBuffer: upper,
    smaLowerBuffer: lower,
    score: scoreRow(bestBufferRow, inflPct, windowLength),
    avgReturn: bestBufferRow.avgReturn,
    worstReturn: bestBufferRow.worstReturn,
    avgMaxDrawdown: bestBufferRow.avgMaxDrawdown,
    avgTrades: bestBufferRow.avgTrades,
  };
}

async function main() {
  const startDate = CONSTANT_SP500_SHORTCUT_DATE;
  const endDate = await getLatestSharedTradeDate(["sp500", "nasdaq100", "risk:SGOV"]);
  const windowLength = getDefaultWindowLength();

  console.log(`[calibrate-sma] Calibrating over ${startDate} to ${endDate} (${windowLength}y rolling windows)`);

  console.log("[calibrate-sma] Calibrating SPX...");
  const sp500 = await calibrateIndex("sp500", startDate, endDate, windowLength);
  console.log(`[calibrate-sma] SPX result: period=${sp500.smaPeriod} buffer=-${sp500.smaLowerBuffer}%/${sp500.smaUpperBuffer}% score=${sp500.score.toFixed(2)}`);

  console.log("[calibrate-sma] Calibrating NDX...");
  const nasdaq100 = await calibrateIndex("nasdaq100", startDate, endDate, windowLength);
  console.log(`[calibrate-sma] NDX result: period=${nasdaq100.smaPeriod} buffer=-${nasdaq100.smaLowerBuffer}%/${nasdaq100.smaUpperBuffer}% score=${nasdaq100.score.toFixed(2)}`);

  const payload: SmaCalibrationResult = {
    generatedAt: new Date().toISOString(),
    startDate,
    endDate,
    windowLength,
    sp500,
    nasdaq100,
  };

  mkdirSync(join(process.cwd(), "src", "lib", "tool-snapshots"), { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(payload, null, 2));
  console.log(`[calibrate-sma] Wrote ${OUTPUT_PATH}`);
}

main().catch((error) => {
  console.error("[calibrate-sma] Fatal error:", error);
  process.exitCode = 1;
});
