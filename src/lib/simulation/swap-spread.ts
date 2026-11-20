import type { EtfConfig } from "./types";

// Swap spread model: spread = rateSensitivity * borrowRate + baseSpread
// Calibrated via binary search against actual ETF cumulative returns:
//   2x: SSO (2006–2026) and QLD (2006–2026)
//   3x: UPRO (2009–2026) and TQQQ (2010–2026)
// The spread represents the total additional cost above the benchmark borrowing rate
// that real leveraged ETFs pay for swap/futures financing. It scales with rates because
// banks charge a proportional premium on leveraged exposure.
//
// At the daily level: swapSpreadDaily = (rateSensitivity * annualBorrowRate + baseSpread) / 360
// where annualBorrowRate = borrowRateDaily * 360.
//
// Note: baseSpread includes empirically-calibrated conservative adjustment
// to ensure simulations match real ETFs within <0.005% final return difference,
// accounting for tracking error and trading frictions not captured in the model.
export type SwapSpreadModel = { rateSensitivity: number; baseSpread: number };
type SwapSpreadModels = Record<string, Record<number, SwapSpreadModel>>;

// `npm run calibrate` rewrites this literal in place, matching its first line
// and `const DEFAULT_SWAP_MODEL` (scripts/lib/swap-spread-source.ts).
let SWAP_SPREAD_MODEL: Record<string, Record<number, SwapSpreadModel>> = {
  // S&P 500 - calibrated 2026-11-02
  sp500: {
    // SSO (2x)
    2: { rateSensitivity: 0.730651, baseSpread: 0.001788 },
    // UPRO (3x)
    3: { rateSensitivity: 0.732150, baseSpread: 0.003640 },
  },
  // Nasdaq 100 - calibrated 2026-11-02
  nasdaq100: {
    // QLD (2x)
    2: { rateSensitivity: 0.702143, baseSpread: 0.000816 },
    // TQQQ (3x)
    3: { rateSensitivity: 0.819182, baseSpread: 0.000594 },
  },
};

const DEFAULT_SWAP_MODEL: SwapSpreadModel = { rateSensitivity: 0.7, baseSpread: 0.001 };

/**
 * Highest borrow rate the swap-spread model is actually fitted on.
 * `calibrate-etfs.ts` can only see the window where the real ETFs exist —
 * 2006-06-21 on for SSO/QLD, 2009/2010 on for UPRO/TQQQ — and the benchmark
 * tops out at 5.82% across it. The slope is well identified inside that range
 * (pinning it to zero blows UPRO's final tracking error out to 6%), but above
 * it there is no evidence at all, and a straight line compounds fast: at 1981's
 * 16.4% average fed funds rate it implies a 12-14%/yr credit spread over the
 * funding rate, several times anything a funding market has charged.
 */
const SWAP_SPREAD_CALIBRATED_RATE_MAX = 0.06;

/**
 * Slope the spread keeps above {@link SWAP_SPREAD_CALIBRATED_RATE_MAX}, where the
 * fitted credit spread holds flat but the risk-free rate must still pass through
 * in full. The engine charges `annualRate / 360` on ~252 trading days a year, so
 * the borrow term alone only delivers 252/360 of the rate; this covers the rest.
 * Without it, capping would make leveraged financing *cheaper* than risk-free.
 */
const SWAP_SPREAD_RATE_PASSTHROUGH_SLOPE = 360 / 252 - 1;

/**
 * Override the swap spread model (used by calibration script).
 * Returns the previous model so it can be restored.
 */
export function setSwapSpreadModel(model: SwapSpreadModels): SwapSpreadModels {
  const prev = SWAP_SPREAD_MODEL;
  SWAP_SPREAD_MODEL = model;
  return prev;
}

/** Get a deep copy of the current swap spread model. */
export function getSwapSpreadModel(): SwapSpreadModels {
  return JSON.parse(JSON.stringify(SWAP_SPREAD_MODEL));
}

/**
 * Compute the daily swap spread for a given index, leverage, and borrowing rate.
 * borrowRateDaily is already in daily units (annualRate / 100 / 360).
 *
 * Inside the fitted rate range this is the calibrated line, unchanged. Above
 * {@link SWAP_SPREAD_CALIBRATED_RATE_MAX} the credit spread holds at its
 * end-of-range value while the rate itself still passes through in full, so a
 * 1970s–80s backtest pays a plausible premium over a high risk-free rate
 * instead of a fitted line extrapolated three times past its evidence.
 */
export function getSwapSpreadDaily(smaIndex: string, borrowRateDaily: number, leverage: number = 3): number {
  const indexModels = SWAP_SPREAD_MODEL[smaIndex];
  const model = indexModels?.[Math.abs(leverage)] ?? indexModels?.[3] ?? DEFAULT_SWAP_MODEL;
  const annualBorrowRate = borrowRateDaily * 360; // back to decimal (e.g. 0.05 for 5%)
  const fittedRate = Math.min(annualBorrowRate, SWAP_SPREAD_CALIBRATED_RATE_MAX);
  const extrapolatedRate = Math.max(0, annualBorrowRate - SWAP_SPREAD_CALIBRATED_RATE_MAX);
  const annualSpread =
    model.rateSensitivity * fittedRate +
    model.baseSpread +
    SWAP_SPREAD_RATE_PASSTHROUGH_SLOPE * extrapolatedRate;
  // Floor at 0: in extremely low/negative rate environments, spread shouldn't go deeply negative
  return Math.max(annualSpread, 0) / 360;
}

/**
 * One day's return of a simulated LETF:
 *   R_LETF = L * R_index - ER_daily - (|L| - 1) * (R_borrow + swapSpread_daily)
 *
 * `costFraction` scales the carrying costs for a partial session (0.5 for the
 * overnight or intraday half of a day that switches regime at the open).
 */
export function computeSimulatedRiskOnReturn(
  indexReturn: number,
  borrowRate: number,
  smaIndex: EtfConfig["smaIndex"],
  leverage: number,
  erDaily: number,
  costFraction = 1
): number {
  const swapSpreadDaily = getSwapSpreadDaily(smaIndex, borrowRate, leverage);
  return leverage * indexReturn
    - erDaily * costFraction
    - (Math.abs(leverage) - 1) * (borrowRate + swapSpreadDaily) * costFraction;
}
