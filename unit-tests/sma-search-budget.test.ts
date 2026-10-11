import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SmaSearchBudget, smaBudgetMinutes, SMA_REFRESH_LIMITS } from "../scripts/lib/sma-search-budget";
import { runSmaPhase, SmaPhaseTimeout } from "../scripts/lib/sma-refresh-phase";

test("the worst-case combined refresh fits under an hour, including fallback finalization", () => {
  const l = SMA_REFRESH_LIMITS;
  const longest = l.data + l.seeds + l.calibration + l.presets + l.presetGrace + l.finalization + l.snapshots;
  assert.ok(longest < l.total);
  assert.ok(l.total < 60);
});

test("the two indices share the remaining budget rather than each taking the full limit", () => {
  let now = 0;
  const total = new SmaSearchBudget(120_000, () => now);
  const first = total.allocate(2);
  now = 31_000;
  assert.equal(first.canRefine(), false, "SPX must leave its remaining allocation for finishing");
  assert.equal(total.allocate(1).canRefine(), true, "NDX still has its own time");
  now = 91_000;
  assert.equal(total.canRefine(), false);
});

test("preset search validates budgets and permits immediate finalization", () => {
  assert.equal(smaBudgetMinutes([]), 15);
  assert.equal(smaBudgetMinutes(["--budget-minutes=0"]), 0);
  for (const value of ["NaN", "-1", "Infinity", "46"]) assert.throws(() => smaBudgetMinutes([`--budget-minutes=${value}`]));
});

test("a stuck refresh phase is terminated by its watchdog", async () => {
  const started = Date.now();
  await assert.rejects(runSmaPhase(["-e", "setInterval(() => {}, 1000)"], 250), SmaPhaseTimeout);
  assert.ok(Date.now() - started < 5000);
  await assert.rejects(runSmaPhase(["-e", "process.exit(0)"], 0), SmaPhaseTimeout);
});

test("a successful refresh phase clears its watchdog", async () => {
  await runSmaPhase(["-e", "process.exit(0)"], 5000);
});

test("timeout cleanup also stops a scoring descendant that ignores SIGTERM", async () => {
  const directory = mkdtempSync(join(tmpdir(), "sma-watchdog-"));
  const file = join(directory, "worker-pid");
  let pid: number | undefined;
  try {
    const worker = 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)';
    const parent = `const c = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(worker)}], {stdio:"ignore"}); require("node:fs").writeFileSync(${JSON.stringify(file)}, String(c.pid)); setInterval(() => {}, 1000);`;
    await assert.rejects(runSmaPhase(["-e", parent], 1000), SmaPhaseTimeout);
    pid = Number(readFileSync(file, "utf8"));
    const stopped = () => {
      try { process.kill(pid!, 0); return false; }
      catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
    };
    for (let i = 0; i < 80 && !stopped(); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(stopped(), true, "the forked worker must not outlive the refresh budget");
  } finally {
    if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* Already stopped. */ } }
    rmSync(directory, { recursive: true, force: true });
  }
});
