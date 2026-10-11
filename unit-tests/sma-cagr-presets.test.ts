import { refinePresetGrid, snapPresetCombo, sweepPresetPeriods, preferStablePresetCenter } from "../scripts/lib/sma-preset-grid";
import test from "node:test";
import assert from "node:assert/strict";
import snapshot from "../src/lib/tool-snapshots/sma-cagr-presets.json";
import calibration from "../src/lib/tool-snapshots/sma-calibration.json";
import { SMA_CALIBRATION_ERAS, combineEraScores } from "../src/lib/simulation/sma-calibration-eras";
import { buildSmaEraContexts, evaluateCombosAcrossEras } from "../scripts/lib/sma-sweep-context";
import { comboKey, planBufferNeighborhood, planPeriodNeighborhood, planCombos } from "../src/lib/simulation/sma-search";
import { SMA_SEARCH_MIN_PERIOD, SMA_SEARCH_MAX_PERIOD, SMA_SEARCH_MIN_BUFFER, SMA_SEARCH_MAX_BUFFER } from "../src/lib/simulation/sma-search-bounds";
import { stabilityAdjustedSmaScore } from "../src/lib/simulation/sma-stability-score";
import { cpiIndexRatioEndOverStart } from "../src/lib/inflation";
import { fetchInflationData } from "../scripts/lib/sweep-data";
import { calcCagr } from "../src/lib/simulation/metrics";
import { runBacktestCore } from "../src/lib/mcp/tools/run-backtest";
import { loadIndexPrices } from "../src/lib/mcp/server-data";
import { DEFAULT_RISK_OFF_ASSET } from "../src/lib/simulation/defaults";
import { DEFAULT_SMA_EXECUTION_MODE } from "../src/lib/input-normalization";
import type { FormattedBacktest } from "../src/lib/mcp/format";
import { rankSmaPresetSets, SMA_PRESET_RANKING } from "../src/lib/simulation/sma-preset-ranking";
import { CONSTANT_NASDAQ100_SHORTCUT_DATE } from "../src/lib/constants";

test("evidence preference keeps NDX 183 narrowly ahead of the previous default and 148 after stability scoring", async () => {
  const eras = await buildSmaEraContexts({ indexKey: "nasdaq100", endDate: "2026-10-09", windowLength: 10, maxPeriod: 280 });
  const rules = [
    { smaPeriod: 183, smaLowerBuffer: 18.1, smaUpperBuffer: 7 },
    { smaPeriod: 125, smaLowerBuffer: 17.9, smaUpperBuffer: 19.4 },
    { smaPeriod: 148, smaLowerBuffer: 12.1, smaUpperBuffer: 7.9 },
  ];
  const scores = rules.map((rule) => {
    const points = planCombos(planPeriodNeighborhood(rule.smaPeriod, 1, { minPeriod: 20, maxPeriod: 280 }),
      planBufferNeighborhood(rule.smaUpperBuffer, rule.smaLowerBuffer, 0.1, 0.1, { minBuffer: 0, maxBuffer: 21 }), new Set<string>());
    const rows = evaluateCombosAcrossEras(eras, points);
    assert.equal(rows.length, points.length, "every stability neighbor must be scored");
    const center = rows.find((row) => comboKey(row.combo) === comboKey(rule))!;
    return stabilityAdjustedSmaScore(center.score, Math.min(...rows.map((row) => row.score)));
  });
  for (const competitor of scores.slice(1)) {
    assert.ok(scores[0] > competitor);
    assert.ok((scores[0] - competitor) / competitor < 0.02);
  }
});

test("preset ranking pairs each index by multi-era score even when the weakest rule has higher CAGR", () => {
  const calibrated = { isCalibratedDefault: true, sp500: { score: 100, cagr: 10 }, nasdaq100: { score: 100, cagr: 10 } };
  const strongSp = { score: 80, cagr: 15 };
  const weakSp = { score: 20, cagr: 25 };
  const strongNdx = { score: 12482, cagr: 28.27 };
  const weakNdx = { score: 5774, cagr: 28.59 };
  const ranked = rankSmaPresetSets([
    { isCalibratedDefault: false, sp500: weakSp, nasdaq100: strongNdx },
    calibrated,
    { isCalibratedDefault: false, sp500: strongSp, nasdaq100: weakNdx },
  ]);
  assert.deepEqual(ranked, [calibrated,
    { isCalibratedDefault: false, sp500: strongSp, nasdaq100: strongNdx },
    { isCalibratedDefault: false, sp500: weakSp, nasdaq100: weakNdx },
  ]);
});

