/**
 * Shared shape for the saved SMA calibration result — written by
 * scripts/calibrate-sma.ts, served by src/app/api/sma-calibration/route.ts,
 * and consumed by the Signals page's "Set default" button.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { SmaSignalConfig } from "@/lib/sma-status";

export interface SmaCalibrationIndexResult {
  smaPeriod: number;
  smaUpperBuffer: number;
  smaLowerBuffer: number;
  score: number;
  avgReturn: number;
  worstReturn: number;
  avgMaxDrawdown: number;
  avgTrades: number;
}

export interface SmaCalibrationResult {
  generatedAt: string;
  startDate: string;
  endDate: string;
  windowLength: number;
  sp500: SmaCalibrationIndexResult;
  nasdaq100: SmaCalibrationIndexResult;
}

const smaCalibrationIndexResultSchema = z.object({
  smaPeriod: z.number(),
  smaUpperBuffer: z.number(),
  smaLowerBuffer: z.number(),
  score: z.number(),
  avgReturn: z.number(),
  worstReturn: z.number(),
  avgMaxDrawdown: z.number(),
  avgTrades: z.number(),
});

const smaCalibrationResultSchema = z.object({
  generatedAt: z.string(),
  startDate: z.string(),
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

export function applyCalibratedSmaDefaults(
  config: SmaSignalConfig,
  calibration: SmaCalibrationResult
): SmaSignalConfig {
  return {
    ...config,
    smaSpPeriod: calibration.sp500.smaPeriod,
    smaSpUpperBuffer: calibration.sp500.smaUpperBuffer,
    smaSpLowerBuffer: calibration.sp500.smaLowerBuffer,
    smaNqPeriod: calibration.nasdaq100.smaPeriod,
    smaNqUpperBuffer: calibration.nasdaq100.smaUpperBuffer,
    smaNqLowerBuffer: calibration.nasdaq100.smaLowerBuffer,
  };
}
