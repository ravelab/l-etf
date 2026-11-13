/**
 * Leverage and contract-count arithmetic for the futures engine, plus the
 * front/deferred quantity split the ledger shows.
 */

import type { FuturesTransactionRow } from "./futures";
import {
  type FuturesContractSymbol,
  getContractExpiryEpochMs,
  getContractMultiplier,
  isMicroFamily,
  parseQuarterlyFutureSymbol,
  stripFuturesLedgerSuffix,
  tradeDayStamp,
} from "./futures-contracts";
import { calcCagr, calcMaxDrawdown, calcMonthlyExtremes, calcSortinoRatio } from "@/lib/simulation/metrics";
import type { EtfResult, IndexKey, SmaSignal } from "@/lib/simulation/types";

export function totalFuturesNotionalAtMark(params: {
  lots: Map<string, number>;
  contract: FuturesContractSymbol;
  mark: (sym: string) => number;
}): number {
  const mult = getContractMultiplier(params.contract);
  let n = 0;
  for (const [sym, q] of params.lots) {
    if (q <= 0) continue;
    const px = params.mark(sym);
    if (Number.isFinite(px) && px > 0) n += Math.abs(q) * mult * px;
  }
  return n;
}

export function futuresPortfolioLeverageDeltaPctFromLots(params: {
  lots: Map<string, number>;
  contract: FuturesContractSymbol | null;
  equity: number;
  targetLeverage: number;
  mark: (sym: string) => number;
}): number {
  if (
    !Number.isFinite(params.targetLeverage) ||
    params.targetLeverage <= 0 ||
    !Number.isFinite(params.equity) ||
    params.equity <= 0
  ) {
    return 0;
  }
  // Flat book (e.g. risk-off cash, or sizing pass with `contract: null` while qty is 0):
  // match {@link futuresLegLeverageDeltaPct}(qty=0) — 0 actual vs target ⇒ −100% at 1× target scale.
  if (params.contract == null) {
    return computeLeverageDeltaPct(0, params.targetLeverage);
  }
  const notional = totalFuturesNotionalAtMark({
    lots: params.lots,
    contract: params.contract,
    mark: params.mark,
  });
  return computeLeverageDeltaPct(notional / params.equity, params.targetLeverage);
}

export function clampToFinite(n: number, fallback = 0): number {
  return Number.isFinite(n) ? n : fallback;
}

export function buildEtfResult(params: {
  id: string;
  name: string;
  sourceIndex: IndexKey;
  dates: string[];
  dailyValues: number[];
  smaSignals: SmaSignal[];
  smaPrices: number[];
  totalTradingCostPct: number;
}): EtfResult {
  const { dates, dailyValues } = params;
  const initial = dailyValues[0] ?? 0;
  const finalValue = dailyValues[dailyValues.length - 1] ?? 0;
  const cagr = calcCagr(initial, finalValue, dates[0], dates[dates.length - 1]);
  const drawdown = calcMaxDrawdown(dailyValues, dates);
  const monthlyExtremes = calcMonthlyExtremes(dailyValues, dates);
  const sortinoRatio = calcSortinoRatio(dailyValues);

  return {
    id: params.id,
    name: params.name,
    sourceIndex: params.sourceIndex,
    dates,
    dailyValues,
    finalValue,
    cagr,
    sortinoRatio,
    maxDrawdownPct: drawdown.pct,
    maxDrawdownDollar: drawdown.dollar,
    maxDrawdownDates: drawdown.maxDrawdownDates,
    longestDrawdownDays: drawdown.longestDays,
    longestDrawdownDates: drawdown.longestDrawdownDates,
    bestMonth: monthlyExtremes.bestMonth,
    bestMonthDates: monthlyExtremes.bestMonthDates,
    worstMonth: monthlyExtremes.worstMonth,
    worstMonthDates: monthlyExtremes.worstMonthDates,
    smaSignals: params.smaSignals,
    smaPrices: params.smaPrices,
    totalTradingCostPct: params.totalTradingCostPct,
  };
}

