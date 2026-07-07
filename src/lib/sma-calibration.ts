/**
 * Shared shape for the saved SMA calibration result — written by
 * scripts/calibrate-sma.ts, served by src/app/api/sma-calibration/route.ts,
 * and consumed by the Signals page's "Set default" button.
 */

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
