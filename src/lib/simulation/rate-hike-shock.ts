// Rate-hike shock: a risk-off gate on the short funding rate (`data/rate-borrow.csv`),
// offered as an extra strategy (`sma-rate-shock.ts`), not part of the default gates.
//
// Out once the 21-day mean of the published rate is up more than 2 points on 63
// trading days earlier; back once that 63-day change is below zero. A day sees only
// the rate published before it: the previous session's for daily series (fed funds,
// LIBOR, SOFR), and for monthly commercial paper (before 1954-07) the last finished
// month's average.
//
// Tested 2026-11-19 on the default bands, vol gates and RSI brake: it has fired 13
// times since 1885 and not since 1982 (2022 peaked near 1.75 points a quarter), so it
// changes nothing after 1985 and improves every earlier era (SPX 1926-88 +0.9, SPX
// 1885-1926 +0.8, NDX proxy 1926-85 +3.5 points of real CAGR) without short
// risk-offs. Every setting that DOES fire after 1985 lost money there, so treat it
// as insurance, like the RSI brake, not as a source of return.
//
// The episodes are computed from the CSV by `fetch-data` into
// `tool-snapshots/rate-hike-shock.json`, because a signal rule sees only index closes.

import shipped from "@/lib/tool-snapshots/rate-hike-shock.json";

export interface RateHikeShockParams {
  smoothingDays: number;
  windowDays: number;
  /** Percentage points. */
  exitAbovePct: number;
  /** Percentage points. */
  reenterBelowPct: number;
}

export const RATE_HIKE_SHOCK: RateHikeShockParams = {
  smoothingDays: 21,
  windowDays: 63,
  exitAbovePct: 2,
  reenterBelowPct: 0,
};

/** Rows before this date are monthly commercial-paper averages (see borrow-rate-history.ts). */
const MONTHLY_RATE_END_DATE = "1954-07-01";

export interface RateHikeShockEpisode {
  /** First session held risk-off. */
  start: string;
  /** First session released, or null while the episode is still open. */
  end: string | null;
}

export interface RateHikeShockModule {
  params: RateHikeShockParams;
  /** Last rate row the episodes were computed through. */
  dataEndDate: string;
  episodes: RateHikeShockEpisode[];
}

/** The rate (percent) each row's session could have known. */
function publishedRates(rows: ReadonlyArray<{ date: string; value: number }>): number[] {
  const known = new Array<number>(rows.length).fill(Number.NaN);
  let lastBeforeMonth = Number.NaN;
  let month = "";
  for (let i = 0; i < rows.length; i++) {
    const rowMonth = rows[i].date.slice(0, 7);
    if (rowMonth !== month) {
      month = rowMonth;
      lastBeforeMonth = i > 0 ? rows[i - 1].value * 100 : Number.NaN;
    }
    known[i] = rows[i].date < MONTHLY_RATE_END_DATE
      ? lastBeforeMonth
      : i > 0 ? rows[i - 1].value * 100 : Number.NaN;
  }
  return known;
}

/** Mean of the finite values in the trailing window; NaN until one exists. */
function trailingMean(values: number[], window: number): number[] {
  return values.map((_, i) => {
    let sum = 0;
    let n = 0;
    for (let k = Math.max(0, i - window + 1); k <= i; k++) {
      if (Number.isFinite(values[k])) {
        sum += values[k];
        n++;
      }
    }
    return n > 0 ? sum / n : Number.NaN;
  });
}

/** Episodes over rate rows (`value` as a decimal, one row per session, date-sorted). */
export function computeRateHikeShockEpisodes(
  rows: ReadonlyArray<{ date: string; value: number }>,
  params: RateHikeShockParams = RATE_HIKE_SHOCK
): { episodes: RateHikeShockEpisode[] } {
  const smoothed = trailingMean(publishedRates(rows), params.smoothingDays);
  const episodes: RateHikeShockEpisode[] = [];
  let open: string | null = null;
  for (let i = params.windowDays; i < rows.length; i++) {
    const change = smoothed[i] - smoothed[i - params.windowDays];
    if (!Number.isFinite(change)) continue;
    if (open === null && change > params.exitAbovePct) open = rows[i].date;
    else if (open !== null && change < params.reenterBelowPct) {
      episodes.push({ start: open, end: rows[i].date });
      open = null;
    }
  }
  if (open !== null) episodes.push({ start: open, end: null });
  return { episodes };
}

const SHIPPED = shipped as RateHikeShockModule;

/** Whether each date falls inside an episode (start inclusive, end exclusive). */
export function rateHikeShockRiskOff(dates: readonly string[], module: RateHikeShockModule = SHIPPED): boolean[] {
  return dates.map((date) =>
    module.episodes.some((e) => date >= e.start && (e.end === null || date < e.end))
  );
}
