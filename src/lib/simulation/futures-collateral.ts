import { getSymbolSpread } from "@/lib/constants";

/** Standalone-account approximation of ~/futures/src/treasury/sleeve.ts.
 * No fixed cash reserve; the securities pool is invested near close.
 * No core equities or box loans. Prices must be total-return adjusted; reference
 * share prices keep the 200-share band meaningful across synthetic history.
 */
const TREASURY_TICKERS = ["SGOV", "VGSH"] as const;
export type TreasuryHoldings = Record<"SGOV" | "VGSH", number>;
type Ticker = keyof TreasuryHoldings;
export function isTreasuryTicker(ticker: string): ticker is Ticker {
  return ticker === "SGOV" || ticker === "VGSH";
}

/** Existing SGOV/VGSH jointly satisfy Treasury targets. Only cash funds
 * remaining deficits after surplus collateral is sold for non-Treasury targets. */
export function planRiskOffPurchases(targets: Record<string, number>, treasuryValue: number, availableCash: number) {
  const treasuryTarget = Object.entries(targets).reduce((sum, [t, v]) => sum + (isTreasuryTicker(t) ? v : 0), 0);
  const treasuryScale = treasuryTarget > 0 ? Math.max(0, treasuryTarget - treasuryValue) / treasuryTarget : 0;
  const deficits = Object.fromEntries(Object.entries(targets).map(([t, v]) => [t, v * (isTreasuryTicker(t) ? treasuryScale : 1)]));
  const total = Object.values(deficits).reduce((sum, v) => sum + v, 0);
  const funding = total > 0 ? Math.min(1, Math.max(0, availableCash) / total) : 0;
  return Object.fromEntries(Object.entries(deficits).map(([t,v]) => [t,v * funding]));
}
export type CollateralTrade = { symbol: Ticker; quantity: number; quantityAfter: number; price: number; fees: number; spread: number };
export function createFuturesCollateral(params: {
  close: Record<string, number[]>;
  open: Record<string, number[]>;
  dollarScale: (date: string) => number;
  minTradeShares?: number;
}) {
  const holdings: Record<Ticker, number> = { SGOV: 0, VGSH: 0 };
  const quotes: Record<Ticker, number> = { SGOV: 100, VGSH: 58 };
  const marks: Record<Ticker, number> = { SGOV: 0, VGSH: 0 };
  // Use fixed share-price anchors, not a future series endpoint. Adjusted prices
  // represent reinvested distributions; these are equivalent units, not tax lots.
  const first: Record<Ticker, number> = { SGOV: params.close.SGOV?.[0], VGSH: params.close.VGSH?.[0] };
  for (const ticker of TREASURY_TICKERS) {
    if (!(first[ticker] > 0)) throw new Error(`Missing ${ticker} collateral prices at simulation start`);
  }
  const minShares = params.minTradeShares ?? 200;
  const value = () => TREASURY_TICKERS.reduce((sum, t) => sum + holdings[t], 0);
  function price(t: Ticker, i: number, date: string, atOpen: boolean) {
    const raw = (atOpen ? params.open[t]?.[i] : params.close[t]?.[i]);
    const fallback = params.close[t]?.[Math.max(0, i - (atOpen ? 1 : 0))];
    const px = Number.isFinite(raw) && raw > 0 ? raw : fallback;
    if (!(px > 0)) throw new Error(`Missing ${t} collateral price on ${date}`);
    return px;
  }
  function mark(i: number, date: string, atOpen: boolean) {
    const before = value();
    for (const t of TREASURY_TICKERS) {
      const next = price(t, i, date, atOpen);
      if (marks[t] > 0) holdings[t] *= next / marks[t];
      marks[t] = next;
      // Historical synthetic total-return prices are not executable share prices.
      // Use fixed present-dollar share equivalents for order bands/commissions.
      quotes[t] = (t === "SGOV" ? 100 : 58) * params.dollarScale(date);
    }
    return value() - before;
  }
  function trade(t: Ticker, qty: number, date: string): CollateralTrade {
    const fees = Math.max(1, Math.abs(qty) * 0.005) * params.dollarScale(date);
    const spread = Math.abs(qty) * quotes[t] * getSymbolSpread(t, false);
    holdings[t] = Math.max(0, holdings[t] + qty * quotes[t]);
    return { symbol: t, quantity: qty, quantityAfter: holdings[t] / quotes[t], price: quotes[t], fees, spread };
  }
  function liquidate(date: string) {
    return TREASURY_TICKERS.filter(t => holdings[t] > 0).map(t => trade(t, -holdings[t] / quotes[t], date));
  }
  /** Regime changes fund non-Treasury targets fully. Retain only the portion
   * needed by the Treasury risk-off target; do not swap SGOV for VGSH. This is
   * not routine maintenance, so its 200-share no-trade band does not block exits.
   */
  function fundRiskOff(treasuryTarget: number, date: string): CollateralTrade[] {
    let surplus = Math.max(0, value() - treasuryTarget);
    const trades: CollateralTrade[] = [];
    for (const t of TREASURY_TICKERS) {
      const sold = Math.min(holdings[t], surplus);
      if (sold > 1e-8) {
        trades.push(trade(t, -sold / quotes[t], date));
        surplus -= sold;
      }
    }
    return trades;
  }
  function buy(t: Ticker, budget: number, date: string): CollateralTrade[] {
    const feeScale = params.dollarScale(date);
    // Match the bot's 0.1% quote-to-fill buffer for cash-constrained orders.
    const qty = Math.max(0, Math.floor((budget - feeScale) / (quotes[t] * 1.001 + 0.005 * feeScale)));
    return qty >= minShares ? [trade(t, qty, date)] : [];
  }
  function rebalance(equity: number, marginRequirement: number, date: string): CollateralTrade[] {
    // 25% ETF haircut is a transparent conservative approximation, not an IB
    // what-if quote. Preserve the bot's 15% excess-liquidity floor at this mark.
    const target = Math.max(0, Math.min(equity, (equity * 0.85 - marginRequirement) / 0.25));
    let gap = target - value();
    const trades: CollateralTrade[] = [];
    if (gap < 0) {
      for (const t of TREASURY_TICKERS) {
        const shares = holdings[t] / quotes[t];
        const wanted = Math.min(shares, Math.ceil(-gap / quotes[t]));
        const qty = shares - wanted < minShares ? shares : wanted;
        if (qty > 0 && (qty >= minShares || qty === shares)) {
          const tx = trade(t, -qty, date);
          trades.push(tx);
          gap += qty * quotes[t] - tx.fees - tx.spread;
        }
        if (gap >= 0) break;
      }
    } else {
      for (const t of TREASURY_TICKERS) {
        const px = quotes[t];
        if (gap >= minShares * px) {
          trades.push(...buy(t, gap, date));
          break; // The live bot does not try a second ticker after choosing one.
        }
      }
    }
    return trades;
  }
  return { mark, value, liquidate, rebalance, buy, fundRiskOff,
    readHoldings: (): TreasuryHoldings => ({ ...holdings }),
    writeHoldings: (next: TreasuryHoldings) => {
      for (const t of TREASURY_TICKERS) holdings[t] = next[t];
    },
  };
}

/** IBKR Pro USD residual securities cash only; ETF holdings are excluded. NAV scales the eligible rate below $100k. Debit balances pay
 * benchmark + 1.5% (first-tier approximation; no box financing).
 */
export function collateralCashInterest(params: {
  equity: number; treasuryValue: number;
  rateDaily: number; dollarScale: number; days: number;
}) {
  const cash = params.equity - params.treasuryValue;
  if (cash < 0) return cash * (Math.max(0, params.rateDaily) + 0.015 / 360) * params.days;
  const eligible = Math.max(0, cash - 10_000 * params.dollarScale);
  const navFactor = Math.min(1, Math.max(0, params.equity / (100_000 * params.dollarScale)));
  return eligible * Math.max(0, params.rateDaily - 0.005 / 360) * navFactor * params.days;
}
