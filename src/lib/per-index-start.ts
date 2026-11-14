import {
  CONSTANT_NASDAQ100_SHORTCUT_DATE,
  CONSTANT_SP500_SHORTCUT_DATE,
} from "@/lib/constants";
import type { IndexKey } from "@/lib/simulation/types";

/**
 * "SPX/NDX start": one run in which each index starts at its own real series —
 * SPX at 1988-04-06, NDX at its 1985-01-31 launch. It is a flag on top of the
 * common Start Date, never a second pair of dates: separate per-index dates
 * silently overrode Start Date, so picking "SPX proto" still ran from 1988/1985.
 */
const PER_INDEX_START_URL_PARAM = "sdi";

export const PER_INDEX_START_DATES: Readonly<Record<IndexKey, string>> = {
  sp500: CONSTANT_SP500_SHORTCUT_DATE,
  nasdaq100: CONSTANT_NASDAQ100_SHORTCUT_DATE,
};

/** The Start Date the form shows while per-index start is on: the earlier of the two. */
export const PER_INDEX_EARLIEST_START_DATE = Object.values(PER_INDEX_START_DATES)
  .reduce((earliest, date) => (date < earliest ? date : earliest));

export function resolveIndexStartDates(
  startDate: string,
  perIndexStart: boolean,
): Record<IndexKey, string> {
  return perIndexStart
    ? { ...PER_INDEX_START_DATES }
    : { sp500: startDate, nasdaq100: startDate };
}

/**
 * The URL's per-index-start choice. `undefined` when the URL names no start at
 * all; a URL that carries `sd` without `sdi=1` asks for a common start.
 */
export function readPerIndexStartUrlParam(params: URLSearchParams): boolean | undefined {
  if (params.get(PER_INDEX_START_URL_PARAM) === "1") return true;
  return params.has("sd") ? false : undefined;
}

export function appendPerIndexStartUrlParam(params: URLSearchParams, perIndexStart: boolean): void {
  if (perIndexStart) params.set(PER_INDEX_START_URL_PARAM, "1");
  else params.delete(PER_INDEX_START_URL_PARAM);
}

/** The start every tool page opens with: "SPX/NDX start". */
export const DEFAULT_START_SELECTION = {
  startDate: PER_INDEX_EARLIEST_START_DATE,
  perIndexStart: true,
} as const;
