// The named drawdowns people actually ask about.
//
// "What would this have done in 2008?" is the first question anyone asks of a
// leveraged strategy, and answering it from a rolling-window average does not.
// Each episode is run as its own backtest rather than sliced out of a longer
// one: a windowed sub-range of a precomputed daily series has to be
// renormalized through `window-calculations.ts` to keep the entry-spread
// contract, and re-running a two-year window costs almost nothing.
//
// Dates bracket the peak-to-trough of the index, not of any leveraged product.
// They are deliberately round month boundaries — the engine snaps to the next
// trading day, and pretending to a precise peak date would be false precision.

import { getMarketDataWarmUpStartDate } from "@/lib/fetch-market-data";

export interface CrisisEpisode {
  name: string;
  startDate: string;
  endDate: string;
  description: string;
}

/** Ordered oldest-first and non-overlapping, which the tests enforce. */
export const CRISIS_EPISODES: readonly CrisisEpisode[] = [
  {
    name: "Panic of 1907",
    startDate: "1907-01-01",
    endDate: "1907-12-31",
    description: "Banking panic; the index roughly halved inside a year.",
  },
  {
    name: "1929 Crash and Depression",
    startDate: "1929-09-01",
    endDate: "1932-06-30",
    description: "The deepest drawdown in the series — around -86% peak to trough.",
  },
  {
    name: "1937 Recession",
    startDate: "1937-03-01",
    endDate: "1938-03-31",
    description: "A second leg down before the recovery from 1932 completed.",
  },
  {
    name: "1973-74 Bear Market",
    startDate: "1973-01-01",
    endDate: "1974-12-31",
    description: "Oil shock and stagflation; the case that ruins un-timed leverage.",
  },
  {
    name: "Black Monday 1987",
    startDate: "1987-08-01",
    endDate: "1987-12-31",
    description: "A single-day -20% gap, which trend rules cannot step around.",
  },
  {
    name: "Dot-com Bust",
    startDate: "2000-03-01",
    endDate: "2002-10-31",
    description: "A long grinding decline, far worse on the Nasdaq than the S&P.",
  },
  {
    name: "Global Financial Crisis",
    startDate: "2007-10-01",
    endDate: "2009-03-31",
    description: "The drawdown the real leveraged ETFs were launched into.",
  },
  {
    name: "COVID Crash",
    startDate: "2020-02-01",
    endDate: "2020-04-30",
    description: "The fastest -34% on record, and an equally fast recovery.",
  },
  {
    name: "2022 Rate Shock",
    startDate: "2022-01-01",
    endDate: "2022-10-31",
    description: "Stocks and bonds fell together, which tests the risk-off leg.",
  },
] as const;

/**
 * Episodes that fit entirely inside the available data.
 *
 * Fully, not partly: reporting the back half of 1929 as "the 1929 crash" would
 * overstate how a strategy handled it, and an index that did not exist yet has
 * nothing to say about the episode at all.
 */
export function episodesForRange(
  dataStartDate: string,
  dataEndDate: string,
): CrisisEpisode[] {
  return CRISIS_EPISODES.filter(
    (e) => e.startDate >= dataStartDate && e.endDate <= dataEndDate,
  );
}

/**
 * Where to begin loading data so the SMA is already seeded when the episode
 * opens. Without this the strategy would enter every crisis with no trend
 * state, which is precisely the information that decides whether it was in or
 * out when the drawdown began.
 */
export function warmUpStartForEpisode(episodeStart: string, smaPeriod: number): string {
  if (smaPeriod <= 0) return episodeStart;
  return getMarketDataWarmUpStartDate(episodeStart, smaPeriod);
}
