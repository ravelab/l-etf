/**
 * Auto-calibrate the SPX/NDX SMA period + asymmetric buffer, monthly, by a
 * JOINT search over all three parameters at once, scored across every
 * calibration era (`simulation/sma-calibration-eras.ts`) and combined by
 * weight — so a band cannot win by suiting the modern range alone.
 *
 * It used to be coordinate descent: sweep the period at one hand-picked
 * "sane" buffer, then grid-search the buffer at whatever period won. That
 * assumes the surface is separable, and it is not — the best buffer depends
 * heavily on the period (SPX wants ~3% near 185d but ~9-15% near 40d), so the
 * hand-picked starting buffer decided which basin the whole search lived in.
 * It shipped NDX 150d -17.6%/+20.4% while 131d -18%/+20% scored ~9% higher.
 *
 * A full joint grid is far too slow for a monthly Vercel build, so the work is
 * split. `scripts/explore-sma-space.ts` searches the whole space exhaustively
 * (tens of minutes, run by hand) and records the best buffer pair AT EACH
 * PERIOD. This script reads those seeds and does a real joint search in ~30s:
 *
 *   1. score every period at its seeded buffers            (all periods, 1 cell each)
 *   2. open up the best few *separated* periods            (buffer square, 0.5%)
 *   3. re-search the period axis around the best of those  (period x buffer)
 *   4. refine the winners' buffers to 0.1%
 *   5. hill-climb the leader until it is a local max at that resolution
 *   6. settle exact ties on whose neighbourhood is safer, then record it
 *
 * Step 1 still visits every period, so a stale seed costs accuracy at one
 * period rather than hiding a basin. With no snapshot at all, a bounded coarse
 * scan stands in for it and the run still completes (less precisely).
 *
 * Usage:
 *   npm run calibrate-sma
 */

import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { getDefaultWindowLength } from "../src/lib/simulation/defaults";
import {
  SMA_CALIBRATION_ERAS,
  describeEraWeights,
  primaryEra,
} from "../src/lib/simulation/sma-calibration-eras";
import { buildAxis } from "../src/lib/simulation/grid-axis";
import {
  comboKey,
  dedupeCombos,
  pickTop,
  pickTopDistinctPeriods,
  planBufferNeighborhood,
  planCombos,
  planPeriodNeighborhood,
  summarizePlateau,
  type SmaCombo,
} from "../src/lib/simulation/sma-search";
import { PLATEAU_TOLERANCE, findPlateau } from "../src/lib/simulation/plateau";
import {
  SMA_SEARCH_MAX_BUFFER,
  SMA_SEARCH_MAX_PERIOD,
  SMA_SEARCH_MIN_BUFFER,
  SMA_SEARCH_MIN_PERIOD,
} from "../src/lib/simulation/sma-search-bounds";
import {
  readSmaSearchSpaceSnapshot,
  seedForPeriod,
  type SmaSearchSpaceIndexResult,
  type SmaSeed,
} from "../src/lib/sma-search-space";
import {
  SMA_CALIBRATION_SNAPSHOT_PATH,
  type SmaCalibrationIndexResult,
  type SmaCalibrationResult,
} from "../src/lib/sma-calibration";
import {
  buildSmaEraContexts,
  evaluateCombosAcrossEras,
  type EraEvaluatedCombo,
  type SmaEraContexts,
} from "./lib/sma-sweep-context";
import { getLatestSharedTradeDate } from "./lib/sweep-data";
import type { IndexKey } from "../src/lib/simulation/types";

const PERIOD_BOUNDS = { minPeriod: SMA_SEARCH_MIN_PERIOD, maxPeriod: SMA_SEARCH_MAX_PERIOD };
const BUFFER_BOUNDS = { minBuffer: SMA_SEARCH_MIN_BUFFER, maxBuffer: SMA_SEARCH_MAX_BUFFER };

/** Step 2: how many separated period basins to open up, and how far apart. */
const BASIN_COUNT = 8;
const BASIN_MIN_SEPARATION = 4;
const BASIN_BUFFER_HALF_WIDTH = 2;
const BASIN_BUFFER_STEP = 0.5;