export function computeLeverageDeltaPct(actualLeverage: number, targetLeverage: number): number {
  if (!Number.isFinite(actualLeverage) || !Number.isFinite(targetLeverage) || targetLeverage === 0) return 0;
  // Signed: positive when actual > target (over-leveraged after a drawdown),
  // negative when actual < target (under-leveraged after a rally).
  return ((actualLeverage / targetLeverage) - 1) * 100;
}

/** Leverage vs strategy target from cash equity and an open futures position (at a futures mark). */
export function futuresLegLeverageDeltaPct(params: {
  qty: number;
  contract: FuturesContractSymbol | null;
  futuresMarkPrice: number;
  equity: number;
  targetLeverage: number;
}): number {
  const { qty, contract, futuresMarkPrice, equity, targetLeverage } = params;
  if (!Number.isFinite(targetLeverage) || targetLeverage <= 0 || !Number.isFinite(equity) || equity <= 0) {
    return 0;
  }
  if (qty === 0 || contract == null) {
    return computeLeverageDeltaPct(0, targetLeverage);
  }
  if (!Number.isFinite(futuresMarkPrice) || futuresMarkPrice <= 0) return 0;
  const notional = Math.abs(qty) * getContractMultiplier(contract) * futuresMarkPrice;
  return computeLeverageDeltaPct(notional / equity, targetLeverage);
}

/**
 * Split open lots into **front strip** vs **deferred** for ledger display.
 *
 * - **Single** quarterly leg (same family as `index`): all qty is front, deferred is 0.
 * - **Multiple** legs: **Front** = contracts on the **earliest** expiry quarter among held
 *   listings; **Deferred** = contracts on **later** expiries (the deferred/next quarters).
 *
 * `rollDateByQuarter` is kept for a stable call signature.
 */
export function futuresFrontBackQtysFromLots(params: {
  index: IndexKey;
  tradeDate: string;
  rollDateByQuarter: Map<string, string>;
  lots: Map<string, number>;
}): { frontQty: number; backQty: number } {
  void params.rollDateByQuarter;
  const tradeDate = params.tradeDate;
  const entries: Array<{ q: number; exp: number }> = [];
  for (const [sym, q] of params.lots) {
    if (q <= 0) continue;
    const parsed = parseQuarterlyFutureSymbol(sym, tradeDate);
    if (!parsed) continue;
    const expMs = getContractExpiryEpochMs(sym, tradeDayStamp(tradeDate).year) ?? 0;
    // Full-contract equivalents: a micro is a tenth of its E-mini.
    entries.push({ q: isMicroFamily(parsed.family) ? q / 10 : q, exp: expMs });
  }
  if (entries.length === 0) return { frontQty: 0, backQty: 0 };
  if (entries.length === 1) return { frontQty: entries[0].q, backQty: 0 };
  const minExp = Math.min(...entries.map((e) => e.exp));
  let frontQty = 0;
  let backQty = 0;
  for (const e of entries) {
    if (e.exp === minExp) frontQty += e.q;
    else backQty += e.q;
  }
  return { frontQty, backQty };
}

