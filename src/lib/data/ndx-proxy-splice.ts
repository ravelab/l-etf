import type { DailyPrice } from "./storage/types";

/**
 * Fronts index-nq.csv with the NDX proxy (scripts/build-ndx-proxy.py): Ken
 * French's Business Equipment industry, 1926-07-01 up to the first real-NDX
 * session. It replaced the 1971-1985 Nasdaq Composite backfill, whose stale OTC
 * quotes halved its volatility and doubled its apparent trend.
 *
 * Only the proxy's returns are used. Walking backward from the untouched anchor
 * row, `adj_close` takes the proxy's total-return growth less `dailyExpense` (the
 * same per-session ETF cost charged on all pre-QQQ history), and `close` takes
 * its price growth, so the seam is exact on both columns and every row from the
 * anchor on is left as it was. The proxy has no opens: each `open` is carried
 * from the previous close, as the 1985 GIW closes are.
 *
 * Rows of `rows` before the anchor are dropped, which is what retires an old
 * backfill when this runs over an existing file.
 */
export function prependNdxProxyHistory(params: {
  rows: DailyPrice[];
  proxyRows: Array<{ date: string; adj_close: number; close: number }>;
  anchorDate: string;
  dailyExpense: number;
  name: string;
  source: string;
}): { rows: DailyPrice[]; prependedCount: number } {
  const { rows, proxyRows, anchorDate, dailyExpense, name, source } = params;

  const anchor = rows.find((row) => row.date === anchorDate);
  if (!anchor || !(anchor.adj_close! > 0) || !(anchor.close! > 0)) {
    throw new Error(`ndx-proxy: no index-nq row at ${anchorDate} with usable adj_close/close`);
  }

  const proxy = proxyRows.filter((row) => row.date <= anchorDate).sort((a, b) => a.date.localeCompare(b.date));
  if (proxy.at(-1)?.date !== anchorDate) {
    throw new Error(`ndx-proxy: no proxy session on ${anchorDate}`);
  }
  for (const row of proxy) {
    if (!(row.adj_close > 0) || !(row.close > 0)) {
      throw new Error(`ndx-proxy: non-positive proxy level on ${row.date}`);
    }
  }

  // Walk backward from the anchor: each step undoes the later session's growth.
  const levels: Array<{ adj_close: number; close: number }> = new Array(proxy.length);
  levels[proxy.length - 1] = { adj_close: anchor.adj_close!, close: anchor.close! };
  for (let i = proxy.length - 2; i >= 0; i--) {
    const trGrowth = proxy[i + 1].adj_close / proxy[i].adj_close - dailyExpense;
    const priceGrowth = proxy[i + 1].close / proxy[i].close;
    levels[i] = { adj_close: levels[i + 1].adj_close / trGrowth, close: levels[i + 1].close / priceGrowth };
  }

  const prepended: DailyPrice[] = proxy.slice(0, -1).map((row, i) => ({
    date: row.date,
    adj_close: levels[i].adj_close,
    open: i === 0 ? levels[i].close : levels[i - 1].close,
    close: levels[i].close,
    name,
    source,
  }));

  return {
    rows: [...prepended, ...rows.filter((row) => row.date >= anchorDate)],
    prependedCount: prepended.length,
  };
}