/** Step 3: re-search the period axis around the best basins. */
const PERIOD_REFINE_COUNT = 4;
const PERIOD_REFINE_HALF_WIDTH = 3;
const PERIOD_REFINE_BUFFER_HALF_WIDTH = 0.5;

/** Step 4: final buffer precision. Half-width exceeds the 0.5 grid it refines. */
const FINE_COUNT = 2;
const FINE_BUFFER_HALF_WIDTH = 0.6;
const FINE_BUFFER_STEP = 0.1;

/**
 * Step 5: how many times the polish may follow the leader to a better
 * neighbour. Bounded so a flat ridge cannot walk the search across the grid.
 */
const MAX_POLISH_ROUNDS = 4;

/**
 * Step 6: map the flat region around the leader and ship its MIDDLE.
 *
 * The argmax routinely sits on a cliff edge — NDX 125/126/127 all scored
 * 18,050 while 128 scored 8,780, so shipping 127 put the rule one step from a
 * 2.1x drop for nothing. `maxCombos` bounds the flood fill; a plateau bigger
 * than that is flat enough that its sampled middle is a fine answer.
 */
const PLATEAU_MAX_COMBOS = 400;

/**
 * Stand-in seeds when no exhaustive snapshot exists: a coarse joint scan,
 * bounded so a missing artifact costs minutes rather than the hours the real
 * exhaustive run takes. It is a dev convenience — the snapshot is committed and
 * `unit-tests/sma-calibration-artifacts.test.ts` fails if it goes missing — so
 * it is sized to still answer, not to match a seeded run.
 */
const FALLBACK_PERIOD_STEP = 5;
const FALLBACK_BUFFER_STEP = 3;

/** Every period the search ranks in step 1. */
function allPeriods(): number[] {
  const out: number[] = [];
  for (let p = SMA_SEARCH_MIN_PERIOD; p <= SMA_SEARCH_MAX_PERIOD; p++) out.push(p);
  return out;
}

function buildFallbackSeeds(
  eras: SmaEraContexts,
  seen: Set<string>
): { seeds: SmaSeed[]; evaluated: EraEvaluatedCombo[] } {
  const axis = buildAxis(SMA_SEARCH_MIN_BUFFER, SMA_SEARCH_MAX_BUFFER, FALLBACK_BUFFER_STEP);
  const bufferPoints = axis.flatMap((upper) => axis.map((lower) => ({ upper, lower })));
  const periods: number[] = [];
  for (let p = SMA_SEARCH_MIN_PERIOD; p <= SMA_SEARCH_MAX_PERIOD; p += FALLBACK_PERIOD_STEP) periods.push(p);

  const evaluated = evaluateCombosAcrossEras(eras, planCombos(periods, bufferPoints, seen));
  const bestByPeriod = new Map<number, SmaSeed>();
  for (const entry of evaluated) {
    const current = bestByPeriod.get(entry.combo.smaPeriod);
    if (!current || entry.score > current.score) {
      bestByPeriod.set(entry.combo.smaPeriod, {
        smaPeriod: entry.combo.smaPeriod,
        smaUpperBuffer: entry.combo.smaUpperBuffer,
        smaLowerBuffer: entry.combo.smaLowerBuffer,
        score: entry.score,
        scoresByEra: { ...entry.scoresByEra },
      });
    }
  }
  return {
    seeds: [...bestByPeriod.values()].sort((a, b) => a.smaPeriod - b.smaPeriod),
    evaluated,
  };
}