/** Replay futures legs in ledger order; one entry per transaction (null when not a futures row). */
export function futuresFrontBackQtyAfterEachTransaction(params: {
  index: IndexKey;
  transactions: FuturesTransactionRow[];
  rollDateByQuarter: Map<string, string>;
}): Array<{ frontQty: number; backQty: number } | null> {
  const lots = new Map<string, number>();
  const out: Array<{ frontQty: number; backQty: number } | null> = [];
  for (const row of params.transactions) {
    if (row.instrument !== "futures") {
      out.push(null);
      continue;
    }
    const sym = stripFuturesLedgerSuffix(row.symbol);
    if (!/^(MES|MNQ|ES|NQ)[HMUZ]\d{2}$/i.test(sym)) {
      out.push(
        futuresFrontBackQtysFromLots({
          index: params.index,
          tradeDate: row.date,
          rollDateByQuarter: params.rollDateByQuarter,
          lots,
        })
      );
      continue;
    }
    const nextQty = (lots.get(sym) ?? 0) + row.qtyDelta;
    if (nextQty <= 0) lots.delete(sym);
    else lots.set(sym, nextQty);
    out.push(
      futuresFrontBackQtysFromLots({
        index: params.index,
        tradeDate: row.date,
        rollDateByQuarter: params.rollDateByQuarter,
        lots,
      })
    );
  }
  return out;
}

export function targetQty(params: {
  targetNotional: number;
  close: number;
  contract: FuturesContractSymbol;
}): number {
  const mult = getContractMultiplier(params.contract);
  const close = params.close;
  if (!Number.isFinite(close) || close <= 0) return 0;
  const denom = mult * close;
  if (!Number.isFinite(denom) || denom <= 0) return 0;
  const rawQty = params.targetNotional / denom;
  if (!Number.isFinite(rawQty) || rawQty <= 0) return 0;
  const floorQty = Math.floor(rawQty);
  const ceilQty = Math.ceil(rawQty);
  const floorGap = Math.abs(params.targetNotional - (floorQty * denom));
  const ceilGap = Math.abs(params.targetNotional - (ceilQty * denom));
  // Choose the integer position size that minimizes absolute leverage mismatch.
  // On ties, keep the smaller size.
  return ceilGap < floorGap ? ceilQty : floorQty;
}

export function maxQtyByMaintenance(params: {
  equity: number;
  close: number;
  contract: FuturesContractSymbol;
  maintenanceMarginRate: number;
}): number {
  const equity = Math.max(0, params.equity);
  const close = params.close;
  if (!Number.isFinite(close) || close <= 0) return 0;
  if (!Number.isFinite(params.maintenanceMarginRate) || params.maintenanceMarginRate <= 0) return Number.MAX_SAFE_INTEGER;
  const perContractMaint = getContractMultiplier(params.contract) * close * params.maintenanceMarginRate;
  if (!Number.isFinite(perContractMaint) || perContractMaint <= 0) return 0;
  return Math.floor(equity / perContractMaint);
}

export function enforceMinimumQty(params: {
  qty: number;
  targetNotional: number;
  contract: FuturesContractSymbol;
  close: number;
}): number {
  if (params.targetNotional <= 0) return params.qty;
  if (params.qty > 0) return params.qty;
  // E-minis only. If integer rounding gives 0 contracts, only floor up to 1
  // when one contract stays within ~2x the requested notional — otherwise the
  // floor would push tiny accounts to multiples of the requested leverage.
  const oneContractNotional = getContractMultiplier(params.contract) * params.close;
  if (!Number.isFinite(oneContractNotional) || oneContractNotional <= 0) return 0;
  return oneContractNotional <= 2 * params.targetNotional ? 1 : 0;
}

export function maxQtyByLeverage(params: {
  equity: number;
  close: number;
  contract: FuturesContractSymbol;
  maxLeverage: number;
}): number {
  const equity = Math.max(0, params.equity);
  const close = params.close;
  if (!Number.isFinite(equity) || equity <= 0 || !Number.isFinite(close) || close <= 0) return 0;
  if (!Number.isFinite(params.maxLeverage) || params.maxLeverage <= 0) return Number.MAX_SAFE_INTEGER;
  const denom = getContractMultiplier(params.contract) * close;
  if (!Number.isFinite(denom) || denom <= 0) return 0;
  return Math.floor((equity * params.maxLeverage) / denom);
}

export function formatLeverageLabel(leverage: number): string {
  return Number.isInteger(leverage) ? String(leverage) : leverage.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}
