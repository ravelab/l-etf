import { getPrices, getBorrowRate } from "../src/lib/db/queries";
import {
  simulateBacktest,
  setSwapSpreadModel,
  getSwapSpreadModel,
} from "../src/lib/simulation/engine";
import type { SwapSpreadModel } from "../src/lib/simulation/engine";
import type { EtfConfig, PricePoint, RatePoint } from "../src/lib/simulation/types";
import { ETF_PRESETS } from "../src/lib/simulation/presets";
import { alignCloseSeriesToDates } from "../src/lib/utils";
import { CONSTANT_INITIAL_INVESTMENT } from "../src/lib/constants";
import { getIsoDate } from "../src/lib/date";
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";

const CALIBRATION_PAIRS: Array<{
  simulated: string;
  actual: string;
  actualTicker: string;
}> = [
  { simulated: "SSO", actual: "SSO-real", actualTicker: "SSO" },
  { simulated: "UPRO", actual: "UPRO-real", actualTicker: "UPRO" },
  { simulated: "QLD", actual: "QLD-real", actualTicker: "QLD" },
  { simulated: "TQQQ", actual: "TQQQ-real", actualTicker: "TQQQ" },
];

const INITIAL_INVESTMENT = CONSTANT_INITIAL_INVESTMENT;

function filterSimulationReadyPrices(
  rows: Awaited<ReturnType<typeof getPrices>>,
): PricePoint[] {
  return rows
    .filter((row) => {
      const adjClose = row.adj_close ?? Number.NaN;
      return Number.isFinite(adjClose) && adjClose > 0;
    })
    .map((row) => ({
      date: row.date,
      adj_close: row.adj_close as number,
      close: row.close ?? (row.adj_close as number),
    }));
}

function makeConfig(id: string, presetKey: string): EtfConfig {
  const preset = ETF_PRESETS[presetKey];
  if (!preset) throw new Error(`Unknown preset: ${presetKey}`);
  return {
    id,
    name: preset.name,
    leverage: preset.leverage,
    expenseRatio: preset.expenseRatio,
    simulated: preset.simulated,
    smaEnabled: false,
    smaPeriod: 0,
    smaBuffer: 0,
    smaIndex: preset.index,
    riskOffAsset: "VGSH",
  };
}

interface ComparisonResult {
  simDailyValues: number[];
  actualDailyValues: number[];
  simFinal: number;
  actualFinal: number;
}

interface TrackingMetrics {
  dailyReturnRmse: number;
  maxCumulativeError: number;
  meanCumulativeError: number;
  cumulativeLogRmse: number;
  finalErrorPct: number;
  score: number;
}

function runComparison(
  prices: PricePoint[],
  rates: RatePoint[],
  simConfig: EtfConfig,
  actualConfig: EtfConfig,
  etfPricesByName: Record<string, number[]>,
): ComparisonResult {
  const result = simulateBacktest(prices, rates, [simConfig, actualConfig], {
    etfPricesByName,
  });

  const simResult = result.etfResults.find((r) => r.id === simConfig.id);
  const actualResult = result.etfResults.find((r) => r.id === actualConfig.id);

  if (!simResult || !actualResult) {
    throw new Error("Missing results from simulateBacktest");
  }

  return {
    simDailyValues: simResult.dailyValues,
    actualDailyValues: actualResult.dailyValues,
    simFinal: simResult.finalValue,
    actualFinal: actualResult.finalValue,
  };
}

/**
 * Compute RMSE of daily returns between simulated and actual ETF.
 * This measures how well the simulation tracks the real ETF day-by-day.
 */
function computeDailyReturnRmse(simValues: number[], actualValues: number[]): number {
  const n = Math.min(simValues.length, actualValues.length);
  let sumSqErr = 0;
  let count = 0;

  for (let i = 1; i < n; i++) {
    const simReturn = (simValues[i] - simValues[i - 1]) / simValues[i - 1];
    const actualReturn = (actualValues[i] - actualValues[i - 1]) / actualValues[i - 1];
    const err = simReturn - actualReturn;
    sumSqErr += err * err;
    count++;
  }

  return Math.sqrt(sumSqErr / count);
}

