/** Both indices, data refresh and canned results: at most 55 minutes combined. */
import { runSmaPhase, SmaPhaseTimeout } from "./lib/sma-refresh-phase";
import { SMA_REFRESH_LIMITS as limits } from "./lib/sma-search-budget";

async function main() {
  const startedAt = Date.now();
  const deadline = startedAt + limits.total * 60_000;
  const remaining = () => Math.max(0, deadline - Date.now());
  const run = (script: string, minutes: number, args: string[] = []) =>
    runSmaPhase(["--import", "tsx", `scripts/${script}.ts`, ...args], Math.min(minutes * 60_000, remaining()));
  await run("fetch-data", limits.data);
  // Existing seeds are re-scored, never carried forward with stale scores.
  // The full coarse-grid exploration remains a separate explicit operation.
  await run("refresh-sma-seeds", limits.seeds);
  try { await run("calibrate-sma", limits.calibration); }
  catch (error) {
    if (!(error instanceof SmaPhaseTimeout)) throw error;
    console.log("[refresh-sma] calibration budget reached; preset search will re-score saved bands");
  }
  const presetMinutes = Math.min(limits.presets, Math.max(0, remaining() / 60_000 - limits.finalization - limits.snapshots - 2));
  try { await run("explore-sma-cagr-presets", presetMinutes + limits.presetGrace, ["--write-presets", `--budget-minutes=${presetMinutes}`]); }
  catch (error) {
    if (!(error instanceof SmaPhaseTimeout)) throw error;
    console.log("[refresh-sma] finalizing fully checked candidates from saved scores");
    await run("explore-sma-cagr-presets", limits.finalization, ["--write-presets", "--budget-minutes=0"]);
  }
  await run("generate-snapshots", limits.snapshots);
  console.log(`[refresh-sma] completed both indices in ${((Date.now() - startedAt) / 60_000).toFixed(1)} minutes`);
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