test("plateau centering cannot erase a measured stable-score improvement", () => {
  const better = { smaPeriod: 177, score: 11221.071866983846 };
  const weaker = { smaPeriod: 150, score: 11149.212749449616 };
  assert.equal(preferStablePresetCenter(better, weaker), better);
  const tiedCenter = { smaPeriod: 176, score: better.score };
  assert.equal(preferStablePresetCenter(better, tiedCenter), tiedCenter);
});

test("CAGR presets retain their actual engine returns, rank and distinct trade regimes", async () => {
  assert.equal(snapshot.presets.length, 6);
  assert.equal(snapshot.grid.bufferStep, 0.1);
  assert.equal(snapshot.grid.periodStep, 1);
  assert.equal(snapshot.riskOffAsset, DEFAULT_RISK_OFF_ASSET);
  assert.equal(snapshot.executionMode, DEFAULT_SMA_EXECUTION_MODE);
  assert.equal(snapshot.ranking, SMA_PRESET_RANKING);
  assert.deepEqual(rankSmaPresetSets(snapshot.presets), snapshot.presets);
  for (let i = 0; i < snapshot.presets.length; i++) {
    const preset = snapshot.presets[i];
    assert.equal("cagr" in preset, false);
    assert.equal("finalMultiple" in preset, false);
    if (i > 1) for (const index of ["sp500", "nasdaq100"] as const)
      assert.ok(snapshot.presets[i - 1][index].score >= preset[index].score);
  }
  for (const index of ["sp500", "nasdaq100"] as const) {
    const modernStartDate = index === "sp500" ? snapshot.startDate : CONSTANT_NASDAQ100_SHORTCUT_DATE;
    const dates = (await loadIndexPrices(index, modernStartDate, snapshot.endDate)).map((row) => row.date);
    const regimes: boolean[][] = [];
    for (const preset of snapshot.presets) {
      const expected = preset[index];
      if (!preset.isCalibratedDefault) {
        assert.equal(expected.smaPeriod % snapshot.grid.periodStep, 0);
        for (const buffer of [expected.smaLowerBuffer, expected.smaUpperBuffer])
          assert.ok(Math.abs(buffer * 10 - Math.round(buffer * 10)) < 1e-9);
      }
      const result: FormattedBacktest = await runBacktestCore({
        preset: index === "sp500" ? "UPRO" : "TQQQ",
        startDate: modernStartDate, endDate: snapshot.endDate, smaEnabled: true,
        smaPeriod: expected.smaPeriod, smaUpperBuffer: expected.smaUpperBuffer, smaLowerBuffer: expected.smaLowerBuffer,
        riskOffAsset: DEFAULT_RISK_OFF_ASSET, smaExecutionMode: DEFAULT_SMA_EXECUTION_MODE,
      });
      assert.equal(result.startDate, modernStartDate);
      assert.equal(result.endDate, snapshot.endDate);
      assert.ok(Math.abs(result.cagrPct - expected.cagr) < 1e-9, `${index} CAGR no longer matches the engine — regenerate presets`);
      assert.ok(Math.abs(result.finalMultiple / expected.finalMultiple - 1) < 1e-10);
      assert.ok(Math.abs(result.maxDrawdownPct - expected.maxDrawdown) < 1e-9);
      assert.equal(result.numTrades, expected.trades);
      let displayedResult = result;
      if (index === "nasdaq100") {
        const history = preset.nasdaq100.switchHistory;
        const launchResult = result;
        assert.equal(history.startDate, CONSTANT_NASDAQ100_SHORTCUT_DATE);
        assert.equal(history.endDate, launchResult.endDate);
        assert.equal(history.count, launchResult.numTrades);
        displayedResult = launchResult;
        assert.equal(expected.realCagrStartDate, expected.eraCagrs.proto.endDate);
        if (expected.smaPeriod === 125 && expected.smaLowerBuffer === 17.9 && expected.smaUpperBuffer === 19.4) {
          assert.equal(history.count, 6);
          assert.equal(result.numTrades, 6);
          assert.equal(launchResult.trades[0].date, "1987-10-19");
        }
      }
      assert.equal(expected.realCagrStartDate, displayedResult.startDate);
      assert.equal(expected.realCagrEndDate, displayedResult.endDate);
      const modernCpi = await fetchInflationData(displayedResult.startDate, displayedResult.endDate);
      const modernRatio = cpiIndexRatioEndOverStart(modernCpi.monthlyCpi, displayedResult.startDate, displayedResult.endDate);
      assert.equal(expected.inflation.ratio, modernRatio);
      assert.ok(Math.abs(expected.realCagr - calcCagr(1, displayedResult.finalMultiple / modernRatio, displayedResult.startDate, displayedResult.endDate)) < 1e-9);
      const historicalEras = SMA_CALIBRATION_ERAS[index].filter((era) => era.key !== "start");
      assert.deepEqual(Object.keys(expected.eraCagrs), historicalEras.map((era) => era.key));
      for (const era of historicalEras) {
        const recorded = expected.eraCagrs[era.key as keyof typeof expected.eraCagrs];
        const historical = await runBacktestCore({
          preset: index === "sp500" ? "UPRO" : "TQQQ", smaEnabled: true,
          startDate: era.startDate, endDate: era.endDate,
          smaPeriod: expected.smaPeriod, smaUpperBuffer: expected.smaUpperBuffer, smaLowerBuffer: expected.smaLowerBuffer,
          riskOffAsset: DEFAULT_RISK_OFF_ASSET, smaExecutionMode: DEFAULT_SMA_EXECUTION_MODE,
        });
        assert.equal(recorded.startDate, historical.startDate);
        assert.equal(recorded.endDate, historical.endDate);
        const cpi = await fetchInflationData(historical.startDate, historical.endDate);
        const ratio = cpiIndexRatioEndOverStart(cpi.monthlyCpi, historical.startDate, historical.endDate);
        assert.equal(recorded.inflation.ratio, ratio);
        assert.ok(Math.abs(recorded.realCagr - calcCagr(1, historical.finalMultiple / ratio, historical.startDate, historical.endDate)) < 1e-9);
        assert.ok(Math.abs(recorded.cagr - historical.cagrPct) < 1e-9, `${index} ${era.key} CAGR differs from its own era backtest`);
      }
      let invested = result.smaStartInvested ?? true;
      let trade = 0;
      regimes.push(dates.map((date) => {
        while (trade < result.trades.length && result.trades[trade].date <= date) invested = result.trades[trade++].type === "buy";
        return invested;
      }));
    }
    let minDifference = 1;
    for (let a = 0; a < regimes.length; a++) for (let b = a + 1; b < regimes.length; b++) {
      const difference = regimes[a].filter((invested, day) => invested !== regimes[b][day]).length / dates.length;
      minDifference = Math.min(minDifference, difference);
      assert.ok(difference >= 0.05, `${index} presets ${a}/${b} behave too similarly`);
      const left = snapshot.presets[a][index];
      const right = snapshot.presets[b][index];
      assert.ok(Math.abs(left.smaPeriod - right.smaPeriod) >= 20
        || Math.abs(left.smaUpperBuffer - right.smaUpperBuffer) >= 3
        || Math.abs(left.smaLowerBuffer - right.smaLowerBuffer) >= 3);
    }
    assert.ok(Math.abs(minDifference * 100 - snapshot.minRegimeDifferencePct[index]) < 1e-9);
  }
});


