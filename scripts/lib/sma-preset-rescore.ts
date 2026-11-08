/**
 * Re-score the saved Signals presets under the current engine without searching.
 *
 * For engine or gate changes that leave the selected rules standing (the RSI
 * crash brake, 2026-11, moved every gated score but not the calibrated bands):
 * every stored score, displayed CAGR and regime-distance figure is recomputed
 * the way `unit-tests/sma-cagr-presets.test.ts` checks it, then the sets are
 * re-ranked. A full `npm run explore-sma-cagr` re-selects the alternatives
 * instead, and may promote a new default band.
 */
import { buildSmaEraContexts, evaluateCombosAcrossEras, type EraEvaluatedCombo } from "./sma-sweep-context";
import { withEraCagrs } from "./sma-preset-era-cagrs";
import { comboKey, planBufferNeighborhood, planCombos, planPeriodNeighborhood, type SmaCombo } from "../../src/lib/simulation/sma-search";
import {
  SMA_SEARCH_MAX_BUFFER, SMA_SEARCH_MAX_PERIOD, SMA_SEARCH_MIN_BUFFER, SMA_SEARCH_MIN_PERIOD,
} from "../../src/lib/simulation/sma-search-bounds";
import { stabilityAdjustedSmaScore } from "../../src/lib/simulation/sma-stability-score";
import { rankSmaPresetSets } from "../../src/lib/simulation/sma-preset-ranking";
import { SMA_CALIBRATION_VOL_GATE } from "../../src/lib/simulation/sma-calibration-eras";
import { DEFAULT_RISK_OFF_ASSETS } from "../../src/lib/simulation/defaults";
import { DEFAULT_SMA_EXECUTION_MODE } from "../../src/lib/input-normalization";
import { CONSTANT_NASDAQ100_SHORTCUT_DATE } from "../../src/lib/constants";
import { runBacktestCore } from "../../src/lib/mcp/tools/run-backtest";
import { loadIndexPrices } from "../../src/lib/mcp/server-data";
import type { IndexKey } from "../../src/lib/simulation/types";

const INDICES: IndexKey[] = ["sp500", "nasdaq100"];

type Rule = SmaCombo & { score: number; finalMultiple: number };
interface SavedPresets {
  startDate: string;
  endDate: string;
  windowLength: number;
  presets: Array<{ isCalibratedDefault: boolean; sp500: Rule; nasdaq100: Rule }>;
  bestFound: Record<IndexKey, SmaCombo & { score: number }>;
  minRegimeDifferencePct: Record<IndexKey, number>;
}

/** The complete ±1-day / ±0.1% neighborhood the stability score walks, centre included. */
function neighborhood(combo: SmaCombo): SmaCombo[] {
  return planCombos(
    planPeriodNeighborhood(combo.smaPeriod, 1, { minPeriod: SMA_SEARCH_MIN_PERIOD, maxPeriod: SMA_SEARCH_MAX_PERIOD }),
    planBufferNeighborhood(combo.smaUpperBuffer, combo.smaLowerBuffer, 0.1, 0.1,
      { minBuffer: SMA_SEARCH_MIN_BUFFER, maxBuffer: SMA_SEARCH_MAX_BUFFER }),
    new Set<string>(),
  );
}

interface StableScore {
  score: number;
  baseScore: number;
  stabilityPenalty: number;
  scoresByEra: EraEvaluatedCombo["scoresByEra"];
}

async function stableScores(index: IndexKey, saved: SavedPresets, combos: SmaCombo[]): Promise<Map<string, StableScore>> {
  const contexts = await buildSmaEraContexts({
    indexKey: index, endDate: saved.endDate, windowLength: saved.windowLength, maxPeriod: SMA_SEARCH_MAX_PERIOD,
  });
  const planned = new Map(combos.flatMap(neighborhood).map((combo) => [comboKey(combo), combo]));
  // Join on the combo key, never position: the engine drops combos independently.
  const results = new Map(evaluateCombosAcrossEras(contexts, [...planned.values()]).map((row) => [comboKey(row.combo), row]));
  const scoreOf = (combo: SmaCombo) => {
    const row = results.get(comboKey(combo));
    if (!row || !Number.isFinite(row.score)) throw new Error(`${index} rescoring is missing ${comboKey(combo)}`);
    return row;
  };
  const out = new Map<string, StableScore>();
  for (const combo of combos) {
    const centre = scoreOf(combo);
    const worst = Math.min(...neighborhood(combo).map((neighbor) => scoreOf(neighbor).score));
    const score = stabilityAdjustedSmaScore(centre.score, worst);
    out.set(comboKey(combo), { score, baseScore: centre.score, stabilityPenalty: centre.score - score, scoresByEra: centre.scoresByEra });
  }
  return out;
}

/** Smallest share of days on which two presets' regimes differ, over the displayed modern range. */
async function minRegimeDifferencePct(index: IndexKey, rules: SmaCombo[], startDate: string, endDate: string): Promise<number> {
  const modernStart = index === "sp500" ? startDate : CONSTANT_NASDAQ100_SHORTCUT_DATE;
  const dates = (await loadIndexPrices(index, modernStart, endDate)).map((row) => row.date);
  const regimes: boolean[][] = [];
  for (const rule of rules) {
    const result = await runBacktestCore({
      preset: index === "sp500" ? "UPRO" : "TQQQ", startDate: modernStart, endDate, smaEnabled: true,
      smaPeriod: rule.smaPeriod, smaUpperBuffer: rule.smaUpperBuffer, smaLowerBuffer: rule.smaLowerBuffer,
      smaVolGate: SMA_CALIBRATION_VOL_GATE[index],
      riskOffAsset: DEFAULT_RISK_OFF_ASSETS[index], smaExecutionMode: DEFAULT_SMA_EXECUTION_MODE,
    });
    let invested = result.smaStartInvested ?? true;
    let trade = 0;
    regimes.push(dates.map((date) => {
      while (trade < result.trades.length && result.trades[trade].date <= date) invested = result.trades[trade++].type === "buy";
      return invested;
    }));
  }
  let min = 1;
  for (let a = 0; a < regimes.length; a++) for (let b = a + 1; b < regimes.length; b++) {
    min = Math.min(min, regimes[a].filter((invested, day) => invested !== regimes[b][day]).length / dates.length);
  }
  return min * 100;
}

export async function rescoreSavedPresets<T extends SavedPresets>(saved: T) {
  const scored = { ...saved, presets: saved.presets.map((preset) => ({ ...preset })) };
  const bestFound = { ...saved.bestFound };
  for (const index of INDICES) {
    const combos = [...saved.presets.map((preset) => preset[index]), saved.bestFound[index]];
    const scores = await stableScores(index, saved, combos);
    scored.presets = scored.presets.map((preset) => ({ ...preset, [index]: { ...preset[index], ...scores.get(comboKey(preset[index]))! } }));
    bestFound[index] = { ...saved.bestFound[index], score: scores.get(comboKey(saved.bestFound[index]))!.score };
  }
  const ranked = rankSmaPresetSets(scored.presets);
  const presets = await withEraCagrs(ranked, saved.startDate, saved.endDate);
  const regimeDifference = Object.fromEntries(await Promise.all(INDICES.map(async (index) =>
    [index, await minRegimeDifferencePct(index, presets.map((preset) => preset[index]), saved.startDate, saved.endDate)] as const)));
  return { ...saved, rescoredAt: new Date().toISOString(), bestFound, minRegimeDifferencePct: regimeDifference, presets };
}
