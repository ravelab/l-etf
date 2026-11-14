// The sleeve's transaction ledger: every row is stamped with the positions held
// once it executed, so a row's `holdingsAfter` is always the full book.

import type { CollateralTrade } from "./futures-collateral";
import { familyOfSymbol, getContractMultiplier } from "./futures-contracts";
import type { SleeveContext } from "./futures-sleeve-context";
import type { SleeveState } from "./futures-sleeve-state";
import type { FuturesTransactionRow } from "./futures-types";

/**
 * Dollar value of every position held at this instant, for the ledger's Assets
 * column: futures notional by listing, risk-off shares at their last price, and
 * Treasury collateral at its marked value. Cash is not a position.
 */
export function currentSleevePositions(ctx: SleeveContext, st: SleeveState): Record<string, number> {
  const { sizingFamily, collateral, heldTickers } = ctx;
  const out: Record<string, number> = {};
  for (const [sym, q] of st.lots) {
    const mark = st.ledgerFuturesMark?.(sym) ?? Number.NaN;
    if (q > 0 && familyOfSymbol(sym) && mark > 0) {
      out[sym] = q * getContractMultiplier(sizingFamily) * mark;
    }
  }
  for (const [j, shares] of (st.riskOffShares ?? []).entries()) {
    const t = heldTickers[j];
    const px = st.riskOffLastPrice?.[j] ?? Number.NaN;
    if (shares > 0 && t && px > 0) out[t] = (out[t] ?? 0) + shares * px;
  }
  for (const [t, value] of Object.entries(collateral?.readHoldings() ?? {})) {
    if (value > 0) out[t] = (out[t] ?? 0) + value;
  }
  return out;
}

/** Appends a ledger row stamped with the positions held once it has executed. */
export function recordSleeveTransaction(
  ctx: SleeveContext,
  st: SleeveState,
  row: FuturesTransactionRow,
): void {
  const { microMode, unitsPerFull, unitsPerContract } = ctx;
  if (st.cashMember && row.instrument === "futures") {
    st.cashMember.commoditiesCash -= row.fees + row.spread;
  }
  // The engine counts in sizing units; the ledger shows whole contracts of each
  // listing and the position after as full-contract equivalents.
  const contractsRow = microMode && row.instrument === "futures"
    ? { ...row, qtyDelta: row.qtyDelta / unitsPerContract(row.symbol), qtyAfter: row.qtyAfter / unitsPerFull }
    : row;
  st.transactions.push({ ...contractsRow, holdingsAfter: currentSleevePositions(ctx, st) });
}

/** Books Treasury collateral trades: their costs leave cash, and each gets a ledger row. */
export function bookSleeveCollateralTrades(
  ctx: SleeveContext,
  st: SleeveState,
  trades: CollateralTrade[],
  date: string,
): void {
  for (const tx of trades) {
    st.cash -= tx.fees + tx.spread;
    st.totalFees += tx.fees;
    st.totalSpreadCosts += tx.spread;
    recordSleeveTransaction(ctx, st, { date, action: tx.quantity > 0 ? "buy" : "sell", instrument: "riskoff",
      symbol: `${tx.symbol} (COLLATERAL)`, qtyDelta: tx.quantity, qtyAfter: tx.quantityAfter,
      fillPrice: tx.price, fees: tx.fees, spread: tx.spread, cashInterestEarned: 0,
      excessLiquidity: st.cash - st.collateralMarginRequirement, leverageDeltaPct: 0, equity: st.cash });
  }
}