test("preset selection retains early-era weights, stability penalties and the calibrated default", async () => {
  const defaults = snapshot.presets.filter((preset) => preset.isCalibratedDefault);
  assert.equal(defaults.length, 1);
  for (const index of ["sp500", "nasdaq100"] as const) {
    assert.deepEqual(snapshot.eraWeights[index], Object.fromEntries(SMA_CALIBRATION_ERAS[index].map((era) => [era.key, era.weight])));
    const expectedDefault = calibration[index];
    const actualDefault = defaults[0][index];
    assert.ok(actualDefault.score >= snapshot.bestFound[index].score - 1e-8,
      `${index} calibrated default must include the manual search's strongest discovery`);
    for (const field of ["smaPeriod", "smaUpperBuffer", "smaLowerBuffer"] as const) assert.equal(actualDefault[field], expectedDefault[field]);
    const contexts = await buildSmaEraContexts({ indexKey: index, endDate: snapshot.endDate,
      windowLength: snapshot.windowLength, maxPeriod: SMA_SEARCH_MAX_PERIOD });
    const combos = snapshot.presets.flatMap((preset) => planCombos(
      planPeriodNeighborhood(preset[index].smaPeriod, 1, { minPeriod: SMA_SEARCH_MIN_PERIOD, maxPeriod: SMA_SEARCH_MAX_PERIOD }),
      planBufferNeighborhood(preset[index].smaUpperBuffer, preset[index].smaLowerBuffer, 0.1, 0.1,
        { minBuffer: SMA_SEARCH_MIN_BUFFER, maxBuffer: SMA_SEARCH_MAX_BUFFER }), new Set<string>()));
    const results = new Map(evaluateCombosAcrossEras(contexts, combos).map((row) => [comboKey(row.combo), row]));
    for (const preset of snapshot.presets) {
      const expected = preset[index];
      const actual = results.get(comboKey(expected))!;
      assert.ok(Math.abs(actual.score - expected.baseScore) < 1e-8);
      assert.deepEqual(actual.scoresByEra, expected.scoresByEra);
      assert.ok(Math.abs(combineEraScores(index, expected.scoresByEra) - expected.baseScore) < 1e-8);
      const local = planCombos(planPeriodNeighborhood(expected.smaPeriod, 1, { minPeriod: SMA_SEARCH_MIN_PERIOD, maxPeriod: SMA_SEARCH_MAX_PERIOD }),
        planBufferNeighborhood(expected.smaUpperBuffer, expected.smaLowerBuffer, 0.1, 0.1,
          { minBuffer: SMA_SEARCH_MIN_BUFFER, maxBuffer: SMA_SEARCH_MAX_BUFFER }), new Set<string>());
      const worst = Math.min(...local.map((combo) => results.get(comboKey(combo))!.score));
      const stable = stabilityAdjustedSmaScore(actual.score, worst);
      assert.ok(Math.abs(stable - expected.score) < 1e-8);
      assert.ok(Math.abs(expected.baseScore - expected.score - expected.stabilityPenalty) < 1e-8);
    }
    if (index === "sp500") {
      // Regression: the modern-only winner's older crashes must affect selection.
      const bad = evaluateCombosAcrossEras(contexts, [{ smaPeriod: 37, smaUpperBuffer: 10.5, smaLowerBuffer: 13.7 }])[0];
      assert.ok(bad.score < 0);
      assert.ok(bad.scoresByEra.start! > 0);
      assert.ok(bad.scoresByEra.proxy! < 0);
      assert.ok(bad.scoresByEra.proto! < 0);
      assert.ok(bad.score < actualDefault.score);
    }
  }
});


