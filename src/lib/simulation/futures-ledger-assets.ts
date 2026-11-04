import { riskOffTickerAbbrev } from "@/lib/constants";
import { futuresContractExpiryEpochMs, futuresListingMultiplier } from "@/lib/simulation/futures";

/** Dollar value per symbol, as stamped on a futures ledger row's `holdingsAfter`. */
export type LedgerHoldings = Readonly<Record<string, number>>;

/** One entry of the Assets cell: what is held after the row, and what the row traded (+ bought). */
export type LedgerAsset = { label: string; value: number; trade: number };

/** Float residue from in-kind sleeve splits, not a position. */
const MIN_POSITION = 1e-6;
/** Under a dollar is rounding residue of a closed position, not a holding worth listing. */
const MIN_DISPLAYED_VALUE = 1;
const FUTURES_LISTING = /^(ES|NQ)[HMUZ]\d{2}$/;

/** `a + b` as a new map, without the positions that net to nothing. */
export function addHoldings(a: LedgerHoldings, b: LedgerHoldings): Record<string, number> {
  const out: Record<string, number> = {};
  for (const symbol of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const qty = (a[symbol] ?? 0) + (b[symbol] ?? 0);
    if (Math.abs(qty) > MIN_POSITION) out[symbol] = qty;
  }
  return out;
}

function negate(holdings: LedgerHoldings): Record<string, number> {
  return Object.fromEntries(Object.entries(holdings).map(([symbol, qty]) => [symbol, -qty]));
}

/** Sum of several holdings maps (or deltas). */
export function sumHoldings(items: ReadonlyArray<LedgerHoldings>): Record<string, number> {
  return items.reduce<Record<string, number>>((acc, item) => addHoldings(acc, item), {});
}

/**
 * Each row's change in holdings against the row before it, in ledger (execution)
 * order. Null when any row lacks `holdingsAfter`, i.e. a ledger built before the
 * engine stamped it.
 */
export function ledgerHoldingsDeltas(
  rows: ReadonlyArray<{ holdingsAfter?: LedgerHoldings }>
): Array<Record<string, number>> | null {
  if (rows.some((row) => row.holdingsAfter == null)) return null;
  let previous: LedgerHoldings = {};
  return rows.map((row) => {
    const after = row.holdingsAfter as LedgerHoldings;
    const delta = addHoldings(after, negate(previous));
    previous = after;
    return delta;
  });
}

/**
 * Holdings after each row when the deltas are applied in the order given.
 *
 * The table reorders a day's rows (sells before buys, liquidations last) and merges
 * legs, so a row's own stamp can disagree with the row shown above it. Summing the
 * deltas in display order keeps neighbouring rows consistent, and because rows only
 * move within their own date, the last row of every day still lands exactly on the
 * engine's end-of-day holdings.
 */
export function runningHoldings(
  deltas: ReadonlyArray<LedgerHoldings>
): Array<Record<string, number>> {
  let running: Record<string, number> = {};
  return deltas.map((delta) => {
    running = addHoldings(running, delta);
    return running;
  });
}

/**
 * Signed dollars a ledger row traded, per symbol (a buy is positive): futures
 * notional (`qtyDelta` × multiplier × `fillPrice`) or risk-off / Treasury dollars
 * (`qtyDelta` × `fillPrice`). A row that closes several tickers at once carries
 * them in `legValues` instead.
 */
export function ledgerTradeValues(row: {
  symbol: string;
  qtyDelta: number;
  fillPrice: number;
  legValues?: LedgerHoldings;
}): Record<string, number> {
  if (row.legValues) return addHoldings(row.legValues, {});
  const symbol = row.symbol.replace(/\s*\((?:COLLATERAL|LIQUIDATE|ROLL)\)\s*$/i, "").trim();
  const multiplier = FUTURES_LISTING.test(symbol) ? (futuresListingMultiplier(symbol) ?? Number.NaN) : 1;
  const value = row.qtyDelta * multiplier * row.fillPrice;
  return Number.isFinite(value) && value !== 0 ? { [symbol]: value } : {};
}

/**
 * Every symbol held after the row or traded by it, so a position the row closed
 * still shows its sale (value 0).
 */
function lineEntries(
  holdings: LedgerHoldings,
  trades: LedgerHoldings,
  include: (symbol: string) => boolean,
  label: (symbol: string) => string
): LedgerAsset[] {
  return [...new Set([...Object.keys(holdings), ...Object.keys(trades)])]
    .filter(include)
    .map((symbol) => ({ label: label(symbol), value: holdings[symbol] ?? 0, trade: trades[symbol] ?? 0 }))
    .filter((entry) => Math.abs(entry.value) >= MIN_DISPLAYED_VALUE || Math.abs(entry.trade) >= MIN_DISPLAYED_VALUE);
}

function futuresOrder(tradeDate: string) {
  return (a: LedgerAsset, b: LedgerAsset): number => {
    const byRoot = a.label.slice(0, 2).localeCompare(b.label.slice(0, 2));
    if (byRoot !== 0) return byRoot;
    const expiryA = futuresContractExpiryEpochMs(a.label, tradeDate) ?? 0;
    const expiryB = futuresContractExpiryEpochMs(b.label, tradeDate) ?? 0;
    return expiryA - expiryB;
  };
}

/**
 * The Assets cell's two lines: futures notional by listing (ES before NQ, nearest
 * expiry first), then risk-off and Treasury holdings under their one-letter labels,
 * each with what this row traded in it (`trades`, signed dollars).
 */
export function ledgerAssetLines(
  holdings: LedgerHoldings,
  tradeDate: string,
  trades: LedgerHoldings = {}
): { futures: LedgerAsset[]; securities: LedgerAsset[] } {
  const isFutures = (symbol: string) => FUTURES_LISTING.test(symbol);
  const futures = lineEntries(holdings, trades, isFutures, (symbol) => symbol).sort(futuresOrder(tradeDate));
  const securities = lineEntries(holdings, trades, (symbol) => !isFutures(symbol), riskOffTickerAbbrev)
    .sort((a, b) => a.label.localeCompare(b.label));
  return { futures, securities };
}
