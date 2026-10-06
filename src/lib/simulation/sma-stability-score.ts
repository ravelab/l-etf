import {
  comboKey, planBufferNeighborhood, planCombos, planPeriodNeighborhood,
  summarizePlateau, type ScoredCombo, type SmaCombo,
} from "./sma-search";
import {
  SMA_SEARCH_MIN_PERIOD, SMA_SEARCH_MAX_PERIOD,
  SMA_SEARCH_MIN_BUFFER, SMA_SEARCH_MAX_BUFFER,
} from "./sma-search-bounds";

/** A calibration score cannot exceed what its worst immediate neighbour earns. */
export function stabilityAdjustedSmaScore(baseScore: number, worstNeighborScore: number): number {
  return Math.min(baseScore, worstNeighborScore);
}

export function rankStableSmaCandidates<T extends ScoredCombo>(
  candidates: T[],
  center: T,
  evaluate: (combos: SmaCombo[]) => T[],
) {
  const cache = new Map(candidates.map((entry) => [comboKey(entry.combo), entry]));
  const neighbors = (combo: SmaCombo) => planCombos(
    planPeriodNeighborhood(combo.smaPeriod, 1, {
      minPeriod: SMA_SEARCH_MIN_PERIOD, maxPeriod: SMA_SEARCH_MAX_PERIOD,
    }),
    planBufferNeighborhood(combo.smaUpperBuffer, combo.smaLowerBuffer, 0.1, 0.1, {
      minBuffer: SMA_SEARCH_MIN_BUFFER, maxBuffer: SMA_SEARCH_MAX_BUFFER,
    }),
    new Set<string>(),
  );
  const ensure = (entries: T[]) => {
    const missing = new Map<string, SmaCombo>();
    for (const entry of entries) for (const combo of neighbors(entry.combo)) {
      const key = comboKey(combo);
      if (!cache.has(key)) missing.set(key, combo);
    }
    if (missing.size) for (const entry of evaluate([...missing.values()])) {
      cache.set(comboKey(entry.combo), entry);
    }
    // Dropped engine results must not make a neighbourhood look safer.
    for (const key of missing.keys()) {
      if (!cache.has(key)) throw new Error("SMA stability scoring requires every neighboring result");
    }
  };
  const rank = (entry: T) => {
    const local = neighbors(entry.combo).map((combo) => cache.get(comboKey(combo))!);
    if (local.some((point) => !Number.isFinite(point.score))) {
      throw new Error("SMA stability scoring requires finite neighboring scores");
    }
    const stats = summarizePlateau(entry.combo, local, 1, 0.1);
    const score = stabilityAdjustedSmaScore(entry.score, stats.minScore);
    return { entry, score, baseScore: entry.score, stabilityPenalty: entry.score - score, ...stats };
  };
  ensure([center]);
  const floor = rank(center).score;
  // Base score is an upper bound: points below this proven floor cannot win.
  const contenders = [...cache.values()].filter((entry) => entry.score >= floor);
  ensure(contenders);
  const ranked = contenders.map(rank).sort((a, b) => {
    if (Math.abs(a.score - b.score) > 1e-8) return b.score - a.score;
    // Preserve the plateau centre only when it shares the highest stable score.
    const aCenter = comboKey(a.entry.combo) === comboKey(center.combo);
    const bCenter = comboKey(b.entry.combo) === comboKey(center.combo);
    return Number(bCenter) - Number(aCenter)
      || a.entry.combo.smaPeriod - b.entry.combo.smaPeriod
      || a.entry.combo.smaUpperBuffer - b.entry.combo.smaUpperBuffer
      || a.entry.combo.smaLowerBuffer - b.entry.combo.smaLowerBuffer;
  });
  return { ranked, evaluated: [...cache.values()] };
}