/**
 * Compute max absolute percentage deviation of cumulative values.
 * Shows worst-case daily tracking error.
 */
function computeMaxCumulativeError(simValues: number[], actualValues: number[]): number {
  const n = Math.min(simValues.length, actualValues.length);
  let maxErr = 0;

  for (let i = 0; i < n; i++) {
    const err = Math.abs(simValues[i] - actualValues[i]) / actualValues[i];
    if (err > maxErr) maxErr = err;
  }

  return maxErr;
}

/**
 * Compute mean absolute percentage error of cumulative values.
 */
function computeMeanCumulativeError(simValues: number[], actualValues: number[]): number {
  const n = Math.min(simValues.length, actualValues.length);
  let sumErr = 0;

  for (let i = 0; i < n; i++) {
    sumErr += Math.abs(simValues[i] - actualValues[i]) / actualValues[i];
  }

  return sumErr / n;
}

/**
 * RMSE of log cumulative ratio. This penalizes path drift directly instead of only
 * looking at daily return deltas or the final endpoint.
 */
function computeCumulativeLogRmse(simValues: number[], actualValues: number[]): number {
  const n = Math.min(simValues.length, actualValues.length);
  let sumSqErr = 0;
  let count = 0;

  for (let i = 0; i < n; i++) {
    const sim = simValues[i];
    const actual = actualValues[i];
    if (!Number.isFinite(sim) || !Number.isFinite(actual) || sim <= 0 || actual <= 0) continue;
    const err = Math.log(sim / actual);
    sumSqErr += err * err;
    count++;
  }

  return count > 0 ? Math.sqrt(sumSqErr / count) : Infinity;
}

function computeTrackingMetrics(result: ComparisonResult): TrackingMetrics {
  const dailyReturnRmse = computeDailyReturnRmse(result.simDailyValues, result.actualDailyValues);
  const maxCumulativeError = computeMaxCumulativeError(result.simDailyValues, result.actualDailyValues);
  const meanCumulativeError = computeMeanCumulativeError(result.simDailyValues, result.actualDailyValues);
  const cumulativeLogRmse = computeCumulativeLogRmse(result.simDailyValues, result.actualDailyValues);
  const finalErrorPct = Math.abs((result.simFinal - result.actualFinal) / result.actualFinal) * 100;

  const score =
    dailyReturnRmse * 10000 +
    cumulativeLogRmse * 10000 * 1.75 +
    meanCumulativeError * 100 * 5 +
    maxCumulativeError * 100 * 1.5 +
    finalErrorPct * 40;

  return {
    dailyReturnRmse,
    maxCumulativeError,
    meanCumulativeError,
    cumulativeLogRmse,
    finalErrorPct,
    score,
  };
}