async function calibrateIndex(
  indexKey: IndexKey,
  endDate: string,
  windowLength: number,
  searchSpace: SmaSearchSpaceIndexResult | null
): Promise<SmaCalibrationIndexResult> {
  const startDate = primaryEra(indexKey).startDate;
  const eras = await buildSmaEraContexts({
    indexKey,
    endDate,
    windowLength,
    maxPeriod: SMA_SEARCH_MAX_PERIOD,
  });

  const seen = new Set<string>();
  const evaluated: EraEvaluatedCombo[] = [];

  // Step 1 — rank every period at the buffers the exhaustive run found best
  // there. This is the only stage that sees the whole period axis.
  let seeds = searchSpace?.periodSeeds ?? [];
  if (seeds.length === 0) {
    console.log(`  [${indexKey}] no search-space snapshot — falling back to a coarse joint scan`);
    const fallback = buildFallbackSeeds(eras, seen);
    seeds = fallback.seeds;
    evaluated.push(...fallback.evaluated);
  }
  if (seeds.length === 0) throw new Error(`[${indexKey}] could not establish any buffer seeds`);

  const seededCombos: SmaCombo[] = [];
  for (const smaPeriod of allPeriods()) {
    const seed = seedForPeriod(seeds, smaPeriod);
    if (!seed) continue;
    seededCombos.push({
      smaPeriod,
      smaUpperBuffer: seed.smaUpperBuffer,
      smaLowerBuffer: seed.smaLowerBuffer,
    });
  }
  evaluated.push(...evaluateCombosAcrossEras(eras, dedupeCombos(seededCombos, seen)));

  // Step 2 — open up the best few *separated* periods over a real buffer square.
  const basins = pickTopDistinctPeriods(evaluated, BASIN_COUNT, BASIN_MIN_SEPARATION);
  const basinCombos: SmaCombo[] = [];
  for (const basin of basins) {
    basinCombos.push(
      ...planCombos(
        [basin.combo.smaPeriod],
        planBufferNeighborhood(
          basin.combo.smaUpperBuffer,
          basin.combo.smaLowerBuffer,
          BASIN_BUFFER_HALF_WIDTH,
          BASIN_BUFFER_STEP,
          BUFFER_BOUNDS
        ),
        seen
      )
    );
  }
  evaluated.push(...evaluateCombosAcrossEras(eras, basinCombos));

  // Step 3 — the buffer winner may belong at a neighbouring period, so search
  // the two axes together around the leaders. Distinct periods again: a plain
  // top-N here is four cells of the SAME square step 2 just finished.
  const periodRefineCombos: SmaCombo[] = [];
  for (const leader of pickTopDistinctPeriods(evaluated, PERIOD_REFINE_COUNT, BASIN_MIN_SEPARATION)) {
    periodRefineCombos.push(
      ...planCombos(
        planPeriodNeighborhood(leader.combo.smaPeriod, PERIOD_REFINE_HALF_WIDTH, PERIOD_BOUNDS),
        planBufferNeighborhood(
          leader.combo.smaUpperBuffer,
          leader.combo.smaLowerBuffer,
          PERIOD_REFINE_BUFFER_HALF_WIDTH,
          BASIN_BUFFER_STEP,
          BUFFER_BOUNDS
        ),
        seen
      )
    );
  }
  evaluated.push(...evaluateCombosAcrossEras(eras, periodRefineCombos));

  // Step 4 — take the buffers from the 0.5% grid down to 0.1%.
  const fineCombos: SmaCombo[] = [];
  for (const leader of pickTopDistinctPeriods(evaluated, FINE_COUNT, BASIN_MIN_SEPARATION)) {
    fineCombos.push(
      ...planCombos(
        [leader.combo.smaPeriod],
        planBufferNeighborhood(
          leader.combo.smaUpperBuffer,
          leader.combo.smaLowerBuffer,
          FINE_BUFFER_HALF_WIDTH,
          FINE_BUFFER_STEP,
          BUFFER_BOUNDS
        ),
        seen
      )
    );
  }
  evaluated.push(...evaluateCombosAcrossEras(eras, fineCombos));

  // Step 5 — polish. Evaluate the leader's finest-resolution neighbourhood and
  // re-pick; repeat while the leader moves. Without this the winner could be a
  // point whose own 0.1% neighbours were never scored — and step 4 only
  // refined two basins, so the leader after it is not guaranteed to be a local
  // maximum. The loop both guarantees that and leaves the neighbourhood fully
  // evaluated, which is what the plateau stats below then read.
  let winner = pickTop(evaluated, 1)[0];
  if (!winner) throw new Error(`[${indexKey}] joint search produced no scored combos`);
  for (let round = 0; round < MAX_POLISH_ROUNDS; round++) {
    const polishCombos = planCombos(
      planPeriodNeighborhood(winner.combo.smaPeriod, 1, PERIOD_BOUNDS),
      planBufferNeighborhood(
        winner.combo.smaUpperBuffer,
        winner.combo.smaLowerBuffer,
        FINE_BUFFER_STEP,
        FINE_BUFFER_STEP,
        BUFFER_BOUNDS
      ),
      seen
    );
    if (polishCombos.length === 0) break;
    evaluated.push(...evaluateCombosAcrossEras(eras, polishCombos));
    const next = pickTop(evaluated, 1)[0];
    if (next.combo.smaPeriod === winner.combo.smaPeriod &&
        next.combo.smaUpperBuffer === winner.combo.smaUpperBuffer &&
        next.combo.smaLowerBuffer === winner.combo.smaLowerBuffer) {
      break;
    }
    winner = next;
  }

  // Step 6 — walk outward from the leader over every combo that scores within
  // `PLATEAU_TOLERANCE` of it, then ship the middle of that region rather than
  // its peak. Flood fill rather than a fixed box: the plateau's shape is not
  // known ahead of time, and only points reachable from the leader count, so a
  // separate same-height basin cannot drag the centre into the valley between.
  const plateauSeen = new Set<string>();
  const plateauScored: EraEvaluatedCombo[] = [];
  const frontier: SmaCombo[] = [winner.combo];
  plateauSeen.add(comboKey(winner.combo));
  plateauScored.push(winner);
  const plateauFloor = winner.score - Math.abs(winner.score) * PLATEAU_TOLERANCE;

  while (frontier.length > 0 && plateauScored.length < PLATEAU_MAX_COMBOS) {
    const current = frontier.shift() as SmaCombo;
    const neighbours = planCombos(
      planPeriodNeighborhood(current.smaPeriod, 1, PERIOD_BOUNDS),
      planBufferNeighborhood(
        current.smaUpperBuffer,
        current.smaLowerBuffer,
        FINE_BUFFER_STEP,
        FINE_BUFFER_STEP,
        BUFFER_BOUNDS
      ),
      plateauSeen
    );
    if (neighbours.length === 0) continue;
    const scored = evaluateCombosAcrossEras(eras, neighbours);
    plateauScored.push(...scored);
    for (const entry of scored) {
      // Only a near-best neighbour is worth expanding from; anything lower is
      // the plateau's edge and the fill stops there.
      if (entry.score >= plateauFloor) frontier.push(entry.combo);
    }
  }
  // The fill can turn up something better than the point it started from.
  evaluated.push(...plateauScored.filter((entry) => entry !== winner));

  const plateauResult = findPlateau(
    plateauScored.map((entry) => ({
      item: entry,
      coords: [entry.combo.smaPeriod, entry.combo.smaUpperBuffer, entry.combo.smaLowerBuffer],
      score: entry.score,
    })),
    { tolerance: PLATEAU_TOLERANCE, steps: [1, FINE_BUFFER_STEP, FINE_BUFFER_STEP] }
  );
  if (plateauResult && plateauResult.center.item !== winner) {
    const describe = (c: SmaCombo) => `${c.smaPeriod}d -${c.smaLowerBuffer}%/+${c.smaUpperBuffer}%`;
    console.log(
      `  [${indexKey}] plateau of ${plateauResult.members.length} combos (${plateauResult.widths[0]}d x ${plateauResult.widths[1].toFixed(1)}% x ${plateauResult.widths[2].toFixed(1)}%) — centring ${describe(plateauResult.center.item.combo)} over peak ${describe(plateauResult.peak.item.combo)}`
    );
    winner = plateauResult.center.item;
  }

  // Price the winner's immediate surroundings. A spike that collapses one step
  // away is an artifact of this sample; recording it keeps that visible
  // instead of implicit. It does not change the pick.
  const plateau = summarizePlateau(winner.combo, evaluated, 1, FINE_BUFFER_STEP);

  const eraDetail = (entry: EraEvaluatedCombo) =>
    SMA_CALIBRATION_ERAS[indexKey]
      .map((era) => `${era.key}=${(entry.scoresByEra[era.key] ?? Number.NaN).toFixed(0)}`)
      .join(" ");
  console.log(
    `  [${indexKey}] ${evaluated.length} combos evaluated · winner ${winner.combo.smaPeriod}d -${winner.combo.smaLowerBuffer}%/+${winner.combo.smaUpperBuffer}% weighted=${winner.score.toFixed(1)} (${eraDetail(winner)})`
  );
  // Print the runners-up from separate basins: when the winner shifts between
  // months, the build log is the only place to see what it beat.
  for (const runnerUp of pickTopDistinctPeriods(evaluated, 5, BASIN_MIN_SEPARATION).slice(1)) {
    console.log(
      `  [${indexKey}]   runner-up ${runnerUp.combo.smaPeriod}d -${runnerUp.combo.smaLowerBuffer}%/+${runnerUp.combo.smaUpperBuffer}% weighted=${runnerUp.score.toFixed(1)} (${eraDetail(runnerUp)})`
    );
  }
  console.log(
    `  [${indexKey}] neighbourhood: min=${plateau.minScore.toFixed(1)} median=${plateau.medianScore.toFixed(1)} over ${plateau.neighborCount} adjacent combos`
  );

  return {
    startDate,
    eraWeights: Object.fromEntries(SMA_CALIBRATION_ERAS[indexKey].map((era) => [era.key, era.weight])),
    scoresByEra: { ...winner.scoresByEra },
    smaPeriod: winner.combo.smaPeriod,
    smaUpperBuffer: winner.combo.smaUpperBuffer,
    smaLowerBuffer: winner.combo.smaLowerBuffer,
    score: winner.score,
    avgReturn: winner.row.avgReturn,
    worstReturn: winner.row.worstReturn,
    avgMaxDrawdown: winner.row.avgMaxDrawdown,
    avgTrades: winner.row.avgTrades,
    evaluatedCombos: evaluated.length,
    neighborhoodMinScore: Number.isFinite(plateau.minScore) ? plateau.minScore : undefined,
    neighborhoodMedianScore: Number.isFinite(plateau.medianScore) ? plateau.medianScore : undefined,
  };
}

