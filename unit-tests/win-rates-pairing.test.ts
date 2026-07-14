import test from "node:test";
import assert from "node:assert/strict";
import { joinByWindow } from "../src/lib/simulation/win-rates";
import type { RollingSimulationPoint } from "../src/lib/simulation/rolling";

function makeSim(startDate: string, endDate: string, finalValue: number): RollingSimulationPoint {
  return {
    startDate,
    endDate,
    finalValue,
    nonLeveragedFinalValue: finalValue,
    maxDrawdownPct: 0,
    nonLeveragedMaxDrawdownPct: 0,
    cagr: 0,
    totalReturnPct: 0,
    tradeCount: 0,
    totalTradingCostPct: 0,
  };
}

/**
 * Mirrors the pre-fix `for (i = 0; i < smaBucket.length; i++)` index zip,
 * so the divergence from `joinByWindow` below is visible in the test itself
 * rather than only in a diff against a prior commit.
 */
function indexZip(
  smaSimulations: RollingSimulationPoint[],
  noSmaSimulations: RollingSimulationPoint[]
): Array<{ smaRun: RollingSimulationPoint; noSmaRun: RollingSimulationPoint | undefined }> {
  return smaSimulations.map((smaRun, i) => ({ smaRun, noSmaRun: noSmaSimulations[i] }));
}

test("joinByWindow pairs by (startDate, endDate), not array position", () => {
  // Five monthly rolling windows. The no-SMA config's window starting
  // 2020-03-01 was dropped by extraction (e.g. a leveraged wipeout) while
  // the SMA config kept all five — mirroring parallel.ts dropping a window
  // for one config's bucket but not the other's.
  const smaSimulations = [
    makeSim("2020-01-01", "2021-01-01", 150), // W0
    makeSim("2020-02-01", "2021-02-01", 90),  // W1
    makeSim("2020-03-01", "2021-03-01", 50),  // W2 — no counterpart below
    makeSim("2020-04-01", "2021-04-01", 140), // W3
    makeSim("2020-05-01", "2021-05-01", 70),  // W4
  ];
  const noSmaSimulations = [
    makeSim("2020-01-01", "2021-01-01", 100), // W0
    makeSim("2020-02-01", "2021-02-01", 120), // W1
    // W2 (2020-03-01) missing — dropped for this config only.
    makeSim("2020-04-01", "2021-04-01", 130), // W3
    makeSim("2020-05-01", "2021-05-01", 200), // W4
  ];

  const pairs = joinByWindow(smaSimulations, noSmaSimulations);

  // Every window from the SMA bucket is still represented...
  assert.equal(pairs.length, smaSimulations.length);

  // ...and every match has the SAME start/end date on both sides.
  for (const { smaRun, noSmaRun } of pairs) {
    if (!noSmaRun) continue;
    assert.equal(noSmaRun.startDate, smaRun.startDate, `startDate mismatch for ${smaRun.startDate}`);
    assert.equal(noSmaRun.endDate, smaRun.endDate, `endDate mismatch for ${smaRun.startDate}`);
  }

  // The dropped window (W2) has no match; every other window does.
  const byStart = new Map(pairs.map((p) => [p.smaRun.startDate, p.noSmaRun]));
  assert.equal(byStart.get("2020-03-01"), undefined);
  assert.equal(byStart.get("2020-01-01")?.finalValue, 100);
  assert.equal(byStart.get("2020-02-01")?.finalValue, 120);
  assert.equal(byStart.get("2020-04-01")?.finalValue, 130);
  assert.equal(byStart.get("2020-05-01")?.finalValue, 200);

  // Hand-computed win rate from the correctly-joined pairs: SMA beats
  // no-SMA on final value, ties count as half a win, unmatched windows
  // are excluded entirely (same rule the production loop applies).
  let wins = 0;
  let total = 0;
  for (const { smaRun, noSmaRun } of pairs) {
    if (!noSmaRun) continue;
    total += 1;
    if (smaRun.finalValue > noSmaRun.finalValue) wins += 1;
    else if (smaRun.finalValue === noSmaRun.finalValue) wins += 0.5;
  }
  assert.equal(total, 4);
  assert.equal(wins, 2);
  assert.equal((wins / total) * 100, 50);

  // The bug this guards against: zipping by array position instead of by
  // window key silently shifts every pairing after the dropped window,
  // corrupting the win rate even though no error is ever thrown.
  const buggyPairs = indexZip(smaSimulations, noSmaSimulations);
  let buggyWins = 0;
  let buggyTotal = 0;
  for (const { smaRun, noSmaRun } of buggyPairs) {
    if (!noSmaRun) continue;
    buggyTotal += 1;
    if (smaRun.finalValue > noSmaRun.finalValue) buggyWins += 1;
    else if (smaRun.finalValue === noSmaRun.finalValue) buggyWins += 0.5;
  }
  assert.equal(buggyTotal, 4);
  assert.equal(buggyWins, 1);
  assert.equal((buggyWins / buggyTotal) * 100, 25);
  assert.notEqual((buggyWins / buggyTotal) * 100, (wins / total) * 100);
});

test("joinByWindow is invariant to which side drops a window", () => {
  const smaSimulations = [
    makeSim("2020-01-01", "2021-01-01", 100),
    // W1 dropped from the SMA bucket instead.
    makeSim("2020-03-01", "2021-03-01", 300),
  ];
  const noSmaSimulations = [
    makeSim("2020-01-01", "2021-01-01", 90),
    makeSim("2020-02-01", "2021-02-01", 200),
    makeSim("2020-03-01", "2021-03-01", 280),
  ];

  const pairs = joinByWindow(smaSimulations, noSmaSimulations);

  assert.equal(pairs.length, 2);
  assert.equal(pairs[0].noSmaRun?.startDate, "2020-01-01");
  assert.equal(pairs[1].noSmaRun?.startDate, "2020-03-01");
});

test("joinByWindow matches on both startDate and endDate, not startDate alone", () => {
  const smaSimulations = [makeSim("2020-01-01", "2021-01-01", 100)];
  const noSmaSimulations = [makeSim("2020-01-01", "2020-06-01", 999)];

  const pairs = joinByWindow(smaSimulations, noSmaSimulations);

  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].noSmaRun, undefined);
});