async function calibrate() {
  const endDate = getIsoDate(new Date());
  console.log(`Calibrating up to ${endDate}...\n`);

  const model = getSwapSpreadModel();

  for (const pair of CALIBRATION_PAIRS) {
    const simPreset = ETF_PRESETS[pair.simulated];
    const actualPreset = ETF_PRESETS[pair.actual];
    if (!simPreset || !actualPreset) {
      console.error(`Unknown preset: ${pair.simulated} or ${pair.actual}`);
      continue;
    }

    const indexKey = simPreset.index;
    const leverage = simPreset.leverage;

    console.log(`--- Calibrating ${pair.simulated} vs ${pair.actual} (${indexKey} ${leverage}x) ---`);

    // Fetch data
    const [indexPrices, etfPrices, rawRates] = await Promise.all([
      getPrices(indexKey, "1900-01-01", endDate),
      getPrices(`etf:${pair.actualTicker}`, "1900-01-01", endDate),
      getBorrowRate("1900-01-01", endDate),
    ]);

    if (indexPrices.length === 0 || etfPrices.length === 0) {
      console.error(`  Insufficient data for ${pair.actualTicker}`);
      continue;
    }

    const etfFirstDate = etfPrices[0].date;
    const effectiveStartDate = indexPrices[0].date > etfFirstDate ? indexPrices[0].date : etfFirstDate;
    console.log(`  ETF data from: ${etfFirstDate}, using: ${effectiveStartDate}`);

    const filteredIndexPrices: PricePoint[] = filterSimulationReadyPrices(
      indexPrices.filter((p) => p.date >= effectiveStartDate),
    );

    const filteredEtfPrices: PricePoint[] = filterSimulationReadyPrices(
      etfPrices.filter((p) => p.date >= effectiveStartDate),
    );

    const etfPricesByName: Record<string, number[]> = {
      [pair.actualTicker]: alignCloseSeriesToDates(filteredIndexPrices, filteredEtfPrices),
    };

    const rates: RatePoint[] = rawRates
      .filter((r) => r.date >= effectiveStartDate)
      .map((r) => ({ date: r.date, rateType: "borrow", rateValue: r.value }));

    console.log(`  ${filteredIndexPrices.length} index days, ${filteredEtfPrices.length} ETF days, ${rates.length} rate days`);

    const simConfig = makeConfig("sim", pair.simulated);
    const actualConfig = makeConfig("actual", pair.actual);

    // Get actual ETF baseline
    const baseline = runComparison(filteredIndexPrices, rates, simConfig, actualConfig, etfPricesByName);
    const actualFinal = baseline.actualFinal;
    const actualReturn = (actualFinal - INITIAL_INVESTMENT) / INITIAL_INVESTMENT;
    console.log(`  Actual ${pair.actualTicker} Final: $${actualFinal.toFixed(2)} (${(actualReturn * 100).toFixed(2)}%)`);

    const currentModel = model[indexKey]?.[leverage] ?? { rateSensitivity: 0.7, baseSpread: 0.001 };
    let bestRS = currentModel.rateSensitivity;
    let bestBS = currentModel.baseSpread;
    let bestMetrics = computeTrackingMetrics(baseline);

    const trialCache = new Map<string, { result: ComparisonResult; metrics: TrackingMetrics }>();
    const quantize = (value: number, digits: number) => value.toFixed(digits);

    // Helper: run simulation with trial parameters, return full result
    const trySimFull = (rs: number, bs: number): ComparisonResult => {
      const trialModel = { ...model };
      trialModel[indexKey] = {
        ...trialModel[indexKey],
        [leverage]: { rateSensitivity: rs, baseSpread: bs },
      };
      setSwapSpreadModel(trialModel);
      return runComparison(filteredIndexPrices, rates, simConfig, actualConfig, etfPricesByName);
    };

    const evaluate = (rs: number, bs: number) => {
      const key = `${quantize(rs, 6)}|${quantize(bs, 6)}`;
      const cached = trialCache.get(key);
      if (cached) return cached;
      const result = trySimFull(rs, bs);
      const metrics = computeTrackingMetrics(result);
      const value = { result, metrics };
      trialCache.set(key, value);
      return value;
    };

    const solveBaseSpreadForFinalMatch = (rs: number, seedBs: number, targetFinal: number) => {
      const finalDelta = (bs: number) => evaluate(rs, bs).result.simFinal - targetFinal;

      let lo = seedBs;
      let hi = seedBs;
      let loDelta = finalDelta(lo);
      let hiDelta = loDelta;

      if (Math.abs(loDelta) < 1e-9) {
        const exact = evaluate(rs, seedBs);
        return { bestLocalBs: seedBs, bestLocalRes: exact.result, bestLocalMetrics: exact.metrics };
      }

      const stepBase = 0.0005;
      for (let expand = 0; expand < 40 && loDelta * hiDelta > 0; expand++) {
        const step = stepBase * 2 ** expand;
        if (loDelta > 0) {
          hi = seedBs + step;
          hiDelta = finalDelta(hi);
        } else {
          lo = Math.max(seedBs - step, -0.05);
          loDelta = finalDelta(lo);
        }
      }

      if (loDelta * hiDelta > 0) {
        const fallback = evaluate(rs, seedBs);
        return { bestLocalBs: seedBs, bestLocalRes: fallback.result, bestLocalMetrics: fallback.metrics };
      }

      let bestBs = Math.abs(loDelta) < Math.abs(hiDelta) ? lo : hi;
      let bestEval = evaluate(rs, bestBs);

      for (let iter = 0; iter < 50; iter++) {
        const mid = (lo + hi) / 2;
        const midEval = evaluate(rs, mid);
        const midDelta = midEval.result.simFinal - targetFinal;

        if (Math.abs(midDelta) < Math.abs(bestEval.result.simFinal - targetFinal)) {
          bestBs = mid;
          bestEval = midEval;
        }

        if (Math.abs(midDelta) < 1e-9) break;
        if (loDelta * midDelta <= 0) {
          hi = mid;
          hiDelta = midDelta;
        } else {
          lo = mid;
          loDelta = midDelta;
        }
      }

      return { bestLocalBs: bestBs, bestLocalRes: bestEval.result, bestLocalMetrics: bestEval.metrics };
    };

    const optimizeBaseSpreadForRs = (rs: number, seedBs: number) => {
      let lo = seedBs - 0.01;
      let hi = seedBs + 0.01;
      const phi = (1 + Math.sqrt(5)) / 2;
      const resphi = 2 - phi;
      let bestLocalBs = seedBs;
      const initialEval = evaluate(rs, seedBs);
      let bestLocalRes = initialEval.result;
      let bestLocalMetrics = initialEval.metrics;

      for (let iter = 0; iter < 36; iter++) {
        const x1 = lo + resphi * (hi - lo);
        const x2 = hi - resphi * (hi - lo);
        const eval1 = evaluate(rs, x1);
        const metrics1 = eval1.metrics;
        const eval2 = evaluate(rs, x2);
        const metrics2 = eval2.metrics;

        if (metrics1.score < bestLocalMetrics.score) {
          bestLocalBs = x1;
          bestLocalRes = eval1.result;
          bestLocalMetrics = metrics1;
        }
        if (metrics2.score < bestLocalMetrics.score) {
          bestLocalBs = x2;
          bestLocalRes = eval2.result;
          bestLocalMetrics = metrics2;
        }

        if (metrics1.score < metrics2.score) hi = x2;
        else lo = x1;
      }

      return { bestLocalBs, bestLocalRes, bestLocalMetrics };
    };

    // ── Phase 1: Minimize blended tracking score via coarse search + local search ──
    console.log(`  Phase 1: Minimizing blended tracking score...`);

    let bestScore = Infinity;
    const gridPoints = 60;
    for (let g = 0; g <= gridPoints; g++) {
      const trialRS = -0.5 + (g / gridPoints) * 2.5; // range [-0.5, 2.0]
      const { bestLocalBs, bestLocalMetrics } = optimizeBaseSpreadForRs(trialRS, bestBS);
      if (bestLocalMetrics.score < bestScore) {
        bestScore = bestLocalMetrics.score;
        bestRS = trialRS;
        bestBS = bestLocalBs;
        bestMetrics = bestLocalMetrics;
      }
    }
    console.log(
      `    Grid search best RS: ${bestRS.toFixed(6)}, BS: ${bestBS.toFixed(6)} ` +
      `(score: ${bestScore.toFixed(4)}, RMSE: ${(bestMetrics.dailyReturnRmse * 10000).toFixed(4)} bps)`
    );

    for (let outerRound = 0; outerRound < 10; outerRound++) {
      let gsA = bestRS - 0.5;
      let gsB = bestRS + 0.5;
      const phi = (1 + Math.sqrt(5)) / 2;
      const resphi = 2 - phi;

      for (let iter = 0; iter < 28; iter++) {
        const x1 = gsA + resphi * (gsB - gsA);
        const x2 = gsB - resphi * (gsB - gsA);
        const opt1 = optimizeBaseSpreadForRs(x1, bestBS);
        const opt2 = optimizeBaseSpreadForRs(x2, bestBS);

        if (opt1.bestLocalMetrics.score < opt2.bestLocalMetrics.score) gsB = x2;
        else gsA = x1;

        if (opt1.bestLocalMetrics.score < bestScore) {
          bestScore = opt1.bestLocalMetrics.score;
          bestRS = x1;
          bestBS = opt1.bestLocalBs;
          bestMetrics = opt1.bestLocalMetrics;
        }
        if (opt2.bestLocalMetrics.score < bestScore) {
          bestScore = opt2.bestLocalMetrics.score;
          bestRS = x2;
          bestBS = opt2.bestLocalBs;
          bestMetrics = opt2.bestLocalMetrics;
        }
      }

      const candidateRs = (gsA + gsB) / 2;
      const candidate = optimizeBaseSpreadForRs(candidateRs, bestBS);
      if (candidate.bestLocalMetrics.score < bestScore) {
        bestScore = candidate.bestLocalMetrics.score;
        bestRS = candidateRs;
        bestBS = candidate.bestLocalBs;
        bestMetrics = candidate.bestLocalMetrics;
      } else {
        break;
      }
    }

    console.log(
      `    After phase 1: RS=${bestRS.toFixed(6)}, BS=${bestBS.toFixed(6)}, ` +
      `score=${bestScore.toFixed(4)}, RMSE=${(bestMetrics.dailyReturnRmse * 10000).toFixed(4)} bps`
    );

    // ── Phase 2: final local coordinate polish around the current best pair ──
    console.log(`  Phase 2: Local coordinate polish...`);
    let rsStep = 0.08;
    let bsStep = 0.0012;
    for (let round = 0; round < 8; round++) {
      let improved = false;
      const candidates: Array<[number, number]> = [
        [bestRS - rsStep, bestBS],
        [bestRS + rsStep, bestBS],
        [bestRS, bestBS - bsStep],
        [bestRS, bestBS + bsStep],
        [bestRS - rsStep, bestBS - bsStep],
        [bestRS - rsStep, bestBS + bsStep],
        [bestRS + rsStep, bestBS - bsStep],
        [bestRS + rsStep, bestBS + bsStep],
      ];
      for (const [trialRS, trialBS] of candidates) {
        const { metrics } = evaluate(trialRS, trialBS);
        if (metrics.score < bestScore) {
          bestScore = metrics.score;
          bestRS = trialRS;
          bestBS = trialBS;
          bestMetrics = metrics;
          improved = true;
        }
      }
      rsStep *= 0.55;
      bsStep *= 0.55;
      if (!improved && rsStep < 1e-4 && bsStep < 1e-5) break;
    }

    // ── Phase 3: lock final endpoint to the real ETF while preserving the chosen RS ──
    console.log(`  Phase 3: Exact endpoint alignment...`);
    const exactEndpoint = solveBaseSpreadForFinalMatch(bestRS, bestBS, actualFinal);
    bestBS = exactEndpoint.bestLocalBs;
    bestMetrics = exactEndpoint.bestLocalMetrics;

    // ── Final verification ──
    const finalRes = trySimFull(bestRS, bestBS);
    const simReturn = (finalRes.simFinal - INITIAL_INVESTMENT) / INITIAL_INVESTMENT;
    const finalMetrics = computeTrackingMetrics(finalRes);

    console.log(`  Result for ${pair.simulated}:`);
    console.log(`    rateSensitivity: ${bestRS.toFixed(6)}`);
    console.log(`    baseSpread:      ${bestBS.toFixed(6)}`);
    console.log(`    Sim Final:  $${finalRes.simFinal.toFixed(2)} (${(simReturn * 100).toFixed(2)}%)`);
    console.log(`    Real Final: $${actualFinal.toFixed(2)} (${(actualReturn * 100).toFixed(2)}%)`);
    console.log(`    Final Return Diff:     ${finalMetrics.finalErrorPct.toFixed(4)}%`);
    console.log(`    Daily Return RMSE:     ${(finalMetrics.dailyReturnRmse * 10000).toFixed(4)} bps`);
    console.log(`    Cumulative Log RMSE:   ${(finalMetrics.cumulativeLogRmse * 10000).toFixed(4)} bps`);
    console.log(`    Max Cumulative Diff:   ${(finalMetrics.maxCumulativeError * 100).toFixed(4)}%`);
    console.log(`    Mean Cumulative Diff:  ${(finalMetrics.meanCumulativeError * 100).toFixed(4)}%`);
    console.log(`    Composite Score:       ${finalMetrics.score.toFixed(4)}`);
    console.log();

    if (!model[indexKey]) model[indexKey] = {};
    model[indexKey][leverage] = { rateSensitivity: bestRS, baseSpread: bestBS };
  }

  setSwapSpreadModel(model);

  console.log("--- Calibrated SWAP_SPREAD_MODEL ---");
  console.log(JSON.stringify(model, null, 2));

  updateEngineFile(model);
}

