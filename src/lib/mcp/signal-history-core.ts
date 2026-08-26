// Pure regime-history computation for `get_sma_signal_history`.
//
// Reuses the engine's own `generateSmaSignals` state machine rather than
// re-deriving crossings from price-vs-SMA comparisons: the band is hysteretic
// (upper governs re-entry, lower governs the exit), so a naive scan would report
// flips the strategy never took. What comes out here is exactly the trade log a
// backtest of the same band would produce — without running the backtest.

import { generateSmaSignals } from "@/lib/simulation/sma";
import type { PricePoint } from "@/lib/simulation/types";

interface SignalHistoryInput {
  /** Prices including SMA warm-up rows before `startDate`. */
  prices: PricePoint[];
  smaPeriod: number;
  smaUpperBuffer: number;
  smaLowerBuffer: number;
  startDate: string;
  endDate: string;
  includeSeries?: boolean;
  maxSeriesRows: number;
}

interface Crossover {
  date: string;
  type: "buy" | "sell";
  price: number;
  /** Trading days the previous regime lasted, counted inside the range. */
  tradingDaysHeld: number;
}

interface SignalHistory {
  startDate: string;
  endDate: string;
  tradingDays: number;
  current: { regime: "risk-on" | "risk-off"; since: string; tradingDays: number };
  stats: {
    flips: number;
    flipsPerYear: number;
    timeInMarketPct: number;
    longestRiskOnDays: number;
    longestRiskOffDays: number;
    medianDaysBetweenFlips: number | null;
  };
  crossovers: Crossover[];
  seriesSampled?: boolean;
  seriesStride?: number;
  series?: Array<{ date: string; close: number; sma: number; invested: boolean }>;
}

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

function yearsBetween(startDate: string, endDate: string): number {
  const ms = new Date(`${endDate}T00:00:00Z`).getTime() - new Date(`${startDate}T00:00:00Z`).getTime();
  return Math.max(ms, 0) / MS_PER_YEAR;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Longest run of `value` in `flags`, in array positions. */
function longestRun(flags: boolean[], value: boolean): number {
  let best = 0;
  let run = 0;
  for (const flag of flags) {
    run = flag === value ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
}

export function summarizeSignalHistory(input: SignalHistoryInput): SignalHistory {
  const { prices, smaPeriod, smaUpperBuffer, smaLowerBuffer, startDate, endDate } = input;
  const dates = prices.map((p) => p.date);
  const closes = prices.map((p) => p.close);

  const { signals, smaValues, invested } = generateSmaSignals(
    dates,
    closes,
    smaPeriod,
    { upper: smaUpperBuffer, lower: smaLowerBuffer },
  );

  // Warm-up rows shape the SMA and seed the regime, but are not part of the
  // reported range.
  const from = dates.findIndex((d) => d >= startDate);
  let to = -1;
  for (let i = dates.length - 1; i >= 0; i--) {
    if (dates[i] <= endDate) {
      to = i;
      break;
    }
  }
  if (from === -1 || to < from) {
    return {
      startDate,
      endDate,
      tradingDays: 0,
      current: { regime: "risk-on", since: startDate, tradingDays: 0 },
      stats: {
        flips: 0,
        flipsPerYear: 0,
        timeInMarketPct: 0,
        longestRiskOnDays: 0,
        longestRiskOffDays: 0,
        medianDaysBetweenFlips: null,
      },
      crossovers: [],
    };
  }

  const rangeDates = dates.slice(from, to + 1);
  const rangeInvested = invested.slice(from, to + 1);
  const indexByDate = new Map(rangeDates.map((d, i) => [d, i]));

  const inRange = signals.filter((s) => s.date >= rangeDates[0] && s.date <= rangeDates[rangeDates.length - 1]);
  const crossovers: Crossover[] = [];
  let previousIdx = 0;
  for (const signal of inRange) {
    const idx = indexByDate.get(signal.date);
    if (idx == null) continue;
    crossovers.push({
      date: signal.date,
      type: signal.type,
      price: signal.price,
      tradingDaysHeld: idx - previousIdx,
    });
    previousIdx = idx;
  }

  const lastFlipIdx = crossovers.length > 0 ? indexByDate.get(crossovers[crossovers.length - 1].date)! : 0;
  const investedDays = rangeInvested.filter(Boolean).length;
  const gaps = crossovers.slice(1).map((c) => c.tradingDaysHeld);
  const years = yearsBetween(rangeDates[0], rangeDates[rangeDates.length - 1]);

  const history: SignalHistory = {
    startDate: rangeDates[0],
    endDate: rangeDates[rangeDates.length - 1],
    tradingDays: rangeDates.length,
    current: {
      regime: rangeInvested[rangeInvested.length - 1] ? "risk-on" : "risk-off",
      since: rangeDates[lastFlipIdx],
      tradingDays: rangeDates.length - lastFlipIdx,
    },
    stats: {
      flips: crossovers.length,
      flipsPerYear: years > 0 ? crossovers.length / years : 0,
      timeInMarketPct: (investedDays / rangeDates.length) * 100,
      longestRiskOnDays: longestRun(rangeInvested, true),
      longestRiskOffDays: longestRun(rangeInvested, false),
      medianDaysBetweenFlips: median(gaps),
    },
    crossovers,
  };

  if (!input.includeSeries) return history;

  const stride = Math.max(1, Math.ceil(rangeDates.length / input.maxSeriesRows));
  const series: SignalHistory["series"] = [];
  for (let i = 0; i < rangeDates.length; i += stride) {
    series.push({
      date: rangeDates[i],
      close: closes[from + i],
      sma: smaValues[from + i],
      invested: rangeInvested[i],
    });
  }
  return { ...history, seriesSampled: stride > 1, ...(stride > 1 ? { seriesStride: stride } : {}), series };
}
