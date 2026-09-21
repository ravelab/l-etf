/**
 * ONE-OFF exhaustive search of the joint (SMA period, upper buffer, lower
 * buffer) space, per index, over the whole calibration range.
 *
 * This is the expensive half of the two-stage calibration. It evaluates EVERY
 * period against EVERY buffer cell — hundreds of thousands of backtests, tens
 * of minutes across all cores — and writes the per-period buffer seeds that
 * `calibrate-sma.ts` then uses to do a real joint search in ~30s a month.
 *
 * Re-run it by hand when the score function, the trading-cost model, the
 * risk-off default or the calibration range changes — not on a schedule. The
 * monthly run re-scans every period anyway, so seeds age gracefully.
 *
 * Usage:
 *   npm run explore-sma
 *   npm run explore-sma -- --buffer-step=1 --index=nasdaq100
 *   npm run explore-sma -- --workers=4 --dry-run
 */

import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { fork, type ChildProcess } from "node:child_process";
import { availableParallelism } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getDefaultWindowLength } from "../src/lib/simulation/defaults";
import {
  SMA_CALIBRATION_ERAS,
  describeEraWeights,
  primaryEra,
} from "../src/lib/simulation/sma-calibration-eras";
import { buildAxis } from "../src/lib/simulation/grid-axis";
import {
  SMA_SEARCH_SPACE_SNAPSHOT_PATH,
  readSmaSearchSpaceSnapshot,
  type SmaSearchSpaceGrid,
  type SmaSearchSpaceIndexResult,
  type SmaSearchSpaceSnapshot,
  type SmaSeed,
} from "../src/lib/sma-search-space";
import {
  SMA_SEARCH_MAX_BUFFER,
  SMA_SEARCH_MAX_PERIOD,
  SMA_SEARCH_MIN_BUFFER,
  SMA_SEARCH_MIN_PERIOD,
} from "../src/lib/simulation/sma-search-bounds";
import { getLatestSharedTradeDate } from "./lib/sweep-data";
import type {
  ExploreWorkerRequest,
  ExploreWorkerResponse,
} from "./lib/sma-explore-worker";
import type { IndexKey } from "../src/lib/simulation/types";

// fileURLToPath, not url.pathname: the latter is percent-encoded, so a repo
// checked out under a path with a space forks a file that does not exist.
const WORKER_PATH = join(dirname(fileURLToPath(import.meta.url)), "lib", "sma-explore-worker.ts");

const DEFAULT_BUFFER_STEP = 0.5;
const DEFAULT_PERIOD_STEP = 1;
/**
 * Periods handed to a worker at a time. One keeps every core fed to the last
 * second of the run: periods differ in cost, and a bigger batch means the run
 * ends with most cores idle behind one straggler.
 */
const PERIODS_PER_ASSIGNMENT = 1;

interface Options {
  bufferStep: number;
  periodStep: number;
  workers: number;
  indices: IndexKey[];
  outPath: string;
  dryRun: boolean;
}

function parseNumberFlag(raw: string | undefined, fallback: number, label: string): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`--${label} must be a positive number, got "${raw}"`);
  }
  return value;
}

function parseOptions(argv: string[]): Options {
  const flags = new Map<string, string>();
  for (const arg of argv) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (!match) throw new Error(`Unrecognized argument "${arg}"`);
    flags.set(match[1], match[2] ?? "true");
  }
  const known = new Set(["buffer-step", "period-step", "workers", "index", "out", "dry-run"]);
  for (const key of flags.keys()) {
    if (!known.has(key)) throw new Error(`Unknown flag --${key}. Known: ${[...known].join(", ")}`);
  }

  const indexFlag = flags.get("index") ?? "both";
  const indices: IndexKey[] =
    indexFlag === "both"
      ? ["sp500", "nasdaq100"]
      : indexFlag === "sp500" || indexFlag === "nasdaq100"
        ? [indexFlag]
        : (() => {
            throw new Error(`--index must be sp500, nasdaq100 or both, got "${indexFlag}"`);
          })();

  return {
    bufferStep: parseNumberFlag(flags.get("buffer-step"), DEFAULT_BUFFER_STEP, "buffer-step"),
    periodStep: Math.round(parseNumberFlag(flags.get("period-step"), DEFAULT_PERIOD_STEP, "period-step")),
    workers: Math.max(
      1,
      Math.round(
        parseNumberFlag(flags.get("workers"), Math.max(1, availableParallelism() - 1), "workers")
      )
    ),
    indices,
    outPath: flags.get("out") ?? SMA_SEARCH_SPACE_SNAPSHOT_PATH,
    dryRun: flags.get("dry-run") === "true",
  };
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