function updateEngineFile(
  results: Record<string, Record<number, SwapSpreadModel>>
) {
  const enginePath = path.join(__dirname, "..", "src", "lib", "simulation", "engine.ts");
  let content = fs.readFileSync(enginePath, "utf-8");

  const calibrationDate = new Date().toISOString().split("T")[0];

  let newModel = "let SWAP_SPREAD_MODEL: Record<string, Record<number, SwapSpreadModel>> = {\n";
  for (const [index, leverageMap] of Object.entries(results)) {
    const indexComment = index === "sp500" ? "S&P 500" : "Nasdaq 100";
    newModel += `  // ${indexComment} - calibrated ${calibrationDate}\n`;
    newModel += `  ${index}: {\n`;

    const sortedLevers = Object.keys(leverageMap).map(Number).sort((a, b) => a - b);
    for (const leverage of sortedLevers) {
      const m = leverageMap[leverage];
      const etfName =
        index === "sp500"
          ? leverage === 2 ? "SSO" : "UPRO"
          : leverage === 2 ? "QLD" : "TQQQ";
      newModel += `    // ${etfName} (${leverage}x)\n`;
      newModel += `    ${leverage}: { rateSensitivity: ${m.rateSensitivity.toFixed(6)}, baseSpread: ${m.baseSpread.toFixed(6)} },\n`;
    }
    newModel += "  },\n";
  }
  newModel += "};";

  const startMarker = "let SWAP_SPREAD_MODEL: Record<string, Record<number, SwapSpreadModel>> = {";
  const endMarker = "const DEFAULT_SWAP_MODEL";

  const startIndex = content.indexOf(startMarker);
  const endIndex = content.indexOf(endMarker, startIndex);

  if (startIndex === -1 || endIndex === -1) {
    console.error("Could not find SWAP_SPREAD_MODEL in engine.ts");
    return;
  }

  const closingBraceIndex = content.lastIndexOf("};", endIndex);
  if (closingBraceIndex < startIndex) {
    console.error("Could not find closing brace for SWAP_SPREAD_MODEL");
    return;
  }

  const before = content.substring(0, startIndex);
  const after = content.substring(closingBraceIndex + 2);
  content = before + newModel + "\n" + after;

  fs.writeFileSync(enginePath, content, "utf-8");
  console.log(`\n✓ Updated SWAP_SPREAD_MODEL in engine.ts (calibrated ${calibrationDate})`);
}

calibrate().catch(console.error);
