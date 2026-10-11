/**
 * Select distinct SMA alternatives using the calibration's weighted multi-era
 * objective and complete stability neighborhoods; display default-window CAGR.
 * Candidates come from the exhaustive multi-era per-period seeds and calibration.
 * This does not claim a global maximum of modern-only CAGR.
 */
import { fork, type ChildProcess } from "node:child_process";
import { availableParallelism } from "node:os";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { simulateWithWarmUp } from "../src/lib/simulation/engine";
import { findEtfResult } from "../src/lib/simulation/result-lookup";
import { ETF_PRESETS, createPresetEtfConfig } from "../src/lib/simulation/presets";
import { DEFAULT_RISK_OFF_ASSET, getDefaultWindowLength } from "../src/lib/simulation/defaults";
import { alignRiskOffPriceSeries, getMarketDataWarmUpStartDate } from "../src/lib/fetch-market-data";
import { loadBorrowRates, loadIndexPrices, loadRiskOffRawSeries } from "../src/lib/mcp/server-data";
import { comboKey, planBufferNeighborhood, planCombos, planPeriodNeighborhood, type SmaCombo } from "../src/lib/simulation/sma-search";
import { SMA_SEARCH_MIN_PERIOD, SMA_SEARCH_MAX_PERIOD, SMA_SEARCH_MIN_BUFFER, SMA_SEARCH_MAX_BUFFER } from "../src/lib/simulation/sma-search-bounds";
import type { EtfResult, IndexKey } from "../src/lib/simulation/types";
import seeds from "../src/lib/tool-snapshots/sma-search-space.json";
import calibration from "../src/lib/tool-snapshots/sma-calibration.json";
import { CONSTANT_INITIAL_INVESTMENT, CONSTANT_SP500_SHORTCUT_DATE } from "../src/lib/constants";
import { getLatestSharedTradeDate } from "./lib/sweep-data";
import { rankSmaPresetSets, SMA_PRESET_RANKING } from "../src/lib/simulation/sma-preset-ranking";
import { findPlateau, PLATEAU_TOLERANCE } from "../src/lib/simulation/plateau";
import { stabilityAdjustedSmaScore } from "../src/lib/simulation/sma-stability-score";
import { SMA_CALIBRATION_ERAS } from "../src/lib/simulation/sma-calibration-eras";
import { type EraEvaluatedCombo } from "./lib/sma-sweep-context";
import { withEraCagrs } from "./lib/sma-preset-era-cagrs";
import { PRESET_BUFFER_STEP, PRESET_PERIOD_STEP, PRESET_BUFFER_HALF_WIDTH, snapPresetCombo, refinePresetGrid } from "./lib/sma-preset-grid";
import currentPresets from "../src/lib/tool-snapshots/sma-cagr-presets.json";

interface Candidate extends SmaCombo {
  cagr: number; finalMultiple: number; maxDrawdown: number; trades: number;
  riskOn: string; days: number;
  score: number; baseScore: number; stabilityPenalty: number;
  scoresByEra: EraEvaluatedCombo["scoresByEra"];
}
function riskOnBits(result: EtfResult): string {
  const bits = Buffer.alloc(Math.ceil(result.dates.length / 8));
  let invested = result.smaStartInvested ?? true;
  let signal = 0;
  for (let day = 0; day < result.dates.length; day++) {
    while (signal < result.smaSignals.length && result.smaSignals[signal].date <= result.dates[day]) {
      invested = result.smaSignals[signal++].type === "buy";
    }
    if (invested) bits[day >> 3] |= 1 << (day & 7);
  }
  return bits.toString("base64");
}

const popcounts = Array.from({ length: 256 }, (_, n) => n.toString(2).replaceAll("0", "").length);
function regimeDistance(a: Candidate, b: Candidate): number {
  if (a.days !== b.days) throw new Error("Candidates must share trading dates");
  const left = Buffer.from(a.riskOn, "base64");
  const right = Buffer.from(b.riskOn, "base64");
  let different = 0;
  for (let i = 0; i < left.length; i++) different += popcounts[left[i] ^ right[i]];
  return different / a.days;
}


function separated(a: Candidate, b: Candidate): boolean {
  return regimeDistance(a, b) >= 0.05 && (Math.abs(a.smaPeriod - b.smaPeriod) >= 20
    || Math.abs(a.smaUpperBuffer - b.smaUpperBuffer) >= 3
    || Math.abs(a.smaLowerBuffer - b.smaLowerBuffer) >= 3);
}

