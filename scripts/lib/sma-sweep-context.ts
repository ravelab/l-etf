/**
 * Data loading + combo evaluation shared by the two SMA search scripts:
 * `calibrate-sma.ts` (monthly, seconds) and `explore-sma-space.ts` (one-off,
 * tens of minutes, forked across cores). Both must score a combo the exact
 * same way or the expensive run's seeds would point the cheap run at the wrong
 * buffers, so there is one implementation and no second copy.
 */

import {
  fetchInflationData,
  getSmaWarmupStartDate,
  getUniquePrimitiveRiskOffAssets,
  loadPrices,
  loadRates,
  loadRiskOffValuesForReference,
  runPrecomputedSweep,
  type MonthlyCpiPoint,
} from "./sweep-data";
import { CONSTANT_INITIAL_INVESTMENT } from "../../src/lib/constants";
import { DEFAULT_RISK_OFF_ASSET } from "../../src/lib/simulation/defaults";
import {
  DEFAULT_COMBO_PRESET,
  createPresetEtfConfig,
  getComboSubPresets,
  type EtfPreset,
} from "../../src/lib/simulation/presets";
import { summarizeSmaRow, type RollingWindow } from "../../src/lib/simulation/rolling";
import { generateSmaSignals } from "../../src/lib/simulation/sma";
import { scoreFullPeriod } from "../../src/lib/simulation/score";
import { comboKey, type SmaCombo } from "../../src/lib/simulation/sma-search";
import { smaScorePenaltyFraction } from "../../src/lib/simulation/sma-search-bounds";
import {
  SMA_CALIBRATION_ERAS,
  SMA_CALIBRATION_VOL_GATE,
  combineEraScores,
  primaryEra,
  type SmaEraKey,
} from "../../src/lib/simulation/sma-calibration-eras";
import type {
  EtfConfig,
  IndexKey,
  PricePoint,
  RatePoint,
  RiskOffAsset,
  SmaComparisonRow,
} from "../../src/lib/simulation/types";

/**
 * How many configs go into one `runPrecomputedSweep` call. The engine holds a
 * full daily-value series per config for the life of the call (see the sweep
 * breadth notes in AGENTS.md), so this bounds peak memory — which matters most
 * in `explore-sma-space.ts`, where several worker processes run at once.
 */
const SMA_EVAL_CHUNK_SIZE = 120;

interface SmaSweepContext {
  indexKey: IndexKey;
  startDate: string;
  endDate: string;
  preset: EtfPreset;
  prices: PricePoint[];
  rates: RatePoint[];
  windows: RollingWindow[];
  riskOffValuesByAsset: Partial<Record<RiskOffAsset, number[]>>;
  riskOffOpenValuesByAsset: Partial<Record<RiskOffAsset, number[]>>;
  monthlyCpi: MonthlyCpiPoint[];
  inflPct: number;
  windowLength: number;
}

interface EvaluatedCombo {
  combo: SmaCombo;
  score: number;
  row: SmaComparisonRow;
  smaOnlySwitches: number;
}

async function buildSmaSweepContext({
  indexKey,
  startDate,
  endDate,
  windowLength,
  maxPeriod,
}: {
  indexKey: IndexKey;
  startDate: string;
  endDate: string;
  windowLength: number;
  maxPeriod: number;
}): Promise<SmaSweepContext> {
  const preset = getComboSubPresets(DEFAULT_COMBO_PRESET).find((p) => p.index === indexKey);
  if (!preset) throw new Error(`No combo sub-preset for index ${indexKey}`);

  const expandedStartDate = getSmaWarmupStartDate(startDate, maxPeriod);
  const [prices, rates, inflationData] = await Promise.all([
    loadPrices(indexKey, expandedStartDate, endDate),
    loadRates(expandedStartDate, endDate),
    fetchInflationData(startDate, endDate),
  ]);
  if (prices.length === 0) {
    throw new Error(`No price data for ${indexKey} over ${expandedStartDate}..${endDate}`);
  }
  const riskOffSeries = await loadRiskOffValuesForReference(
    getUniquePrimitiveRiskOffAssets([DEFAULT_RISK_OFF_ASSET]),
    prices,
    expandedStartDate,
    endDate
  );
  // One observed path; warm-up rows establish signals but are not scored.
  const startIdx = prices.findIndex((point) => point.date >= startDate);
  const endIdx = prices.length - 1;
  if (startIdx < 0 || endIdx <= startIdx) throw new Error("Insufficient calibration history");
  const windows: RollingWindow[] = [{
    startIdx, endIdx, startDate: prices[startIdx].date,
    endDate: prices[endIdx].date, lastRealEndDate: prices[endIdx].date,
    usesSyntheticTail: false,
  }];
  windowLength = (Date.parse(prices[endIdx].date) - Date.parse(prices[startIdx].date)) / (365.25 * 86400000);

  // With per-window CPI available, `summarizeSmaRow` already returns real
  // CAGRs, so the score must not deflate them a second time.
  const inflPct = inflationData.monthlyCpi.length >= 2 ? 0 : inflationData.annualizedInflation * 100;

  return {
    indexKey,
    startDate,
    endDate,
    preset,
    prices,
    rates,
    windows,
    riskOffValuesByAsset: riskOffSeries.closeValuesByAsset,
    riskOffOpenValuesByAsset: riskOffSeries.openValuesByAsset,
    monthlyCpi: inflationData.monthlyCpi,
    inflPct,
    windowLength,
  };
}

const signalInputs = new WeakMap<SmaSweepContext, { dates: string[]; closes: number[] }>();

function configIdFor(combo: SmaCombo): string {
  return `c|${combo.smaPeriod}|${combo.smaUpperBuffer}|${combo.smaLowerBuffer}`;
}

