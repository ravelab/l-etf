/**
 * Shared shape for the saved SMA calibration result — written by
 * scripts/calibrate-sma.ts, served by src/app/api/sma-calibration/route.ts,
 * and consumed by the Signals page's "Set default" button.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export interface SmaCalibrationIndexResult {
  /**
   * First date this index was calibrated over. Per-index because SPX and NDX
   * use different shortcut starts (see CONSTANT_SP500_SHORTCUT_DATE /
   * CONSTANT_NASDAQ100_SHORTCUT_DATE) — a single top-level field recorded one
   * index's start as if it applied to both.
   */
  startDate: string;
  /** Actual observed span in years; one unwrapped window. */
  windowLength?: number;
  historyWrap?: boolean;
  smaPeriod: number;
  smaUpperBuffer: number;
  smaLowerBuffer: number;
  score: number;
  /** Full-period score before the neighboring-parameter stability penalty. */
  baseScore?: number;
  stabilityPenalty?: number;
  avgReturn: number;
  worstReturn: number;
  avgMaxDrawdown: number;
  avgTrades: number;
  smaOnlySwitches?: number;
  /** How many (period, upper, lower) combos the joint search scored. */
  evaluatedCombos?: number;
  /**
   * Full-period score under `start`. Legacy snapshots may also contain older
   * weighted eras; current calibration excludes those reconstructed histories.
   */
  scoresByEra?: Record<string, number>;
  eraWeights?: Record<string, number>;
  /**
   * Score of the winner's worst / median immediate neighbour — one SMA day or
   * 0.1% of buffer away. The score surface is spiky along the period axis, so
   * a winner whose neighbours collapse is a knife edge fitted to this sample
   * rather than a rule worth running forward. The calibration score subtracts
   * half the gap beyond a 5% allowance for positive base scores.
   */
  neighborhoodMinScore?: number;
  neighborhoodMedianScore?: number;
}

export interface SmaCalibrationResult {
  generatedAt: string;
  endDate: string;
  /** SPX span for legacy consumers; each index records its own duration. */
  windowLength: number;
  sp500: SmaCalibrationIndexResult;
  nasdaq100: SmaCalibrationIndexResult;
}

const smaCalibrationIndexResultSchema = z.object({
  startDate: z.string(),
  windowLength: z.number().optional(),
  historyWrap: z.boolean().optional(),
  smaPeriod: z.number(),
  smaUpperBuffer: z.number(),
  smaLowerBuffer: z.number(),
  score: z.number(),
  baseScore: z.number().optional(),
  stabilityPenalty: z.number().optional(),
  avgReturn: z.number(),
  worstReturn: z.number(),
  avgMaxDrawdown: z.number(),
  avgTrades: z.number(),
  smaOnlySwitches: z.number().optional(),
  evaluatedCombos: z.number().optional(),
  scoresByEra: z.record(z.string(), z.number()).optional(),
  eraWeights: z.record(z.string(), z.number()).optional(),
  neighborhoodMinScore: z.number().optional(),
  neighborhoodMedianScore: z.number().optional(),
});

const smaCalibrationResultSchema = z.object({
  generatedAt: z.string(),
  endDate: z.string(),
  windowLength: z.number(),
  sp500: smaCalibrationIndexResultSchema,
  nasdaq100: smaCalibrationIndexResultSchema,
});

export const SMA_CALIBRATION_SNAPSHOT_PATH = join(process.cwd(), "src", "lib", "tool-snapshots", "sma-calibration.json");

export async function readSmaCalibrationSnapshot(): Promise<SmaCalibrationResult | null> {
  try {
    const raw = await readFile(SMA_CALIBRATION_SNAPSHOT_PATH, "utf-8");
    const parsed = smaCalibrationResultSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
