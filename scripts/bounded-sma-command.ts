import { runSmaPhase } from "./lib/sma-refresh-phase";
import { smaBudgetMinutes, SMA_REFRESH_LIMITS } from "./lib/sma-search-budget";

async function main() {
  const phase = process.argv[2];
  const args = process.argv.slice(3);
  const scripts: Record<string, string> = {
    seeds: "explore-sma-space", calibration: "calibrate-sma", presets: "explore-sma-cagr-presets",
  };
  const script = scripts[phase];
  if (!script) throw new Error("Unknown SMA search phase");
  const minutes = phase === "presets" ? Math.min(SMA_REFRESH_LIMITS.total, smaBudgetMinutes(args) + 5) : SMA_REFRESH_LIMITS.total;
  await runSmaPhase(["--import", "tsx", `scripts/${script}.ts`, ...args], minutes * 60_000);
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
