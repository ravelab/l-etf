/**
 * Forked worker for `scripts/explore-sma-space.ts`.
 *
 * One child process per core. Each builds its own sweep context PER ERA (a
 * second or so of CSV reads) and then answers "best (upper, lower) at this
 * period, scored across all eras" requests until the parent says stop. Processes rather than worker threads:
 * the engine holds a full daily-value series per config, so separate heaps keep
 * one greedy chunk from pushing the whole run into swap.
 */

import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { buildAxis } from "../../src/lib/simulation/grid-axis";
import type { SmaCombo } from "../../src/lib/simulation/sma-search";
import type { SmaSeed } from "../../src/lib/sma-search-space";
import { buildSmaEraContexts, evaluateCombosAcrossEras, type SmaEraContexts } from "./sma-sweep-context";
import type { IndexKey } from "../../src/lib/simulation/types";

export interface ExploreWorkerInit {
  type: "init";
  indexKey: IndexKey;
  endDate: string;
  windowLength: number;
  maxPeriod: number;
  minBuffer: number;
  maxBuffer: number;
  bufferStep: number;
}

export interface ExploreWorkerAssign {
  type: "assign";
  periods: number[];
}

export interface ExploreWorkerStop {
  type: "stop";
}

export type ExploreWorkerRequest = ExploreWorkerInit | ExploreWorkerAssign | ExploreWorkerStop;

export interface ExploreWorkerReady {
  type: "ready";
}

export interface ExploreWorkerSeeds {
  type: "seeds";
  seeds: SmaSeed[];
}

export interface ExploreWorkerFailure {
  type: "failure";
  message: string;
}

export type ExploreWorkerResponse = ExploreWorkerReady | ExploreWorkerSeeds | ExploreWorkerFailure;

function send(message: ExploreWorkerResponse): void {
  process.send?.(message);
}

async function main(): Promise<void> {
  let eras: SmaEraContexts | null = null;
  let bufferPoints: Array<{ upper: number; lower: number }> = [];
  // Requests are handled strictly in order; without this an `assign` that
  // arrives while `init` is still loading CSVs would run against a null ctx.
  let queue: Promise<void> = Promise.resolve();

  const handleInit = async (message: ExploreWorkerInit): Promise<void> => {
    eras = await buildSmaEraContexts({
      indexKey: message.indexKey,
      endDate: message.endDate,
      windowLength: message.windowLength,
      maxPeriod: message.maxPeriod,
    });
    const axis = buildAxis(message.minBuffer, message.maxBuffer, message.bufferStep);
    bufferPoints = [];
    for (const upper of axis) {
      for (const lower of axis) bufferPoints.push({ upper, lower });
    }
    send({ type: "ready" });
  };

  const handleAssign = (message: ExploreWorkerAssign): void => {
    if (!eras) throw new Error("Worker received work before init completed");
    const seeds: SmaSeed[] = [];
    for (const smaPeriod of message.periods) {
      const combos: SmaCombo[] = bufferPoints.map(({ upper, lower }) => ({
        smaPeriod,
        smaUpperBuffer: upper,
        smaLowerBuffer: lower,
      }));
      let best: SmaSeed | null = null;
      for (const evaluated of evaluateCombosAcrossEras(eras, combos)) {
        if (!Number.isFinite(evaluated.score)) continue;
        if (best === null || evaluated.score > best.score) {
          best = {
            smaPeriod,
            smaUpperBuffer: evaluated.combo.smaUpperBuffer,
            smaLowerBuffer: evaluated.combo.smaLowerBuffer,
            score: evaluated.score,
            scoresByEra: { ...evaluated.scoresByEra },
          };
        }
      }
      // A period with no finite score is dropped rather than seeded with a
      // placeholder the monthly run would then centre a search on.
      if (best) seeds.push(best);
    }
    send({ type: "seeds", seeds });
  };

  process.on("message", (message: ExploreWorkerRequest) => {
    if (message.type === "stop") {
      process.exit(0);
    }
    queue = queue
      .then(() => (message.type === "init" ? handleInit(message) : handleAssign(message)))
      .catch((error: unknown) => {
        send({ type: "failure", message: error instanceof Error ? error.message : String(error) });
      });
  });
}

main().catch((error: unknown) => {
  send({ type: "failure", message: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