test("joint refinement covers every integer period and fractional buffers within search bounds", () => {
  const center = snapPresetCombo({ smaPeriod: 32, smaUpperBuffer: 8, smaLowerBuffer: 6.2 });
  assert.equal(center.smaPeriod, 32);
  const points = refinePresetGrid(center);
  const keys = new Set(points.map(comboKey));
  for (const smaPeriod of Array.from({ length: 11 }, (_, i) => i + 27)) {
    assert.ok(keys.has(comboKey({ smaPeriod, smaUpperBuffer: 7.9, smaLowerBuffer: 6.3 })));
    assert.ok(keys.has(comboKey({ smaPeriod, smaUpperBuffer: 8.1, smaLowerBuffer: 6.1 })));
  }
  assert.equal(points.length, 11 * 9 * 9);
  const allPeriods = sweepPresetPeriods([{ smaPeriod: 150, smaUpperBuffer: 7.8, smaLowerBuffer: 12.1 }]);
  assert.equal(allPeriods.length, 261);
  assert.deepEqual(allPeriods.map((combo) => combo.smaPeriod), Array.from({ length: 261 }, (_, i) => i + 20));
  assert.ok(allPeriods.some((combo) => combo.smaPeriod === 177 && combo.smaUpperBuffer === 7.8 && combo.smaLowerBuffer === 12.1));
  for (const combo of refinePresetGrid({ smaPeriod: 20, smaUpperBuffer: 0.1, smaLowerBuffer: 20.9 })) {
    assert.ok(combo.smaPeriod >= 20 && combo.smaPeriod <= 280);
    assert.equal(Number.isInteger(combo.smaPeriod), true);
    for (const buffer of [combo.smaUpperBuffer, combo.smaLowerBuffer]) {
      assert.ok(buffer >= 0 && buffer <= 21);
      assert.ok(Math.abs(buffer * 10 - Math.round(buffer * 10)) < 1e-9);
    }
  }
});