type WorkerReply = { rows: EraEvaluatedCombo[] } | { error: string };
function scoreInWorker(child: ChildProcess, indexKey: IndexKey, endDate: string, combos: SmaCombo[]): Promise<EraEvaluatedCombo[]> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { child.off("message", onMessage); child.off("error", onError); child.off("exit", onExit); };
    const onMessage = (reply: WorkerReply) => {
      cleanup(); if ("error" in reply) reject(new Error(reply.error)); else resolve(reply.rows);
    };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onExit = () => onError(new Error("Preset scoring worker exited before returning results"));
    child.once("message", onMessage); child.once("error", onError); child.once("exit", onExit);
    child.send({ indexKey, endDate, combos });
  });
}
function pickDistinct(candidates: Candidate[], count: number): Candidate[] {
  const selected: Candidate[] = [];
  for (const row of [...candidates].sort((a, b) => b.score - a.score || b.cagr - a.cagr)) {
    if (selected.every((previous) => separated(row, previous))) selected.push(row);
    if (selected.length === count) break;
  }
  return selected;
}
async function main(): Promise<void> {
  const startDate = CONSTANT_SP500_SHORTCUT_DATE;
  const endDate = await getLatestSharedTradeDate(["sp500", "nasdaq100", "risk:SGOV"]);
  const selected = {} as Record<IndexKey, Candidate[]>;
  const evaluated = {} as Record<IndexKey, number>;
  const candidatesTested = {} as Record<IndexKey, number>;
  const workers = Array.from({ length: Math.min(4, Math.max(1, availableParallelism() - 1)) }, () =>
    fork(fileURLToPath(new URL("./lib/sma-preset-scoring-worker.ts", import.meta.url)), [],
      { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "inherit", "ipc"] }));
  try {
    for (const index of ["sp500", "nasdaq100"] as const) {
      const cache = new Map<string, EraEvaluatedCombo>();
      const evaluate = async (combos: SmaCombo[], stage: string) => {
        const pending = [...new Map(combos.filter((combo) => !cache.has(comboKey(combo))).map((combo) => [comboKey(combo), combo])).values()];
        let next = 0;
        let completed = 0;
        let lastLog = 0;
        console.log(`[${index} ${stage}] ${pending.length} multi-era evaluations`);
        await Promise.all(workers.map(async (child) => {
          while (next < pending.length) {
            const offset = next; next += 60;
            const batch = pending.slice(offset, offset + 60);
            for (const row of await scoreInWorker(child, index, endDate, batch)) cache.set(comboKey(row.combo), row);
            completed += batch.length;
            if (Date.now() - lastLog > 15000 || completed === pending.length) {
              console.log(`[${index} ${stage}] ${completed}/${pending.length}`); lastLog = Date.now();
            }
          }
        }));
        return combos.map((combo) => {
          const row = cache.get(comboKey(combo));
          if (!row) throw new Error(`Missing multi-era result ${comboKey(combo)}`);
          return row;
        });
      };
      const seedCombos = [...new Map([...seeds[index].periodSeeds.filter((combo) => combo.smaPeriod % PRESET_PERIOD_STEP === 0),
        ...currentPresets.presets.filter((preset) => !preset.isCalibratedDefault).map((preset) => preset[index])]
        .map(snapPresetCombo).concat(calibration[index]).map((combo) => [comboKey(combo), {
          smaPeriod: combo.smaPeriod, smaUpperBuffer: combo.smaUpperBuffer, smaLowerBuffer: combo.smaLowerBuffer,
        }])).values()];
      const warmStart = getMarketDataWarmUpStartDate(startDate, SMA_SEARCH_MAX_PERIOD);
      const [prices, rates, raw] = await Promise.all([
        loadIndexPrices(index, warmStart, endDate), loadBorrowRates(warmStart, endDate),
        loadRiskOffRawSeries(DEFAULT_RISK_OFF_ASSET, warmStart, endDate),
      ]);
      const riskOff = alignRiskOffPriceSeries(prices, raw);
      const preset = ETF_PRESETS[index === "sp500" ? "UPRO" : "TQQQ"];
      const summarize = (row: EraEvaluatedCombo, score: number): Candidate => {
        const config = createPresetEtfConfig(comboKey(row.combo), preset, { ...row.combo,
          riskOffAsset: DEFAULT_RISK_OFF_ASSET, smaExecutionMode: "next-day-open" });
        const result = simulateWithWarmUp(prices, rates, [config], startDate, row.combo.smaPeriod, {
          riskOffValuesByAsset: riskOff.closeValuesByAsset, riskOffOpenValuesByAsset: riskOff.openValuesByAsset, endDate,
        });
        const etf = findEtfResult(result, `${comboKey(row.combo)}-sma`);
        if (!etf) throw new Error(`Missing backtest ${comboKey(row.combo)}`);
        return { ...row.combo, cagr: etf.cagr, finalMultiple: etf.finalValue / CONSTANT_INITIAL_INVESTMENT,
          maxDrawdown: etf.maxDrawdownPct, trades: etf.smaSignals.length, riskOn: riskOnBits(etf), days: etf.dates.length,
          score, baseScore: row.score, stabilityPenalty: row.score - score, scoresByEra: row.scoresByEra };
      };
      const stability = async (rows: EraEvaluatedCombo[], stage: string): Promise<Candidate[]> => {
        const neighborhoods = rows.map((row) => planCombos(planPeriodNeighborhood(row.combo.smaPeriod, 1, {
          minPeriod: SMA_SEARCH_MIN_PERIOD, maxPeriod: SMA_SEARCH_MAX_PERIOD,
        }), planBufferNeighborhood(row.combo.smaUpperBuffer, row.combo.smaLowerBuffer, 0.1, 0.1, {
          minBuffer: SMA_SEARCH_MIN_BUFFER, maxBuffer: SMA_SEARCH_MAX_BUFFER,
        }), new Set<string>()));
        await evaluate(neighborhoods.flat(), stage);
        return rows.map((row, position) => {
          // Neighborhoods are our own geometry, not engine outputs; score results
          // are always keyed by comboKey, including dropped-result validation.
          const worst = Math.min(...neighborhoods[position].map((combo) => cache.get(comboKey(combo))!.score));
          return summarize(row, stabilityAdjustedSmaScore(row.score, worst));
        });
      };
      let candidates = await stability(await evaluate(seedCombos, "seeds"), "seed stability");
      for (const [stage, step, halfWidth] of [["buffer refinement", 0.2, PRESET_BUFFER_HALF_WIDTH],
        ["fine buffers", PRESET_BUFFER_STEP, 0.4]] as const) {
        // Search separated basins jointly over period +/-5 and both buffers.
        const basins = pickDistinct(candidates, 9).filter((row) => comboKey(row) !== comboKey(calibration[index]));
        const points = basins.flatMap((basin) => refinePresetGrid(basin, step, halfWidth));
        const rows = await evaluate(points, stage);
        const defaultRule = candidates.find((row) => comboKey(row) === comboKey(calibration[index]))!;
        const distinctFloor = [defaultRule];
        for (const row of [...candidates].sort((a, b) => b.score - a.score)) {
          if (distinctFloor.every((previous) => separated(row, previous))) distinctFloor.push(row);
          if (distinctFloor.length === 6) break;
        }
        // Base score bounds stable score above. A candidate below an already
        // proven sixth distinct rule cannot improve the selected six.
        const floor = distinctFloor.length === 6 ? Math.min(...distinctFloor.map((row) => row.score)) : -Infinity;
        const refined = await stability([...new Map(rows.filter((row) => row.score >= floor)
          .map((row) => [comboKey(row.combo), row])).values()], `${stage} stability`);
        candidates = [...new Map([...candidates, ...refined].map((row) => [comboKey(row), row])).values()];
      }
      const defaultCandidate = candidates.find((row) => comboKey(row) === comboKey(calibration[index]))!;
      const leaders = [defaultCandidate];
      const ranked = [...candidates].sort((a, b) => b.score - a.score || b.cagr - a.cagr);
      for (const candidate of ranked) {
        const plateau = findPlateau(candidates.filter((row) => row.score <= candidate.score + 1e-8).map((row) => ({
          item: row, coords: [row.smaPeriod, row.smaUpperBuffer, row.smaLowerBuffer], score: row.score,
        })), { tolerance: PLATEAU_TOLERANCE, steps: [PRESET_PERIOD_STEP, PRESET_BUFFER_STEP, PRESET_BUFFER_STEP] });
        const center = plateau?.peak.item === candidate ? plateau.center.item : candidate;
        if (leaders.every((previous) => separated(center, previous))) leaders.push(center);
        if (leaders.length === 6) break;
      }
      if (leaders.length !== 6) throw new Error(`Only ${leaders.length} distinct ${index} rules`);
      selected[index] = [defaultCandidate, ...leaders.slice(1).sort((a, b) => b.score - a.score)];
      evaluated[index] = cache.size;
      candidatesTested[index] = candidates.length;
      console.log(JSON.stringify({ index, leaders: leaders.map(({ riskOn, ...row }) => { void riskOn; return row; }) }));
    }
  } finally { for (const child of workers) child.kill(); }
  const compact = ({ riskOn, days, ...row }: Candidate) => { void riskOn; void days; return row; };
  // Engine outputs are resolved by id. Pairing independently selected sleeves
  // is an explicit portfolio construction, not an engine-output positional join.
  const presets = rankSmaPresetSets(selected.sp500.map((sp500, index) => {
    const nasdaq100 = selected.nasdaq100[index];
    return { isCalibratedDefault: index === 0, sp500: compact(sp500), nasdaq100: compact(nasdaq100) };
  }));
  const minRegimeDifferencePct = (index: IndexKey) => 100 * Math.min(...selected[index].flatMap((left, i) =>
    selected[index].slice(i + 1).map((right) => regimeDistance(left, right))));
  const payload = { generatedAt: new Date().toISOString(), startDate, endDate, riskOffAsset: DEFAULT_RISK_OFF_ASSET,
    executionMode: "next-day-open", windowLength: getDefaultWindowLength(),
    selection: "Calibrated default plus five distinct alternatives selected by stability-adjusted weighted multi-era score from per-period search seeds with joint buffer refinement",
    grid: { periodStep: PRESET_PERIOD_STEP, bufferStep: PRESET_BUFFER_STEP, basinBufferHalfWidth: PRESET_BUFFER_HALF_WIDTH },
    ranking: SMA_PRESET_RANKING,
    eraWeights: Object.fromEntries((["sp500", "nasdaq100"] as const).map((index) => [index,
      Object.fromEntries(SMA_CALIBRATION_ERAS[index].map((era) => [era.key, era.weight]))])),
    distinctness: "At least 5% different risk-on days AND at least 20 days or 3 percentage points of parameter separation",
    minRegimeDifferencePct: { sp500: minRegimeDifferencePct("sp500"), nasdaq100: minRegimeDifferencePct("nasdaq100") },
    evaluated, candidatesTested, presets: await withEraCagrs(presets, startDate, endDate) };
  if (process.argv.includes("--write-presets")) {
    const path = fileURLToPath(new URL("../src/lib/tool-snapshots/sma-cagr-presets.json", import.meta.url));
    writeFileSync(path, JSON.stringify(payload, null, 2) + "\n");
    console.log(`Wrote ${path}`);
  }
}
async function refreshEraCagrs(): Promise<void> {
  const payload = { ...currentPresets, ranking: SMA_PRESET_RANKING,
    presets: await withEraCagrs(rankSmaPresetSets(currentPresets.presets), currentPresets.startDate, currentPresets.endDate) };
  const path = fileURLToPath(new URL("../src/lib/tool-snapshots/sma-cagr-presets.json", import.meta.url));
  writeFileSync(path, JSON.stringify(payload, null, 2) + "\n");
  console.log(`Refreshed era CAGRs in ${path}`);
}
async function rerankPresets(): Promise<void> {
  const payload = { ...currentPresets, ranking: SMA_PRESET_RANKING, presets: rankSmaPresetSets(currentPresets.presets) };
  const path = fileURLToPath(new URL("../src/lib/tool-snapshots/sma-cagr-presets.json", import.meta.url));
  writeFileSync(path, JSON.stringify(payload, null, 2) + "\n");
  console.log(`Ranked presets by multi-era score in ${path}`);
}
void (process.argv.includes("--rerank-presets") ? rerankPresets()
  : process.argv.includes("--refresh-era-cagrs") ? refreshEraCagrs() : main())
  .catch((error) => { console.error(error); process.exitCode = 1; });
