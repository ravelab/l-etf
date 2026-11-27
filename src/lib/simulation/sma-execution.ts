import type { EtfConfig, SmaSignal } from "./types";
import { generateSmaSignals } from "./sma";
import { smaRiskOffGates } from "./risk-off-gates";
import { getSignalRule, runSignalRule } from "./signal-rules";

export type SmaExecutionMode = NonNullable<EtfConfig["smaExecutionMode"]>;

/** Seed for the SMA state machine, used by the History Wrap tail resimulation. */
export interface SmaSeed {
  /** Invested state at `seedAtIndex` (defaults to the rule's own start, risk-on). */
  smaInitialInvested?: boolean;
  /** Index at which `smaInitialInvested` becomes authoritative (defaults to 0). */
  smaSeedAtIndex?: number;
}

/**
 * The regime a timed config actually holds, after the execution delay.
 * `investedForReturn[i]` is the regime that earns day i's return;
 * `transitionOnDay[i]` marks the days a switch trades.
 * Both are null for a config without SMA timing (always risk-on).
 */
export interface SmaExecution {
  investedForReturn: boolean[] | null;
  transitionOnDay: boolean[] | null;
  smaSignals: SmaSignal[];
  smaPrices: number[];
  /** Signal regime on day 0 (undefined without SMA timing). */
  smaStartInvested?: boolean;
  /** Signal regime on the last day (undefined without SMA timing). */
  smaEndInvested?: boolean;
}

/** Fresh arrays per result: callers own their result's signal and SMA arrays. */
function untimedExecution(): SmaExecution {
  return { investedForReturn: null, transitionOnDay: null, smaSignals: [], smaPrices: [] };
}

function buildTransitionFlagsDelayed(invested: boolean[], delay: number): boolean[] {
  const flags = new Array<boolean>(invested.length).fill(false);
  for (let i = 1; i < invested.length; i++) {
    if (invested[i] !== invested[i - 1]) {
      // Mark transition 'delay' days after the signal
      const transitionDay = i + delay;
      if (transitionDay < invested.length) {
        flags[transitionDay] = true;
      }
    }
  }
  return flags;
}

function buildTransitionFlags(invested: boolean[]): boolean[] {
  const flags = new Array<boolean>(invested.length).fill(false);
  for (let i = 1; i < invested.length; i++) {
    flags[i] = invested[i] !== invested[i - 1];
  }
  return flags;
}

/** Signal on day i (from its close) → held from day i+1: `held[i] = signal[i-1]`. */
function shiftInvestedByOneDay(invested: boolean[]): boolean[] {
  if (invested.length <= 1) return invested;
  const shifted = new Array<boolean>(invested.length);
  shifted[0] = invested[0];
  for (let i = 1; i < invested.length; i++) {
    shifted[i] = invested[i - 1];
  }
  return shifted;
}

/** Signal on day i-2 → exit at day i-1 close → out on day i: `held[i] = signal[i-2]`. */
function shiftInvestedByTwoDays(invested: boolean[]): boolean[] {
  if (invested.length <= 1) return invested;
  const shifted = new Array<boolean>(invested.length);
  shifted[0] = invested[0];
  shifted[1] = invested[0];
  for (let i = 2; i < invested.length; i++) {
    shifted[i] = invested[i - 2];
  }
  return shifted;
}

function runConfiguredSignalRule(
  config: EtfConfig,
  dates: string[],
  closePrices: number[],
  seed: SmaSeed
): { invested: boolean[]; signals: SmaSignal[]; smaValues: number[] } {
  if (config.signalRule) {
    return runSignalRule(getSignalRule(config.signalRule), dates, closePrices, config);
  }
  return generateSmaSignals(
    dates,
    closePrices,
    config.smaPeriod,
    { upper: config.smaUpperBuffer, lower: config.smaLowerBuffer },
    {
      ...(seed.smaInitialInvested !== undefined
        ? { initialInvested: seed.smaInitialInvested, seedAtIndex: seed.smaSeedAtIndex }
        : {}),
      ...(config.smaVolGate === true ? smaRiskOffGates(config.smaIndex, config.smaHigherTurnover) : {}),
      ...(config.smaInflationAdjusted === true ? { inflationAdjusted: true } : {}),
    }
  );
}

/**
 * Run the config's timing rule over `closePrices` and shift its regime by the
 * execution delay:
 * - `next-day-open` (default): signal on day 10's close → switch at day 11's
 *   open, so day 11's close already reflects the new regime.
 * - `next-day-close`: switch at day 11's close (day 10 and 11 returns both kept).
 * - `trigger-day-close`: switch at day 10's own close (day 10's return kept).
 */
export function resolveSmaExecution(
  config: EtfConfig,
  dates: string[],
  closePrices: number[],
  executionMode: SmaExecutionMode,
  seed: SmaSeed = {}
): SmaExecution {
  if (!config.smaEnabled) return untimedExecution();

  const missingCloseIdx = closePrices.findIndex((price) => !isFinite(price));
  if (missingCloseIdx !== -1) {
    throw new Error(`Missing close price for ${config.smaIndex} on ${dates[missingCloseIdx]}`);
  }
  const smaResult = runConfiguredSignalRule(config, dates, closePrices, seed);
  const signalInvested = smaResult.invested;
  const base = {
    smaSignals: smaResult.signals,
    smaPrices: smaResult.smaValues,
    smaStartInvested: signalInvested[0] ?? true,
    smaEndInvested: signalInvested[signalInvested.length - 1] ?? true,
  };

  if (executionMode === "next-day-close") {
    return {
      ...base,
      investedForReturn: shiftInvestedByTwoDays(signalInvested),
      transitionOnDay: buildTransitionFlagsDelayed(signalInvested, 2),
    };
  }
  if (executionMode === "next-day-open") {
    // Held regime matches trigger-day-close; only the trade lands a day later.
    return {
      ...base,
      investedForReturn: shiftInvestedByOneDay(signalInvested),
      transitionOnDay: buildTransitionFlagsDelayed(signalInvested, 1),
    };
  }
  return {
    ...base,
    investedForReturn: shiftInvestedByOneDay(signalInvested),
    transitionOnDay: buildTransitionFlags(signalInvested),
  };
}