/**
 * Run every period for one index across `workers` child processes, handing out
 * assignments as workers free up rather than splitting the period list up
 * front — periods differ in cost, and a static split leaves cores idle at the
 * end of the run.
 */
async function explodeIndex(
  indexKey: IndexKey,
  endDate: string,
  windowLength: number,
  periods: number[],
  options: Options
): Promise<SmaSearchSpaceIndexResult> {
  const startDate = primaryEra(indexKey).startDate;
  const pending = [...periods];
  const seeds: SmaSeed[] = [];
  const startedAt = Date.now();
  let completedPeriods = 0;
  let lastLoggedAt = 0;

  const workerCount = Math.min(options.workers, Math.max(1, pending.length));

  await new Promise<void>((resolve, reject) => {
    const children: ChildProcess[] = [];
    // How many periods each child currently owns. Counting the batch size back
    // rather than assuming PERIODS_PER_ASSIGNMENT keeps the progress line and
    // the completion check honest on the final, partial batch — and a worker
    // legitimately returns fewer seeds than periods when one scores no finite
    // result, so the seed count cannot stand in for it.
    const outstanding = new Map<ChildProcess, number>();
    let settled = false;

    const shutdown = (): void => {
      for (const child of children) {
        if (child.connected) child.send({ type: "stop" } satisfies ExploreWorkerRequest);
        child.kill();
      }
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      shutdown();
      reject(error);
    };
    const finishIfDone = (): void => {
      if (settled) return;
      if (pending.length === 0 && completedPeriods >= periods.length) {
        settled = true;
        shutdown();
        resolve();
      }
    };

    const assign = (child: ChildProcess): void => {
      if (settled || pending.length === 0) return;
      const batch = pending.splice(0, PERIODS_PER_ASSIGNMENT);
      outstanding.set(child, batch.length);
      child.send({ type: "assign", periods: batch } satisfies ExploreWorkerRequest);
    };

    for (let i = 0; i < workerCount; i++) {
      const child = fork(WORKER_PATH, [], {
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "ignore", "inherit", "ipc"],
      });
      children.push(child);

      child.on("message", (message: ExploreWorkerResponse) => {
        if (message.type === "failure") {
          fail(new Error(`[${indexKey}] worker failed: ${message.message}`));
          return;
        }
        if (message.type === "ready") {
          assign(child);
          return;
        }
        seeds.push(...message.seeds);
        completedPeriods += outstanding.get(child) ?? 0;
        outstanding.delete(child);

        const elapsed = Date.now() - startedAt;
        if (elapsed - lastLoggedAt > 15_000 || completedPeriods >= periods.length) {
          lastLoggedAt = elapsed;
          const done = Math.min(completedPeriods, periods.length);
          const rate = done / Math.max(1, elapsed);
          const remaining = (periods.length - done) / Math.max(1e-9, rate);
          console.log(
            `  [${indexKey}] ${done}/${periods.length} periods · ${formatDuration(elapsed)} elapsed · ~${formatDuration(remaining)} left`
          );
        }
        assign(child);
        finishIfDone();
      });

      child.on("error", (error) => fail(error));
      child.on("exit", (code) => {
        if (settled) return;
        if (code !== 0 && code !== null) {
          fail(new Error(`[${indexKey}] worker exited with code ${code}`));
          return;
        }
        // A clean exit while the child still owns periods would otherwise
        // leave `completedPeriods` short forever and hang the whole run.
        if (outstanding.has(child)) {
          fail(new Error(`[${indexKey}] worker exited while still holding ${outstanding.get(child)} period(s)`));
        }
      });

      child.send({
        type: "init",
        indexKey,
        endDate,
        windowLength,
        maxPeriod: SMA_SEARCH_MAX_PERIOD,
        minBuffer: SMA_SEARCH_MIN_BUFFER,
        maxBuffer: SMA_SEARCH_MAX_BUFFER,
        bufferStep: options.bufferStep,
      } satisfies ExploreWorkerRequest);
    }
  });

  if (seeds.length === 0) throw new Error(`[${indexKey}] exhaustive search produced no seeds`);
  seeds.sort((a, b) => a.smaPeriod - b.smaPeriod);
  const best = seeds.reduce((acc, seed) => (seed.score > acc.score ? seed : acc), seeds[0]);
  const eraWeights = Object.fromEntries(
    SMA_CALIBRATION_ERAS[indexKey].map((era) => [era.key, era.weight])
  );
  return { startDate, eraWeights, best, periodSeeds: seeds };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const endDate = await getLatestSharedTradeDate(["sp500", "nasdaq100", "risk:SGOV"]);
  const windowLength = getDefaultWindowLength();

  const periods: number[] = [];
  for (let p = SMA_SEARCH_MIN_PERIOD; p <= SMA_SEARCH_MAX_PERIOD; p += options.periodStep) {
    periods.push(p);
  }
  const bufferCells = buildAxis(SMA_SEARCH_MIN_BUFFER, SMA_SEARCH_MAX_BUFFER, options.bufferStep).length ** 2;
  const totalPerIndex = periods.length * bufferCells;

  const grid: SmaSearchSpaceGrid = {
    minPeriod: SMA_SEARCH_MIN_PERIOD,
    maxPeriod: SMA_SEARCH_MAX_PERIOD,
    periodStep: options.periodStep,
    minBuffer: SMA_SEARCH_MIN_BUFFER,
    maxBuffer: SMA_SEARCH_MAX_BUFFER,
    bufferStep: options.bufferStep,
  };

  console.log(`[explore-sma] endDate=${endDate} windowLength=${windowLength}y workers=${options.workers}`);
  console.log(
    `[explore-sma] grid: period ${grid.minPeriod}..${grid.maxPeriod} step ${grid.periodStep} (${periods.length}) x buffer ${grid.minBuffer}..${grid.maxBuffer} step ${grid.bufferStep} (${bufferCells} cells)`
  );
  console.log(
    `[explore-sma] ${totalPerIndex.toLocaleString()} backtests per index · ${(totalPerIndex * options.indices.length).toLocaleString()} total`
  );
  if (options.dryRun) {
    console.log("[explore-sma] --dry-run: stopping before any simulation");
    return;
  }

  const startedAt = Date.now();
  const results: Partial<Record<IndexKey, SmaSearchSpaceIndexResult>> = {};
  for (const indexKey of options.indices) {
    console.log(
      `[explore-sma] Exploring ${indexKey} across ${SMA_CALIBRATION_ERAS[indexKey].length} eras (${describeEraWeights(indexKey)})`
    );
    const result = await explodeIndex(indexKey, endDate, windowLength, periods, options);
    results[indexKey] = result;
    const eraDetail = Object.entries(result.best.scoresByEra ?? {})
      .map(([era, score]) => `${era}=${score.toFixed(0)}`)
      .join(" ");
    console.log(
      `[explore-sma] ${indexKey} best: ${result.best.smaPeriod}d -${result.best.smaLowerBuffer}%/+${result.best.smaUpperBuffer}% weighted=${result.best.score.toFixed(1)} (${eraDetail})`
    );
  }

  // A single-index run must not drop the other index's seeds from the file.
  const previous = await readSmaSearchSpaceSnapshot();
  const sp500 = results.sp500 ?? previous?.sp500;
  const nasdaq100 = results.nasdaq100 ?? previous?.nasdaq100;
  if (!sp500 || !nasdaq100) {
    throw new Error(
      "Both indices need seeds. Run without --index (or keep the existing snapshot in place) so the other index can be carried over."
    );
  }

  const payload: SmaSearchSpaceSnapshot = {
    generatedAt: new Date().toISOString(),
    endDate,
    windowLength,
    grid,
    sp500,
    nasdaq100,
  };
  mkdirSync(dirname(options.outPath), { recursive: true });
  writeFileSync(options.outPath, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(
    `[explore-sma] Wrote ${options.outPath} in ${formatDuration(Date.now() - startedAt)}`
  );
}

main().catch((error: unknown) => {
  console.error("[explore-sma] Fatal error:", error);
  process.exitCode = 1;
});