async function main(): Promise<void> {
  const endDate = await getLatestSharedTradeDate(["sp500", "nasdaq100", "risk:SGOV"]);
  const windowLength = getDefaultWindowLength();
  const searchSpace = await readSmaSearchSpaceSnapshot();

  console.log(`[calibrate-sma] Calibrating to ${endDate} (${windowLength}y rolling windows)`);
  console.log(
    `[calibrate-sma] period ${SMA_SEARCH_MIN_PERIOD}..${SMA_SEARCH_MAX_PERIOD}, buffer ${SMA_SEARCH_MIN_BUFFER}..${SMA_SEARCH_MAX_BUFFER}%`
  );
  for (const indexKey of ["sp500", "nasdaq100"] as IndexKey[]) {
    console.log(
      `[calibrate-sma] ${indexKey} eras: ${SMA_CALIBRATION_ERAS[indexKey].map((era) => `${era.label} from ${era.startDate}`).join(", ")} (weights ${describeEraWeights(indexKey)})`
    );
  }
  console.log(
    searchSpace
      ? `[calibrate-sma] Seeded by sma-search-space.json (generated ${searchSpace.generatedAt}, buffer step ${searchSpace.grid.bufferStep}%)`
      : "[calibrate-sma] No sma-search-space.json — using the coarse fallback scan. Run `npm run explore-sma` for a sharper search."
  );

  console.log("[calibrate-sma] Calibrating SPX...");
  const sp500 = await calibrateIndex("sp500", endDate, windowLength, searchSpace?.sp500 ?? null);
  console.log("[calibrate-sma] Calibrating NDX...");
  const nasdaq100 = await calibrateIndex("nasdaq100", endDate, windowLength, searchSpace?.nasdaq100 ?? null);

  // Each index records its own startDate; there is no single global one.
  const payload: SmaCalibrationResult = {
    generatedAt: new Date().toISOString(),
    endDate,
    windowLength,
    sp500,
    nasdaq100,
  };

  mkdirSync(dirname(SMA_CALIBRATION_SNAPSHOT_PATH), { recursive: true });
  // Trailing newline keeps the artifact POSIX-clean, so re-running does not show
  // up as a one-line diff on top of the values that actually changed.
  writeFileSync(SMA_CALIBRATION_SNAPSHOT_PATH, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`[calibrate-sma] Wrote ${SMA_CALIBRATION_SNAPSHOT_PATH}`);
}

main().catch((error: unknown) => {
  console.error("[calibrate-sma] Fatal error:", error);
  process.exitCode = 1;
});
