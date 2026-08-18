import type { DailyPrice } from "./storage/types";

/**
 * Replaces index-sp.csv's 1926-07-01..1988-04-05 segment with the Fama-French
 * value-weighted large-cap total return path (see scripts/build-ff-index.py).
 *
 * Why: before 1988-04-06 the S&P 500 was assembled under fixed industry-sector
 * quotas (425 industrials / 25 rails / 25 utilities / 50 financials), and
 * before 1957-03 it was not a 500-stock index at all but the backfilled
 * 90-stock Composite, which outruns the entire CRSP universe by ~0.65%/yr. The
 * Fama-French `Hi 30` cut is a purely rules-based cap-weighted alternative.
 *
 * Only the FF *returns* are used. Levels are re-anchored to the untouched
 * modern S&P row at `spliceEndExclusive`, so the seam is exactly continuous and
 * the modern series remains the source of truth. Rows before `spliceStart`
 * (the 1885-1926 Cowles-era segment) keep their own returns and are rescaled by
 * a single constant so that seam stays continuous too.
 *
 * `close` is rebuilt as `adj_close * (oldClose / oldAdjClose)`, which holds the
 * price/total-return ratio invariant - that ratio is the S&P's own cumulative
 * dividend contribution, and keeping it fixed makes this splice idempotent.
 * `open` is rescaled by the same factor as its row's `close`, preserving each
 * day's open-to-close gap.
 */
export function spliceFfLargeCapHistory(params: {
  rows: DailyPrice[];
  ffRows: Array<{ date: string; adj_close: number }>;
  spliceStart: string;
  spliceEndExclusive: string;
  name: string;
  source: string;
  /**
   * Source tag for the rescaled pre-`spliceStart` rows. Their open/close are no
   * longer the vendor's raw numbers, so the tag must say "scaled" - that is what
   * makes fetch-data serialize them at 6 significant figures instead of dumping
   * raw float noise (see isCloseFetchedDirect in scripts/fetch-data.ts).
   */
  rescaledSource?: string;
}): { rows: DailyPrice[]; replacedCount: number; rescaledCount: number } {
  const { rows, ffRows, spliceStart, spliceEndExclusive, name, source, rescaledSource } = params;

  const anchorIndex = rows.findIndex((row) => row.date >= spliceEndExclusive);
  if (anchorIndex < 0) {
    throw new Error(`ff-splice: no index-sp row at or after ${spliceEndExclusive}`);
  }
  const anchorAdjClose = rows[anchorIndex].adj_close;
  if (anchorAdjClose == null || !(anchorAdjClose > 0)) {
    throw new Error(`ff-splice: anchor row ${rows[anchorIndex].date} has no usable adj_close`);
  }

  const firstIndex = rows.findIndex((row) => row.date >= spliceStart);
  if (firstIndex < 0 || firstIndex >= anchorIndex) {
    throw new Error(`ff-splice: empty splice window ${spliceStart}..${spliceEndExclusive}`);
  }

  // Daily growth factors keyed by date, from the Fama-French level series.
  const ffGrowth = new Map<string, number>();
  for (let i = 1; i < ffRows.length; i++) {
    const prev = ffRows[i - 1].adj_close;
    const curr = ffRows[i].adj_close;
    if (!(prev > 0) || !(curr > 0)) {
      throw new Error(`ff-splice: non-positive FF level at ${ffRows[i].date}`);
    }
    ffGrowth.set(ffRows[i].date, curr / prev);
  }

  // Walk backward from the untouched anchor so the modern seam stays exact.
  const splicedAdjClose = new Map<string, number>();
  let level = anchorAdjClose;
  for (let i = anchorIndex - 1; i >= firstIndex; i--) {
    const growth = ffGrowth.get(rows[i + 1].date);
    if (growth == null) {
      throw new Error(`ff-splice: missing Fama-French return for ${rows[i + 1].date}`);
    }
    level /= growth;
    splicedAdjClose.set(rows[i].date, level);
  }

  const firstOld = rows[firstIndex].adj_close;
  const firstOldClose = rows[firstIndex].close;
  const firstNew = splicedAdjClose.get(rows[firstIndex].date);
  if (firstOld == null || firstNew == null || !(firstOld > 0)) {
    throw new Error(`ff-splice: cannot rescale pre-${spliceStart} rows`);
  }
  // Constant carry factors keep the 1926 seam continuous while preserving every
  // pre-splice daily return.
  const adjCarry = firstNew / firstOld;
  const priceCarry =
    firstOldClose != null && firstOldClose > 0
      ? (firstNew * (firstOldClose / firstOld)) / firstOldClose
      : adjCarry;

  let replacedCount = 0;
  let rescaledCount = 0;

  const out = rows.map((row, i) => {
    if (i >= anchorIndex) return row;

    if (i < firstIndex) {
      rescaledCount++;
      return {
        ...row,
        adj_close: row.adj_close == null ? row.adj_close : row.adj_close * adjCarry,
        open: row.open == null ? row.open : row.open * priceCarry,
        close: row.close == null ? row.close : row.close * priceCarry,
        source: rescaledSource ?? row.source,
      };
    }

    const adjClose = splicedAdjClose.get(row.date);
    if (adjClose == null) {
      throw new Error(`ff-splice: no spliced level for ${row.date}`);
    }
    // Hold close/adj_close fixed so the S&P's own dividend path carries over.
    const ratio = row.adj_close != null && row.adj_close > 0 && row.close != null
      ? row.close / row.adj_close
      : null;
    const close = ratio == null ? row.close : adjClose * ratio;
    const openScale = row.close != null && row.close > 0 && close != null ? close / row.close : 1;

    replacedCount++;
    return {
      ...row,
      adj_close: adjClose,
      open: row.open == null ? row.open : row.open * openScale,
      close,
      name,
      source,
    };
  });

  return { rows: out, replacedCount, rescaledCount };
}
