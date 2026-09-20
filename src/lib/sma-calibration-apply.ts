// Client-safe half of the SMA calibration module: applying a calibration
// snapshot to a signal config is pure, but `sma-calibration.ts` reads the
// snapshot off disk (`node:fs/promises`) and so cannot be imported from a
// `"use client"` component. The Signals page and its push-alerts card need this
// to show, and subscribe with, the calibrated band while the on-page inputs stay
// free — see `syncCalibratedPushSubscriptions`, which applies the same function
// server-side before each cron evaluation.

import type { SmaCalibrationResult } from "@/lib/sma-calibration";
import type { SmaSignalConfig } from "@/lib/sma-status";

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