/** Score a batch of combos, chunked so peak memory stays flat in the batch size. */
function evaluateCombos(
  ctx: SmaSweepContext,
  combos: SmaCombo[],
  chunkSize = SMA_EVAL_CHUNK_SIZE
): EvaluatedCombo[] {
  const out: EvaluatedCombo[] = [];
  let inputs = signalInputs.get(ctx);
  if (!inputs) {
    inputs = { dates: ctx.prices.map(p => p.date), closes: ctx.prices.map(p => p.close) };
    signalInputs.set(ctx, inputs);
  }
  for (let offset = 0; offset < combos.length; offset += chunkSize) {
    const slice = combos.slice(offset, offset + chunkSize);
    const configs: EtfConfig[] = slice.map((combo) =>
      createPresetEtfConfig(configIdFor(combo), ctx.preset, {
        smaEnabled: true,
        smaPeriod: combo.smaPeriod,
        smaUpperBuffer: combo.smaUpperBuffer,
        smaLowerBuffer: combo.smaLowerBuffer,
        smaVolGate: SMA_CALIBRATION_VOL_GATE[ctx.indexKey],
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
    for (const combo of slice) {
      // Never join on array index: the engine drops a config whose bucket came
      // back empty, so look each one up by its own id (see AGENTS.md).
      const sims = results.get(configIdFor(combo)) ?? [];
      if (sims.length === 0) continue;
      const row = summarizeSmaRow(combo.smaPeriod, sims, ctx.monthlyCpi);
      // Geometric real CAGR, rather than nominal CAGR minus inflation.
      const realCagr = (Math.pow(row.avgFinalRealValue! / CONSTANT_INITIAL_INVESTMENT, 1 / ctx.windowLength) - 1) * 100;
      row.avgReturn = row.bestReturn = row.worstReturn = realCagr;
      // Gate trades must not make an otherwise dormant SMA rule look active.
      // Warm-up establishes state; a signal at the final close cannot execute.
      const ungated = generateSmaSignals(inputs.dates, inputs.closes, combo.smaPeriod,
        { upper: combo.smaUpperBuffer, lower: combo.smaLowerBuffer });
      const smaOnlySwitches = ungated.signals.filter(signal =>
        signal.date >= ctx.windows[0].startDate && signal.date < ctx.windows[0].endDate).length;
      out.push({ combo, score: scoreFullPeriod(row, ctx.inflPct, ctx.windowLength, smaOnlySwitches), row, smaOnlySwitches });
    }
  }
  return out;
}

/** One built context per calibration era, in the order the era table lists them. */
export interface SmaEraContexts {
  indexKey: IndexKey;
  contexts: Array<{ era: SmaEraKey; ctx: SmaSweepContext }>;
  primary: SmaEraKey;
}

export interface EraEvaluatedCombo {
  combo: SmaCombo;
  /** Weighted mean across eras — the value the search actually maximises. */
  score: number;
  scoresByEra: Partial<Record<SmaEraKey, number>>;
  /** Per-window metrics from the highest-weighted era, for the shipped snapshot. */
  row: SmaComparisonRow;
  smaOnlySwitches: number;
}

export async function buildSmaEraContexts({
  indexKey,
  endDate,
  windowLength,
  maxPeriod,
}: {
  indexKey: IndexKey;
  endDate: string;
  windowLength: number;
  maxPeriod: number;
}): Promise<SmaEraContexts> {
  const contexts: Array<{ era: SmaEraKey; ctx: SmaSweepContext }> = [];
  for (const era of SMA_CALIBRATION_ERAS[indexKey]) {
    contexts.push({
      era: era.key,
      ctx: await buildSmaSweepContext({
        indexKey,
        startDate: era.startDate,
        // Only the observed index era contributes to selection.
        endDate: era.endDate ?? endDate,
        windowLength,
        maxPeriod,
      }),
    });
  }

  return { indexKey, contexts, primary: primaryEra(indexKey).key };
}

/**
 * Score a batch on every era and combine. Each era is its OWN simulation over
 * its own loaded range — never a sub-slice of the longest era's result. The
 * eras start at different dates, so their rolling windows do not line up and
 * their SMA warm-ups differ; re-running is a few ms and keeps every era
 * identical to what the tool pages show for that same date preset.
 */
export function evaluateCombosAcrossEras(
  eras: SmaEraContexts,
  combos: SmaCombo[],
  chunkSize = SMA_EVAL_CHUNK_SIZE
): EraEvaluatedCombo[] {
  const byEra = new Map<SmaEraKey, Map<string, EvaluatedCombo>>();
  for (const { era, ctx } of eras.contexts) {
    const index = new Map<string, EvaluatedCombo>();
    for (const evaluated of evaluateCombos(ctx, combos, chunkSize)) {
      index.set(comboKey(evaluated.combo), evaluated);
    }
    byEra.set(era, index);
  }

  const out: EraEvaluatedCombo[] = [];
  for (const combo of combos) {
    // Join on the combo key, never on position: `evaluateCombos` drops a combo
    // whose bucket came back empty, and it can drop in one era but not another.
    const key = comboKey(combo);
    const penalty = smaScorePenaltyFraction(combo);
    const scoresByEra: Partial<Record<SmaEraKey, number>> = {};
    for (const [era, index] of byEra) {
      const hit = index.get(key);
      if (hit) scoresByEra[era] = hit.score - Math.abs(hit.score) * penalty;
    }
    const primaryHit = byEra.get(eras.primary)?.get(key);
    if (!primaryHit) continue;
    const score = combineEraScores(eras.indexKey, scoresByEra);
    if (!Number.isFinite(score)) continue;
    out.push({ combo, score, scoresByEra, row: primaryHit.row, smaOnlySwitches: primaryHit.smaOnlySwitches });
  }
  return out;
}
