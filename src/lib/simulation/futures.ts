import type { PricePoint, RatePoint, IndexKey, EtfResult, RiskOffAsset, SmaSignal } from "@/lib/simulation/types";
import { buildRateLookup } from "@/lib/simulation/borrowing-rate";
import { generateSmaSignals } from "@/lib/simulation/sma";
import { riskOffCloseMarkPrice, riskOffOpenTradePrice } from "@/lib/simulation/risk-off";
import { formatRiskOffLiquidationAbbrev, getSymbolSpread, getRiskOffFetchTickers } from "@/lib/constants";
import { DEFAULT_LEVERAGE_TOLERANCE_PCT } from "@/lib/simulation/defaults";
import {
  calcCagr,
  calcMaxDrawdown,
  calcMonthlyExtremes,
  calcSharpeRatio,
} from "@/lib/simulation/metrics";

type FuturesContractSymbol = "ES" | "NQ";

type FuturesMonthCode = "H" | "M" | "U" | "Z"; // Mar/Jun/Sep/Dec

export type FuturesTransactionRow = {
  date: string;
  action: "buy" | "sell";
  instrument: "futures" | "riskoff";
  symbol: string;
  qtyDelta: number;
  qtyAfter: number;
  fillPrice: number;
  fees: number;
  spread: number;
  cashInterestEarned: number;
  /** Days of positive sweep accrual since last attribution: trading-session EOD hits plus calendar gap days (weekends/holidays). */
  cashInterestTradingDays?: number;
  /** Net annualized sweep rate at attribution date, percent (e.g. 4.2). */
  cashInterestAnnualRatePct?: number;
  excessLiquidity: number;
  /** Leverage vs target (%) immediately before this futures leg executes. */
  leverageDeltaPctBefore?: number;
  leverageDeltaPct: number;
  equity: number;
  /** Synthetic closing row at window end (not an additional trade in PnL). */
  isEndLiquidation?: boolean;
};

export type FuturesStrategyResult = {
  etfResult: EtfResult;
  targetLeverage: number;
  index: IndexKey;
  transactions: FuturesTransactionRow[];
  initialEquity: number;
  /** Mean end-of-day futures notional / equity on days in risk-on with an open position. */
  avgActualLeverageRiskOn: number;
  /** Max |actual/target − 1| in percent points at end of day while risk-on with futures, before emergency margin peels. */
  maxAbsLeverageDeltaRiskOnPct: number;
  /** Days in the window (`invested === false` after SMA shift). */
  riskOffSessionDayCount: number;
  sessionDayCount: number;
};

const DEFAULT_CASH_INTEREST_SPREAD_ANNUAL = 0.005; // 0.50%/yr haircut vs SOFR-like series
const DEFAULT_CASH_INTEREST_FREE_CASH = 10_000;
const DIVIDEND_EMA_LOOKBACK_DAYS = 63;
const MAX_ABS_DIVIDEND_DAILY = 0.05 / 252; // clamp inferred q to +/-5% annualized

// Coarse, stable approximation for margin. We use a fraction of notional to produce
// a meaningful "Excess Liquidity" series without pretending to be an exact broker.
const DEFAULT_MAINT_MARGIN_RATE = 0.08; // 8% of notional

// Conservative all-in per-contract, per-side fee approximation (commission + exchange/reg).
const DEFAULT_FEE_PER_CONTRACT = 1.25;
const DEFAULT_RISKOFF_COMMISSION_PER_SHARE = 0.005;
const DEFAULT_RISKOFF_MIN_COMMISSION = 1.0;
const DEFAULT_RISKOFF_MAX_COMMISSION_PCT_NOTIONAL = 0.01;

/** Net annual cash-sweep yield (percent points) implied by daily borrow minus broker spread (/360). */
function sweepNetAnnualPctFromRateDaily(rateDaily: number, spreadAnnual: number): number {
  return Math.max(0, rateDaily - spreadAnnual / 360) * 360 * 100;
}

/** Whole calendar days from ISO date a to b (b − a). E.g. Fri → Mon = 3. */
function calendarDaysBetweenIso(isoA: string, isoB: string): number {
  const t = (s: string) =>
    Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  return Math.round((t(isoB) - t(isoA)) / 86_400_000);
}

function addCalendarDaysIso(date: string, days: number): string {
  const d = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))));
  d.setUTCDate(d.getUTCDate() + days);
  return iso(d);
}

function getContractMultiplier(contract: FuturesContractSymbol): number {
  switch (contract) {
    case "ES":
      return 50;
    case "NQ":
      return 20;
  }
}

function thirdFriday(year: number, month1to12: number): Date {
  // month1to12: 1=Jan .. 12=Dec
  const first = new Date(Date.UTC(year, month1to12 - 1, 1));
  const firstDow = first.getUTCDay(); // 0=Sun..5=Fri
  const friday = 5;
  const daysToFirstFriday = (friday - firstDow + 7) % 7;
  const firstFridayDate = 1 + daysToFirstFriday;
  const thirdFridayDate = firstFridayDate + 14;
  return new Date(Date.UTC(year, month1to12 - 1, thirdFridayDate));
}

function monthCodeFromQuarterMonth(month: 3 | 6 | 9 | 12): FuturesMonthCode {
  switch (month) {
    case 3:
      return "H";
    case 6:
      return "M";
    case 9:
      return "U";
    case 12:
      return "Z";
  }
}

function quarterMonthFromMonthCode(code: FuturesMonthCode): 3 | 6 | 9 | 12 {
  switch (code) {
    case "H":
      return 3;
    case "M":
      return 6;
    case "U":
      return 9;
    case "Z":
      return 12;
  }
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function resolveTwoDigitYear(yy: number, tradeDate: string): number {
  const tradeYear = Number(tradeDate.slice(0, 4));
  let year = Math.floor(tradeYear / 100) * 100 + yy;
  if (year < tradeYear - 50) year += 100;
  if (year > tradeYear + 50) year -= 100;
  return year;
}

function getContractExpiryDate(symbol: string, tradeDate: string): Date | null {
  const match = symbol.match(/^(?:ES|NQ)([HMUZ])(\d{2})/);
  if (!match) return null;
  const month = quarterMonthFromMonthCode(match[1] as FuturesMonthCode);
  const year = resolveTwoDigitYear(Number(match[2]), tradeDate);
  return thirdFriday(year, month);
}

function daysToContractExpiry(symbol: string, tradeDate: string): number {
  const expiry = getContractExpiryDate(symbol, tradeDate);
  if (!expiry) return 0;
  const trade = new Date(`${tradeDate}T00:00:00Z`);
  const days = (expiry.getTime() - trade.getTime()) / (24 * 60 * 60 * 1000);
  return Number.isFinite(days) ? Math.max(0, days) : 0;
}

function futuresBasisFillPrice(params: {
  spotPrice: number;
  symbol: string;
  tradeDate: string;
  rateDaily: number;
  dividendDaily: number;
}): number {
  const spot = params.spotPrice;
  if (!Number.isFinite(spot) || spot <= 0) return spot;
  const days = daysToContractExpiry(params.symbol, params.tradeDate);
  if (days <= 0) return spot;
  const rateAnnual = Number.isFinite(params.rateDaily) ? params.rateDaily * 360 : 0;
  const dividendAnnual = Number.isFinite(params.dividendDaily) ? params.dividendDaily * 252 : 0;
  const basisFactor = 1 + ((rateAnnual - dividendAnnual) * days / 365.25);
  return Number.isFinite(basisFactor) && basisFactor > 0 ? spot * basisFactor : spot;
}

/**
 * Financing charged to an open futures position between two index rows, as a
 * fraction of the prior close.
 *
 * Rate accrues per calendar day (so weekends/holidays cost the same as the cash
 * sweep credits them), but the dividend is the *realized* payout across that
 * same span, taken straight from the total-return series — one row already
 * covers the whole gap, so it must not be re-scaled by `calendarDays`.
 *
 * Using the realized dividend rather than a smoothed estimate is what makes a
 * held position earn exactly `indexTotalReturn − rate × days`: price return plus
 * the dividend it gives up equals the total return by construction. That keeps
 * the futures path on the same index the LETF engine compounds (`adj_close`)
 * instead of on the raw `close` column, which for spliced history is a
 * different series and disagrees with it by up to 3% on some days.
 */
export function futuresCarryForHoldingPeriod(params: {
  rateDaily: number;
  /** Dividend paid over the whole holding period, as a fraction of the prior close. */
  dividendForPeriod: number;
  calendarDays: number;
}): number {
  const days = Math.max(0, params.calendarDays);
  if (days <= 0) return 0;
  const rateAnnual = Number.isFinite(params.rateDaily) ? params.rateDaily * 360 : 0;
  const dividend = Number.isFinite(params.dividendForPeriod) ? params.dividendForPeriod : 0;
  const carry = ((rateAnnual * days) / 365.25) - dividend;
  return Number.isFinite(carry) ? carry : 0;
}

export function buildRollDateMap(dates: string[], daysBeforeExpiry = 4): Map<string, string> {
  // key: `${year}-${quarterMonth}` (quarterMonth in 3,6,9,12), value: roll date (YYYY-MM-DD)
  const dateSet = new Set(dates);
  if (dates.length === 0) return new Map();
  const startYear = Number(dates[0].slice(0, 4));
  const endYear = Number(dates[dates.length - 1].slice(0, 4));
  const map = new Map<string, string>();
  for (let y = startYear; y <= endYear; y++) {
    for (const m of [3, 6, 9, 12] as const) {
      const expiry = thirdFriday(y, m);
      const rollTarget = new Date(expiry.getTime() - daysBeforeExpiry * 24 * 60 * 60 * 1000);
      let snap = iso(rollTarget);
      if (!dateSet.has(snap)) {
        let found: string | null = null;
        for (let back = 1; back <= 10; back++) {
          const d = new Date(rollTarget.getTime() - back * 24 * 60 * 60 * 1000);
          const candidate = iso(d);
          if (dateSet.has(candidate)) {
            found = candidate;
            break;
          }
        }
        if (found) snap = found;
      }
      if (dateSet.has(snap)) map.set(`${y}-${m}`, snap);
    }
  }
  return map;
}

function frontContractLabelForDate(
  family: FuturesContractSymbol,
  date: string,
  rollDateByQuarter: Map<string, string>
): string {
  const d = new Date(`${date}T00:00:00Z`);
  let year = d.getUTCFullYear();
  let qMonth: 3 | 6 | 9 | 12 = 3;
  const month = d.getUTCMonth() + 1;
  if (month <= 3) qMonth = 3;
  else if (month <= 6) qMonth = 6;
  else if (month <= 9) qMonth = 9;
  else qMonth = 12;

  const rollDate = rollDateByQuarter.get(`${year}-${qMonth}`);
  if (rollDate && date >= rollDate) {
    if (qMonth === 12) {
      qMonth = 3;
      year += 1;
    } else {
      qMonth = (qMonth + 3) as 6 | 9 | 12;
    }
  }
  const code = monthCodeFromQuarterMonth(qMonth);
  const yy = String(year).slice(-2);
  return `${family}${code}${yy}`;
}

function parseQuarterlyFutureSymbol(
  symbol: string,
  anchorTradeDate: string
): {
  family: FuturesContractSymbol;
  expiryYear: number;
  quarterMonth: 3 | 6 | 9 | 12;
} | null {
  const match = symbol.match(/^(ES|NQ)([HMUZ])(\d{2})$/);
  if (!match) return null;
  const family = match[1] as FuturesContractSymbol;
  const year2 = Number(match[3]);
  const monthCode = match[2] as FuturesMonthCode;
  const expiryYear = resolveTwoDigitYear(year2, anchorTradeDate);
  const quarterMonth = quarterMonthFromMonthCode(monthCode);
  return { family, expiryYear, quarterMonth };
}

function advanceQuarterlySymbol(symbol: string, anchorTradeDate: string): string {
  const p = parseQuarterlyFutureSymbol(symbol, anchorTradeDate);
  if (!p) return symbol;
  const { quarterMonth, family } = p;
  let { expiryYear } = p;
  let nextQ: 3 | 6 | 9 | 12;
  if (quarterMonth === 12) {
    nextQ = 3;
    expiryYear += 1;
  } else {
    nextQ = (quarterMonth + 3) as 6 | 9 | 12;
  }
  const code = monthCodeFromQuarterMonth(nextQ);
  const yy = String(expiryYear).slice(-2);
  return `${family}${code}${yy}`;
}

/**
 * Same roll snap as `buildRollDateMap` for one contract's expiry (3rd Friday of its listing quarter).
 */
function rollSnapForSymbol(
  symbol: string,
  anchorTradeDate: string,
  dates: string[],
  daysBeforeExpiry: number
): string | null {
  const expiry = getContractExpiryDate(symbol, anchorTradeDate);
  if (!expiry) return null;
  const dateSet = new Set(dates);
  const rollTarget = new Date(expiry.getTime() - daysBeforeExpiry * 24 * 60 * 60 * 1000);
  let snap = iso(rollTarget);
  if (!dateSet.has(snap)) {
    let found: string | null = null;
    for (let back = 1; back <= 10; back++) {
      const d = new Date(rollTarget.getTime() - back * 24 * 60 * 60 * 1000);
      const candidate = iso(d);
      if (dateSet.has(candidate)) {
        found = candidate;
        break;
      }
    }
    if (found) snap = found;
  }
  return dateSet.has(snap) ? snap : null;
}

function rollSnapForSymbolFromMap(
  symbol: string,
  anchorTradeDate: string,
  rollDateByQuarter: Map<string, string>
): string | null {
  const parsed = parseQuarterlyFutureSymbol(symbol, anchorTradeDate);
  if (!parsed) return null;
  return rollDateByQuarter.get(`${parsed.expiryYear}-${parsed.quarterMonth}`) ?? null;
}

/** In the contract's expiry **calendar month** (and year), new trades use the **next** quarter's symbol. */
function newTradesContractLabel(
  family: FuturesContractSymbol,
  date: string,
  rollDateByQuarter: Map<string, string>
): string {
  const base = frontContractLabelForDate(family, date, rollDateByQuarter);
  const p = parseQuarterlyFutureSymbol(base, date);
  if (!p) return base;
  const d = new Date(`${date}T00:00:00Z`);
  if (d.getUTCFullYear() === p.expiryYear && d.getUTCMonth() + 1 === p.quarterMonth) {
    return advanceQuarterlySymbol(base, date);
  }
  return base;
}

function sumLots(lots: Map<string, number>): number {
  let s = 0;
  for (const q of lots.values()) s += q;
  return s;
}

function reconcileLots(lots: Map<string, number>): void {
  for (const [k, v] of [...lots.entries()]) {
    if (v <= 0) lots.delete(k);
  }
}

/**
 * Sell nearer-expiry (calendar front) legs first when shrinking so reductions peel the
 * contracts that would otherwise need rolling soonest, avoiding redundant roll fees on
 * inventory you are exiting anyway.
 */
function contractSymbolsSortedForReduction(lots: Map<string, number>, anchorDate: string): string[] {
  return [...lots.entries()]
    .filter(([, q]) => q > 0)
    .sort((a, b) => {
      const expA = getContractExpiryDate(a[0], anchorDate)?.getTime() ?? 0;
      const expB = getContractExpiryDate(b[0], anchorDate)?.getTime() ?? 0;
      return expA - expB;
    })
    .map(([sym]) => sym);
}

function totalFuturesNotionalAtMark(params: {
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

function futuresPortfolioLeverageDeltaPctFromLots(params: {
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

function clampToFinite(n: number, fallback = 0): number {
  return Number.isFinite(n) ? n : fallback;
}

function buildEtfResult(params: {
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
  const sharpeRatio = calcSharpeRatio(dailyValues);

  return {
    id: params.id,
    name: params.name,
    sourceIndex: params.sourceIndex,
    dates,
    dailyValues,
    finalValue,
    cagr,
    sharpeRatio,
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

function computeLeverageDeltaPct(actualLeverage: number, targetLeverage: number): number {
  if (!Number.isFinite(actualLeverage) || !Number.isFinite(targetLeverage) || targetLeverage === 0) return 0;
  // Signed: positive when actual > target (over-leveraged after a drawdown),
  // negative when actual < target (under-leveraged after a rally).
  return ((actualLeverage / targetLeverage) - 1) * 100;
}

/** Leverage vs strategy target from cash equity and an open futures position (at a futures mark). */
function futuresLegLeverageDeltaPct(params: {
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

export function getFuturesHalfSpreadPerContract(symbol: string): number {
  if (symbol.startsWith("ES")) return 6.25;
  if (symbol.startsWith("NQ")) return 2.5;
  return 0;
}

function getTransactionSpreadCost(params: {
  instrument: "futures" | "riskoff";
  symbol: string;
  qtyDelta: number;
  fillPrice: number;
  dollarScale?: number;
}): number {
  if (params.instrument === "futures") {
    const dollarScale = Number.isFinite(params.dollarScale) && (params.dollarScale ?? 0) > 0
      ? (params.dollarScale as number)
      : 1;
    return Math.abs(params.qtyDelta) * getFuturesHalfSpreadPerContract(params.symbol) * dollarScale;
  }
  const spreadFrac = getSymbolSpread(params.symbol, false);
  const notional = Math.abs(params.qtyDelta) * params.fillPrice;
  return notional * spreadFrac;
}

function getRiskOffCommission(params: {
  qtyDelta: number;
  fillPrice: number;
  dollarScale?: number;
}): number {
  const shares = Math.abs(params.qtyDelta);
  const notional = shares * params.fillPrice;
  if (!Number.isFinite(shares) || shares <= 0 || !Number.isFinite(notional) || notional <= 0) return 0;
  const dollarScale = Number.isFinite(params.dollarScale) && (params.dollarScale ?? 0) > 0
    ? (params.dollarScale as number)
    : 1;
  const variable = shares * DEFAULT_RISKOFF_COMMISSION_PER_SHARE * dollarScale;
  const capped = Math.min(variable, notional * DEFAULT_RISKOFF_MAX_COMMISSION_PCT_NOTIONAL);
  return Math.max(DEFAULT_RISKOFF_MIN_COMMISSION * dollarScale, capped);
}

export function buildInflationDollarCostScaleLookup(
  monthlyCpi: Array<{ date: string; value: number }> | undefined,
  anchorDate: string
): (date: string) => number {
  const rows = (monthlyCpi ?? [])
    .filter((row) => Number.isFinite(row.value) && row.value > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (rows.length < 2) return () => 1;

  let anchorCpi = NaN;
  for (const row of rows) {
    if (row.date <= anchorDate) anchorCpi = row.value;
    else break;
  }
  if (!Number.isFinite(anchorCpi) || anchorCpi <= 0) anchorCpi = rows[rows.length - 1]!.value;

  const cpiAtOrBefore = (date: string) => {
    let lo = 0;
    let hi = rows.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (rows[mid]!.date <= date) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return rows[Math.max(0, found)]!.value;
  };

  return (date: string) => {
    const cpi = cpiAtOrBefore(date);
    const scale = cpi / anchorCpi;
    return Number.isFinite(scale) && scale > 0 ? scale : 1;
  };
}

function chooseContract(index: IndexKey): FuturesContractSymbol {
  return index === "sp500" ? "ES" : "NQ";
}

function stripFuturesLedgerSuffix(symbol: string): string {
  return symbol.replace(/\s*\((?:ROLL|LIQUIDATE)\)\s*$/i, "").trim();
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
    const expMs = getContractExpiryDate(sym, tradeDate)?.getTime() ?? 0;
    entries.push({ q, exp: expMs });
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
    if (!/^(ES|NQ)[HMUZ]\d{2}$/i.test(sym)) {
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

function targetQty(params: {
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

function maxQtyByMaintenance(params: {
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

function enforceMinimumQty(params: {
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

function maxQtyByLeverage(params: {
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

function formatLeverageLabel(leverage: number): string {
  return Number.isInteger(leverage) ? String(leverage) : leverage.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

/** Default: roll when within this many calendar days of the quarterly 3rd-Friday expiry. */
export const DEFAULT_FUTURES_ROLL_CALENDAR_DAYS_BEFORE_EXPIRY = 4;

/**
 * Trading day in `dates` for a quarterly leg's roll: latest session on or before
 * `(3rd Friday of that contract's expiry month) − daysBeforeExpiry` calendar days
 * (same rule as {@link buildRollDateMap} and {@link simulateFuturesSmaStrategy} `(ROLL)` legs).
 */
export function getQuarterlyFuturesRollTradingDay(
  symbol: string,
  anchorTradeDate: string,
  dates: string[],
  daysBeforeExpiry: number = DEFAULT_FUTURES_ROLL_CALENDAR_DAYS_BEFORE_EXPIRY
): string | null {
  return rollSnapForSymbol(
    symbol,
    anchorTradeDate,
    dates,
    Math.max(1, Math.round(daysBeforeExpiry))
  );
}

export type FuturesStrategyParams = {
  index: IndexKey;
  prices: PricePoint[];
  /**
   * Optional alternative price series for SMA signal generation. When provided,
   * SMA signals are derived from this series instead of `prices`. The trading
   * series (`prices`) is unaffected. Used for cross-index signals, e.g. trading
   * NDX futures with an SPX SMA gate.
   */
  signalPrices?: PricePoint[];
  rates: RatePoint[];
  startDate: string;
  endDate: string;
  initialEquity: number;
  targetLeverage: number;
  maxLeverage?: number;
  displayName?: string;
  smaPeriod: number;
  smaUpperBuffer: number;
  smaLowerBuffer: number;
  riskOffAsset: RiskOffAsset;
  riskOffCloseByTicker?: Record<string, number[]>;
  riskOffOpenByTicker?: Record<string, number[]>;
  cashInterestSpreadAnnual?: number;
  cashInterestFreeCash?: number;
  maintenanceMarginRate?: number;
  /**
   * Quarterly ES/NQ: roll and **front-month symbol** both use the same snap: the latest trading day
   * in the series on or before `(3rd Friday of expiry month) − N` calendar days (`buildRollDateMap`).
   * Must be ≥ 1.
   * @default {@link DEFAULT_FUTURES_ROLL_CALENDAR_DAYS_BEFORE_EXPIRY}
   */
  rollCalendarDaysBeforeExpiry?: number;
  /**
   * Skip rebalance trades while |leverageDeltaPct| stays within ±this %.
   * Initial open, contract switches, risk-off transitions, and maintenance-cap
   * breaches still trade unconditionally.
   *
   * When `maxLeverage` is finite, the open max-leverage peel uses the same band:
   * trimming for leverage only starts if open notional/equity exceeds
   * `maxLeverage * (1 + this/100)`; sell sizing still targets ≤ `maxLeverage`.
   * That reduces buy/sell churn when target and cap are equal or close.
   */
  leverageTolerancePct?: number;
  feePerContract?: number;
  /** CPI series used to scale fixed-dollar commissions into historical dollars. */
  monthlyCpi?: Array<{ date: string; value: number }>;
  /**
   * Reference price for scaling fees/spreads. When not provided, uses the latest price
   * in the supplied series. For historical backtests, you typically want to pass today's
   * price (or latest available) to keep fees consistent across different backtest periods.
   * @default latest price in params.prices
   */
  futuresPriceAnchor?: number;
};

export function simulateFuturesSmaStrategy(params: FuturesStrategyParams): FuturesStrategyResult {
  const sliced = params.prices.filter((p) => p.date >= params.startDate && p.date <= params.endDate);
  if (sliced.length < 2) {
    const leverageLabel = formatLeverageLabel(params.targetLeverage);
    const empty: EtfResult = buildEtfResult({
      id: `${params.targetLeverage}x-${params.index}-futures-sma`,
      name: params.displayName ?? `${leverageLabel}x ${params.index === "sp500" ? "SPX" : "NDQ"} SMA`,
      sourceIndex: params.index,
      dates: [],
      dailyValues: [],
      smaSignals: [],
      smaPrices: [],
      totalTradingCostPct: 0,
    });
    return {
      etfResult: empty,
      targetLeverage: params.targetLeverage,
      index: params.index,
      transactions: [],
      initialEquity: clampToFinite(params.initialEquity, 0),
      avgActualLeverageRiskOn: NaN,
      maxAbsLeverageDeltaRiskOnPct: NaN,
      riskOffSessionDayCount: 0,
      sessionDayCount: 0,
    };
  }

  const dates = sliced.map((p) => p.date);
  const closes = sliced.map((p) => p.close);
  const adjCloses = sliced.map((p) => p.adj_close);
  const smaInput = closes.map((v, i) => (Number.isFinite(v) ? v : (adjCloses[i] ?? v)));
  /** Index level for next-day-open futures fills (raw `open`; matches raw `close` scale). */
  const indexOpenPx = sliced.map((p, i) => {
    if (p.open != null && Number.isFinite(p.open) && p.open > 0) return p.open;
    return smaInput[i] as number;
  });

  // Run SMA over the FULL price series (including pre-startDate warm-up rows) so the
  // regime at startDate reflects the trailing trend. Slicing first would lose warm-up
  // data and force `generateSmaSignals` into its progressive-average bootstrap, which
  // defaults to risk-on regardless of the actual SMA position at startDate.
  const signalPrices = params.signalPrices ?? params.prices;
  const fullDates = signalPrices.map((p) => p.date);
  const fullClose = signalPrices.map((p) => p.close);
  const fullAdjClose = signalPrices.map((p) => p.adj_close);
  const fullSmaInput = fullClose.map((v, i) =>
    Number.isFinite(v) ? v : (fullAdjClose[i] ?? v)
  ) as number[];
  const fullSma = generateSmaSignals(
    fullDates,
    fullSmaInput,
    params.smaPeriod,
    { upper: params.smaUpperBuffer, lower: params.smaLowerBuffer }
  );
  const fullInvestedByDate = new Map<string, boolean>();
  for (let i = 0; i < fullDates.length; i++) {
    fullInvestedByDate.set(fullDates[i], fullSma.invested[i] ?? true);
  }
  const slicedInvested = dates.map((d) => fullInvestedByDate.get(d) ?? true);
  const slicedSmaValues = (() => {
    const fullSmaByDate = new Map<string, number>();
    for (let i = 0; i < fullDates.length; i++) {
      fullSmaByDate.set(fullDates[i], fullSma.smaValues[i] ?? Number.NaN);
    }
    return dates.map((d) => fullSmaByDate.get(d) ?? Number.NaN);
  })();
  const slicedSignals = fullSma.signals.filter(
    (s) => s.date >= params.startDate && s.date <= params.endDate
  );
  const sma = {
    signals: slicedSignals,
    smaValues: slicedSmaValues,
    invested: slicedInvested,
  };
  // Futures sim executes SMA regime trades on the *next session open*.
  // `generateSmaSignals` flips `invested` on the trigger day's close, so we must shift
  // by one day to avoid entering/exiting risk-off one day early vs the ETF SMA engine.
  const invested = (() => {
    const signalInvested = sma.invested;
    if (signalInvested.length <= 1) return signalInvested;
    const shifted = new Array<boolean>(signalInvested.length);
    // Seed the day-0 regime from the *previous* full-series row so warm-up state
    // carries forward to startDate (matches the next-session-open shift below).
    const firstSlicedDate = dates[0];
    const firstFullIdx = fullDates.indexOf(firstSlicedDate);
    const priorInvested =
      firstFullIdx > 0 ? fullSma.invested[firstFullIdx - 1] : signalInvested[0];
    shifted[0] = priorInvested ?? signalInvested[0] ?? true;
    for (let i = 1; i < signalInvested.length; i++) shifted[i] = signalInvested[i - 1] ?? shifted[i - 1] ?? true;
    return shifted;
  })();

  const rateLookup = buildRateLookup(params.rates);
  const spreadAnnual = params.cashInterestSpreadAnnual ?? DEFAULT_CASH_INTEREST_SPREAD_ANNUAL;
  const freeCash = params.cashInterestFreeCash ?? DEFAULT_CASH_INTEREST_FREE_CASH;
  const maintMarginRate = params.maintenanceMarginRate ?? DEFAULT_MAINT_MARGIN_RATE;
  const maxLeverage = params.maxLeverage ?? Number.POSITIVE_INFINITY;
  const leverageTolerancePct = Math.max(
    0,
    params.leverageTolerancePct ?? DEFAULT_LEVERAGE_TOLERANCE_PCT
  );
  const feeDollarScaleForDate = buildInflationDollarCostScaleLookup(params.monthlyCpi, params.endDate);
  // The un-swept cash buffer is a present-day broker threshold, so it lives in the
  // same dollars as the commission schedule and gets deflated the same way. Leaving
  // it nominal would wipe out most of the interest base in early history (a $10k
  // buffer against a 1962 account is a different animal than against a 2026 one).
  const freeCashAt = (date: string) => freeCash * feeDollarScaleForDate(date);
  // Futures fees and bid/ask spreads scale with the contract's fill price so they
  // represent a constant fraction of notional. Anchor to a reference price (typically
  // today's market price or latest available) so that historical backtests have consistent
  // fees regardless of the simulation date range. If not provided, falls back to the latest
  // price in the series, but for long historical backtests, explicitly provide the anchor.
  const futuresPriceAnchor = (() => {
    if (Number.isFinite(params.futuresPriceAnchor) && (params.futuresPriceAnchor as number) > 0) {
      return params.futuresPriceAnchor as number;
    }
    for (let i = params.prices.length - 1; i >= 0; i--) {
      const c = params.prices[i]?.close;
      if (Number.isFinite(c) && (c as number) > 0) return c as number;
    }
    return NaN;
  })();
  const futuresPriceScale = (fillPrice: number): number => {
    if (!Number.isFinite(futuresPriceAnchor) || futuresPriceAnchor <= 0) return 1;
    if (!Number.isFinite(fillPrice) || fillPrice <= 0) return 1;
    return fillPrice / futuresPriceAnchor;
  };
  const feePerContractAt = (fillPrice: number) =>
    (params.feePerContract ?? DEFAULT_FEE_PER_CONTRACT) * futuresPriceScale(fillPrice);

  let sumActualLeverageRiskOn = 0;
  let riskOnLeverageDayCount = 0;
  let maxAbsLeverageDeltaRiskOnPct = 0;

  const dailyEquity = new Array<number>(dates.length);
  const transactions: FuturesTransactionRow[] = [];

  let cash = clampToFinite(params.initialEquity, 0);
  const lots = new Map<string, number>();
  let contract: FuturesContractSymbol | null = null;
  let accruedInterestSinceLastTx = 0;
  /** Count of credited sweep-interest days since last attribution row. */
  let interestSweepSessionCount = 0;
  let pendingMonthlyCashInterest = 0;
  let pendingMonthlyCashInterestDays = 0;
  let totalFees = 0;
  let totalSpreadCosts = 0;

  const riskOffTickers = getRiskOffFetchTickers(params.riskOffAsset);
  let riskOffShares: number[] | null = null;
  let riskOffCash: number[] | null = null;
  let riskOffLastPrice: number[] | null = null;
  let pendingEnterRiskOff = false;
  let pendingExitRiskOff = false;
  const rollCalendarDaysBeforeExpiry = Math.max(
    1,
    Math.round(params.rollCalendarDaysBeforeExpiry ?? DEFAULT_FUTURES_ROLL_CALENDAR_DAYS_BEFORE_EXPIRY)
  );
  const rollDateByQuarter = buildRollDateMap(dates, rollCalendarDaysBeforeExpiry);
  const accrueCashInterest = (amount: number, days: number) => {
    if (!Number.isFinite(amount) || amount <= 0 || days <= 0) return;
    pendingMonthlyCashInterest += amount;
    pendingMonthlyCashInterestDays += days;
  };
  const creditPendingCashInterest = () => {
    if (!Number.isFinite(pendingMonthlyCashInterest) || pendingMonthlyCashInterest <= 0) return 0;
    const amount = pendingMonthlyCashInterest;
    cash += amount;
    accruedInterestSinceLastTx += amount;
    interestSweepSessionCount += Math.max(1, pendingMonthlyCashInterestDays);
    pendingMonthlyCashInterest = 0;
    pendingMonthlyCashInterestDays = 0;
    return amount;
  };

  const capQtyForPostTradeMaintenance = (params: {
    desiredQty: number;
    currentQty: number;
    cashBefore: number;
    riskOffValueAtClose: number;
    contract: FuturesContractSymbol;
    symbol: string;
    fillPrice: number;
    tradeDate: string;
  }): number => {
    const nextQty = Math.max(0, Math.floor(params.desiredQty));
    // Only upsizing can worsen maintenance headroom.
    if (nextQty <= params.currentQty) return nextQty;
    const mult = getContractMultiplier(params.contract);
    const perContractMaint = mult * params.fillPrice * maintMarginRate;
    const perContractEntryCost =
      feePerContractAt(params.fillPrice) +
      getFuturesHalfSpreadPerContract(params.symbol) * futuresPriceScale(params.fillPrice);
    const denom = perContractMaint + perContractEntryCost;
    if (!Number.isFinite(denom) || denom <= 0) return params.currentQty;
    // Solve projectedExcess(q) >= 0 in closed form:
    // projectedExcess(q) = cash+riskOff+currentQty*entryCost - q*(maint+entryCost)
    const numerator = params.cashBefore + params.riskOffValueAtClose + (params.currentQty * perContractEntryCost);
    const maxSafeQty = Math.floor(numerator / denom);
    if (!Number.isFinite(maxSafeQty)) return params.currentQty;
    if (maxSafeQty < params.currentQty) return params.currentQty;
    return Math.min(nextQty, Math.max(params.currentQty, maxSafeQty));
  };
  const divAlpha = 2 / (DIVIDEND_EMA_LOOKBACK_DAYS + 1);
  let dividendEmaDaily = 0;

  dailyEquity[0] = cash;
  const firstDate = dates[0];
  const firstSpot = smaInput[0];
  // Day 0 establishes the starting position rather than executing a signal, so it
  // fills at the first close — the same bar `dailyEquity[0]` marks, and the same
  // convention `simulateSingleEtf` uses for its own day-0 value. Filling at the
  // open instead would size off one price and mark at another, silently dropping
  // (risk-on) or keeping (risk-off) that day's intraday move depending on regime.
  const startsRiskOn = Boolean(invested[0]);
  if (startsRiskOn && Number.isFinite(firstSpot) && firstSpot > 0) {
    const initialTargetNotional = Math.max(0, params.targetLeverage * cash);
    const initialContract = chooseContract(params.index);
    const initialSymbol = newTradesContractLabel(initialContract, firstDate, rollDateByQuarter);
    const initialFillPrice = futuresBasisFillPrice({
      spotPrice: firstSpot,
      symbol: initialSymbol,
      tradeDate: firstDate,
      rateDaily: rateLookup.getRate(firstDate),
      dividendDaily: 0,
    });
    const rawInitialQty = targetQty({
      targetNotional: initialTargetNotional,
      close: initialFillPrice,
      contract: initialContract,
    });
    const initialQtyUncapped = enforceMinimumQty({
      qty: rawInitialQty,
      targetNotional: initialTargetNotional,
      contract: initialContract,
      close: initialFillPrice,
    });
    const initialMaxByMaintenance = maxQtyByMaintenance({
      equity: cash,
      close: initialFillPrice,
      contract: initialContract,
      maintenanceMarginRate: maintMarginRate,
    });
    const initialMaxByLeverage = maxQtyByLeverage({
      equity: cash,
      close: initialFillPrice,
      contract: initialContract,
      maxLeverage,
    });
    const initialQty = capQtyForPostTradeMaintenance({
      desiredQty: Math.min(initialQtyUncapped, initialMaxByMaintenance, initialMaxByLeverage),
      currentQty: 0,
      cashBefore: cash,
      riskOffValueAtClose: 0,
      contract: initialContract,
      symbol: initialSymbol,
      fillPrice: initialFillPrice,
      tradeDate: firstDate,
    });
    if (initialQty > 0) {
      const fees = Math.abs(initialQty) * feePerContractAt(initialFillPrice);
      const spread = getTransactionSpreadCost({
        instrument: "futures",
        symbol: initialSymbol,
        qtyDelta: initialQty,
        fillPrice: initialFillPrice,
        dollarScale: futuresPriceScale(initialFillPrice),
      });
      const levBefore = futuresLegLeverageDeltaPct({
        qty: 0,
        contract: null,
        futuresMarkPrice: initialFillPrice,
        equity: cash,
        targetLeverage: params.targetLeverage,
      });
      cash -= (fees + spread);
      totalFees += fees;
      totalSpreadCosts += spread;
      lots.set(initialSymbol, initialQty);
      contract = initialContract;
      const notional = Math.abs(initialQty) * getContractMultiplier(initialContract) * initialFillPrice;
      const maintenanceMarginUsed = notional * maintMarginRate;
      const equity = cash;
      const excessLiquidity = equity - maintenanceMarginUsed;
      const actualLeverage = equity > 0 ? notional / equity : 0;
      const leverageDeltaPct = computeLeverageDeltaPct(actualLeverage, params.targetLeverage);
      transactions.push({
        date: firstDate,
        action: "buy",
        instrument: "futures",
        symbol: initialSymbol,
        qtyDelta: initialQty,
        qtyAfter: initialQty,
        fillPrice: initialFillPrice,
        fees,
        spread,
        cashInterestEarned: 0,
        excessLiquidity,
        leverageDeltaPctBefore: levBefore,
        leverageDeltaPct,
        equity,
      });
      if (invested[0] && equity > 0) {
        const lev = notional / equity;
        if (Number.isFinite(lev)) {
          sumActualLeverageRiskOn += lev;
          riskOnLeverageDayCount += 1;
        }
        maxAbsLeverageDeltaRiskOnPct = Math.max(maxAbsLeverageDeltaRiskOnPct, Math.abs(leverageDeltaPct));
      }
    }
    dailyEquity[0] = cash;
  } else if (riskOffTickers.length > 0) {
    // Starts in risk-off: establish the basket at the first close (see above), so
    // day 0 books it at cost and the curve starts flat exactly like the LETF engine.
    const investable = cash;
    const valuePer = investable / riskOffTickers.length;
    riskOffShares = new Array(riskOffTickers.length).fill(0);
    riskOffCash = new Array(riskOffTickers.length).fill(0);
    riskOffLastPrice = new Array(riskOffTickers.length).fill(NaN);
    let day0RiskOffBookAtEntry = 0;
    for (let j = 0; j < riskOffTickers.length; j++) {
      const t = riskOffTickers[j];
      const closeArr = params.riskOffCloseByTicker?.[t];
      const openPx = riskOffCloseMarkPrice({ closeValues: closeArr, index: 0 });
      if (Number.isFinite(openPx) && (openPx as number) > 0) {
        const grossShares = valuePer / (openPx as number);
        const spread = getTransactionSpreadCost({
          instrument: "riskoff",
          symbol: t,
          qtyDelta: grossShares,
          fillPrice: openPx as number,
        });
        const fees = getRiskOffCommission({
          qtyDelta: grossShares,
          fillPrice: openPx as number,
          dollarScale: feeDollarScaleForDate(firstDate),
        });
        const netValue = Math.max(0, valuePer - spread - fees);
        const shares = netValue / (openPx as number);
        riskOffShares[j] = shares;
        riskOffLastPrice[j] = openPx as number;
        totalFees += fees;
        totalSpreadCosts += spread;
        day0RiskOffBookAtEntry += shares * (openPx as number);
        transactions.push({
          date: firstDate,
          action: "buy",
          instrument: "riskoff",
          symbol: t,
          qtyDelta: shares,
          qtyAfter: shares,
          fillPrice: openPx as number,
          fees,
          spread,
          cashInterestEarned: 0,
          excessLiquidity: 0,
          leverageDeltaPct: 0,
          equity: day0RiskOffBookAtEntry,
        });
      } else {
        riskOffCash[j] = valuePer;
      }
    }
    cash = 0;

    // Mark at the first close (the entry bar): books the basket at cost.
    let day0Equity = 0;
    for (let j = 0; j < riskOffTickers.length; j++) {
      const t = riskOffTickers[j];
      const shares = riskOffShares?.[j] ?? 0;
      const closeArr = params.riskOffCloseByTicker?.[t];
      const closePx = riskOffCloseMarkPrice({ closeValues: closeArr, index: 0, lastPrice: riskOffLastPrice?.[j] });
      if (shares > 0 && Number.isFinite(closePx) && (closePx as number) > 0) {
        day0Equity += shares * (closePx as number);
        if (riskOffLastPrice) riskOffLastPrice[j] = closePx as number;
      } else if (shares > 0) {
        const last = riskOffLastPrice?.[j];
        const fallbackPrice =
          Number.isFinite(last ?? NaN) && (last as number) > 0 ? (last as number) : 0;
        day0Equity += fallbackPrice > 0 ? shares * fallbackPrice : 0;
      }
      const cashPiece = riskOffCash?.[j] ?? 0;
      if (Number.isFinite(cashPiece) && cashPiece > 0) day0Equity += cashPiece;
    }
    dailyEquity[0] = day0Equity > 0 ? day0Equity : 0;
  }

  for (let i = 1; i < dates.length; i++) {
    const date = dates[i];
    const prevSpot = smaInput[i - 1];
    const spot = smaInput[i];
    const idxOpen =
      Number.isFinite(indexOpenPx[i]) && indexOpenPx[i] > 0 ? indexOpenPx[i] : spot;
    if (!Number.isFinite(prevSpot) || !Number.isFinite(spot) || prevSpot <= 0 || spot <= 0) {
      // If data is bad, carry forward equity without changing positions.
      dailyEquity[i] = clampToFinite(dailyEquity[i - 1], cash);
      continue;
    }

    // Sweep interest on non-trading calendar days (Sat/Sun/holidays) between index rows: same daily rate × gap,
    // balance frozen at prior session close (before today's overnight futures cash). Uses prior session SOFR.
    const dividendDailyPriorClose = Math.max(
      -MAX_ABS_DIVIDEND_DAILY,
      Math.min(MAX_ABS_DIVIDEND_DAILY, dividendEmaDaily)
    );
    const gapCalendarDays = calendarDaysBetweenIso(dates[i - 1] as string, dates[i] as string);
    const extraSweepDays = Math.max(0, gapCalendarDays - 1);
    if (extraSweepDays > 0) {
      const ratePrev = rateLookup.getRate(dates[i - 1] as string);
      const spreadDailyGap = spreadAnnual / 360;
      const cashRateGap = Math.max(0, ratePrev - spreadDailyGap);
      const markGapPrevClose = (sym: string) =>
        futuresBasisFillPrice({
          spotPrice: prevSpot,
          symbol: sym,
          tradeDate: dates[i - 1] as string,
          rateDaily: ratePrev,
          dividendDaily: dividendDailyPriorClose,
        });
      const heldNotionalGap =
        contract != null && sumLots(lots) > 0
          ? totalFuturesNotionalAtMark({
              lots,
              contract,
              mark: markGapPrevClose,
            })
          : 0;
      const heldMaintenanceGap = heldNotionalGap * maintMarginRate;
      const cashYieldGap = Math.max(0, cash - heldMaintenanceGap - freeCashAt(dates[i - 1] as string));
      let accrualMonth = (dates[i - 1] as string).slice(0, 7);
      for (let gapDay = 1; gapDay <= extraSweepDays; gapDay++) {
        const gapDate = addCalendarDaysIso(dates[i - 1] as string, gapDay);
        const gapMonth = gapDate.slice(0, 7);
        if (gapMonth !== accrualMonth) {
          creditPendingCashInterest();
          accrualMonth = gapMonth;
        }
        accrueCashInterest(cashYieldGap * cashRateGap, 1);
      }
      if (date.slice(0, 7) !== accrualMonth) {
        creditPendingCashInterest();
      }
    } else if (date.slice(0, 7) !== (dates[i - 1] as string).slice(0, 7)) {
      // First trading row of a new month: prior-month sweep is now posted cash.
      creditPendingCashInterest();
    }

    // SMA uses prior close; regime trades execute next session shortly after the open (opens for fills).
    if (invested[i] !== invested[i - 1]) {
      if (invested[i]) {
        pendingExitRiskOff = true;
      } else {
        pendingEnterRiskOff = true;
      }
    }

    // Infer dividend carry (must run once per day before futures MTM and regime trades).
    const spotRet = spot / prevSpot - 1;
    const trPrev = adjCloses[i - 1];
    const trNow = adjCloses[i];
    const trRet =
      Number.isFinite(trPrev) && Number.isFinite(trNow) && trPrev > 0 && trNow > 0
        ? trNow / trPrev - 1
        : spotRet;
    // Realized payout for this row (covers weekend/holiday gaps in one number).
    // Drives the carry charged to held positions; the smoothed EMA below only
    // estimates *future* dividends for the basis baked into fill prices.
    const rawDividend = trRet - spotRet;
    const realizedDividend = Number.isFinite(rawDividend) ? rawDividend : 0;
    dividendEmaDaily = (dividendEmaDaily * (1 - divAlpha)) + (realizedDividend * divAlpha);
    const dividendDaily = Math.max(-MAX_ABS_DIVIDEND_DAILY, Math.min(MAX_ABS_DIVIDEND_DAILY, dividendEmaDaily));
    const rateDaily = rateLookup.getRate(date); // already /360

    const takeCashInterestFieldsForAttribution = (amount: number) => {
      if (!Number.isFinite(amount) || amount <= 0) return {};
      const fields = {
        cashInterestTradingDays: Math.max(1, interestSweepSessionCount),
        cashInterestAnnualRatePct: sweepNetAnnualPctFromRateDaily(rateDaily, spreadAnnual),
      };
      interestSweepSessionCount = 0;
      return fields;
    };
    const futuresFillAt = (symbol: string, spotPrice = idxOpen) => futuresBasisFillPrice({
      spotPrice,
      symbol,
      tradeDate: date,
      rateDaily,
      dividendDaily,
    });

    // Realize prior-close-to-current-open futures PnL before same-day open trades.
    // Charge futures carry to contracts held from the prior close, not contracts
    // opened today. Rate accrues per calendar day so weekend/holiday carry matches
    // cash sweep accrual. Fills/notional use estimated contract prices, but
    // portfolio economics stay on index moves plus explicit carry so financing is
    // not counted both in basis decay and collateral interest; netting the
    // realized dividend against the rate leaves a held position earning exactly
    // the index total return minus financing.
    if (contract && sumLots(lots) > 0) {
      const mult = getContractMultiplier(contract);
      const carryDaysSincePrevClose = Math.max(1, gapCalendarDays);
      const futuresCarrySincePrevClose = futuresCarryForHoldingPeriod({
        rateDaily,
        dividendForPeriod: realizedDividend,
        calendarDays: carryDaysSincePrevClose,
      });
      for (const [, q] of lots) {
        if (q <= 0) continue;
        cash += q * mult * (idxOpen - prevSpot - (prevSpot * futuresCarrySincePrevClose));
      }
    }

    // Next-day-open: exit risk-off basket before enter-risk-off (mutually exclusive flags per day).
    if (pendingExitRiskOff && (riskOffShares || riskOffCash)) {
      for (let j = 0; j < riskOffTickers.length; j++) {
        const t = riskOffTickers[j];
        const shares = riskOffShares?.[j] ?? 0;
        const openArr = params.riskOffOpenByTicker?.[t];
        const closeArr = params.riskOffCloseByTicker?.[t];
        const openPx = riskOffOpenTradePrice({
          openValues: openArr,
          closeValues: closeArr,
          index: i,
          lastPrice: riskOffLastPrice?.[j],
        });
        if (shares > 0 && Number.isFinite(openPx) && (openPx as number) > 0) {
          const gross = shares * (openPx as number);
          const spread = getTransactionSpreadCost({
            instrument: "riskoff",
            symbol: t,
            qtyDelta: shares,
            fillPrice: openPx as number,
          });
          const fees = getRiskOffCommission({
            qtyDelta: shares,
            fillPrice: openPx as number,
            dollarScale: feeDollarScaleForDate(date),
          });
          cash += Math.max(0, gross - spread - fees);
          totalFees += fees;
          totalSpreadCosts += spread;
          transactions.push({
            date,
            action: "sell",
            instrument: "riskoff",
            symbol: t,
            qtyDelta: -shares,
            qtyAfter: 0,
            fillPrice: openPx as number,
            fees,
            spread,
            cashInterestEarned: 0,
            excessLiquidity: 0,
            leverageDeltaPct: 0,
            equity: cash,
          });
        }
        const cashPiece = riskOffCash?.[j] ?? 0;
        if (Number.isFinite(cashPiece) && cashPiece > 0) cash += cashPiece;
      }
      riskOffShares = null;
      riskOffCash = null;
      riskOffLastPrice = null;
      pendingExitRiskOff = false;
    }

    if (pendingEnterRiskOff) {
      // Flatten futures at index open, then buy risk-off legs at their opens (same-time book).
      if (sumLots(lots) > 0 && contract) {
        const totalBefore = sumLots(lots);
        let runningQty = totalBefore;
        let intRemainFlat = accruedInterestSinceLastTx;
        for (const sym of contractSymbolsSortedForReduction(lots, date)) {
          const qLeg = lots.get(sym) ?? 0;
          if (qLeg <= 0) continue;
          const delta = -qLeg;
          const fillPrice = futuresFillAt(sym);
          const fees = Math.abs(delta) * feePerContractAt(fillPrice);
          const spread = getTransactionSpreadCost({
            instrument: "futures",
            symbol: sym,
            qtyDelta: delta,
            fillPrice,
            dollarScale: futuresPriceScale(fillPrice),
          });
          const levBefore = futuresLegLeverageDeltaPct({
            qty: runningQty,
            contract,
            futuresMarkPrice: fillPrice,
            equity: cash,
            targetLeverage: params.targetLeverage,
          });
          cash -= (fees + spread);
          totalFees += fees;
          totalSpreadCosts += spread;
          runningQty -= qLeg;
          const levAfter = futuresLegLeverageDeltaPct({
            qty: runningQty,
            contract: runningQty > 0 ? contract : null,
            futuresMarkPrice: fillPrice,
            equity: cash,
            targetLeverage: params.targetLeverage,
          });
          const intAmt = intRemainFlat;
          if (intAmt > 0) intRemainFlat = 0;
          transactions.push({
            date,
            action: "sell",
            instrument: "futures",
            symbol: sym,
            qtyDelta: delta,
            qtyAfter: runningQty,
            fillPrice,
            fees,
            spread,
            cashInterestEarned: intAmt,
            ...takeCashInterestFieldsForAttribution(intAmt),
            excessLiquidity: 0,
            leverageDeltaPctBefore: levBefore,
            leverageDeltaPct: levAfter,
            // All-cash book after this fill (futures-only; risk-off not entered yet).
            equity: cash,
          });
          lots.set(sym, 0);
        }
        reconcileLots(lots);
        contract = null;
        accruedInterestSinceLastTx = 0;
      }

      const investable = cash;
      const valuePer = riskOffTickers.length > 0 ? investable / riskOffTickers.length : 0;
      riskOffShares = new Array(riskOffTickers.length).fill(0);
      riskOffCash = new Array(riskOffTickers.length).fill(0);
      riskOffLastPrice = new Array(riskOffTickers.length).fill(NaN);
      let riskOffBookAtOpen = 0;
      for (let j = 0; j < riskOffTickers.length; j++) {
        const t = riskOffTickers[j];
        const openArr = params.riskOffOpenByTicker?.[t];
        const closeArr = params.riskOffCloseByTicker?.[t];
        const openPx = riskOffOpenTradePrice({ openValues: openArr, closeValues: closeArr, index: i });
        if (Number.isFinite(openPx) && (openPx as number) > 0) {
          const grossShares = valuePer / (openPx as number);
          const spread = getTransactionSpreadCost({
            instrument: "riskoff",
            symbol: t,
            qtyDelta: grossShares,
            fillPrice: openPx as number,
          });
          const fees = getRiskOffCommission({
            qtyDelta: grossShares,
            fillPrice: openPx as number,
            dollarScale: feeDollarScaleForDate(date),
          });
          const netValue = Math.max(0, valuePer - spread - fees);
          const shares = netValue / (openPx as number);
          riskOffShares[j] = shares;
          riskOffLastPrice[j] = openPx as number;
          totalFees += fees;
          totalSpreadCosts += spread;
          riskOffBookAtOpen += shares * (openPx as number);
          transactions.push({
            date,
            action: "buy",
            instrument: "riskoff",
            symbol: t,
            qtyDelta: shares,
            qtyAfter: shares,
            fillPrice: openPx as number,
            fees,
            spread,
            cashInterestEarned: 0,
            excessLiquidity: 0,
            leverageDeltaPct: 0,
            equity: riskOffBookAtOpen,
          });
        } else {
          // If we can't price this component, keep it as cash.
          riskOffCash[j] = valuePer;
        }
      }
      // When we enter risk-off, the portfolio is fully allocated to the risk-off basket.
      // Any unpriceable components are held as riskOffCash; do NOT also keep them in `cash`
      // or we'd double-count equity (cash + riskOffCash).
      cash = 0;
      pendingEnterRiskOff = false;
    }

    // Open-only risk trim: if maintenance or max leverage is already breached at **open** marks,
    // peel futures at open fills. We do not trade futures at the close for leverage or margin.
    // Leverage-only breach uses the same relative band as drift (`leverageTolerancePct`): peel
    // only when notional/equity exceeds maxLeverage * (1 + tolerance/100), so small overages
    // do not fight routine rebalance sizing (reduces 2↔3 contract toggling when max ≈ target).
    if (invested[i] && !(riskOffShares || riskOffCash) && contract != null && sumLots(lots) > 0) {
      const markOpen = (sym: string) => futuresFillAt(sym);
      let intRemainOpenTrim = accruedInterestSinceLastTx;
      const openLevTrimBreachThreshold =
        Number.isFinite(maxLeverage) && maxLeverage > 0
          ? maxLeverage * (1 + leverageTolerancePct / 100)
          : Number.POSITIVE_INFINITY;
      while (sumLots(lots) > 0 && contract != null) {
        const notionalO = totalFuturesNotionalAtMark({
          lots,
          contract,
          mark: markOpen,
        });
        const equityO = cash;
        const excessO = equityO - notionalO * maintMarginRate;
        const levO = equityO > 0 ? notionalO / equityO : Number.POSITIVE_INFINITY;
        const levBreaches =
          Number.isFinite(maxLeverage) && maxLeverage > 0 && levO > openLevTrimBreachThreshold;
        if (excessO > 0 && !levBreaches) break;

        const sym =
          contractSymbolsSortedForReduction(lots, date).find((s) => (lots.get(s) ?? 0) > 0) ?? null;
        if (sym == null) break;
        const q0 = lots.get(sym) ?? 0;
        if (q0 <= 0) break;

        const fillPrice = futuresFillAt(sym);
        const feePerContract = feePerContractAt(fillPrice);
        const spreadPerContract = getTransactionSpreadCost({
          instrument: "futures",
          symbol: sym,
          qtyDelta: -1,
          fillPrice,
          dollarScale: futuresPriceScale(fillPrice),
        });
        const transactionCostPerContract = feePerContract + spreadPerContract;
        const notionalPerContract =
          contract != null ? getContractMultiplier(contract) * fillPrice : 0;

        let sellQty = 1;
        if (
          Number.isFinite(notionalPerContract) &&
          notionalPerContract > 0 &&
          Number.isFinite(transactionCostPerContract) &&
          transactionCostPerContract >= 0
        ) {
          const equityBeforeBatch = equityO;
          const maintenanceReliefPerContract =
            notionalPerContract * maintMarginRate - transactionCostPerContract;
          if (excessO <= 0 && maintenanceReliefPerContract > 0) {
            sellQty = Math.max(
              sellQty,
              Math.floor((-excessO) / maintenanceReliefPerContract) + 1
            );
          }
          if (levBreaches) {
            const leverageReliefPerContract =
              notionalPerContract - maxLeverage * transactionCostPerContract;
            const leverageExcess = notionalO - maxLeverage * equityBeforeBatch;
            if (leverageReliefPerContract > 0 && leverageExcess > 0) {
              sellQty = Math.max(sellQty, Math.ceil(leverageExcess / leverageReliefPerContract));
            } else if (leverageExcess > 0) {
              sellQty = q0;
            }
          }
        }
        sellQty = Math.max(1, Math.min(q0, Math.floor(sellQty)));

        const fees = feePerContract * sellQty;
        const spread =
          sellQty === 1
            ? spreadPerContract
            : getTransactionSpreadCost({
                instrument: "futures",
                symbol: sym,
                qtyDelta: -sellQty,
                fillPrice,
                dollarScale: futuresPriceScale(fillPrice),
              });
        const levBeforeTrim = futuresPortfolioLeverageDeltaPctFromLots({
          lots,
          contract,
          equity: cash,
          targetLeverage: params.targetLeverage,
          mark: markOpen,
        });
        cash -= fees + spread;
        totalFees += fees;
        totalSpreadCosts += spread;
        lots.set(sym, q0 - sellQty);
        reconcileLots(lots);
        const afterTotal = sumLots(lots);
        if (afterTotal === 0) {
          contract = null;
        }
        const levAfterTrim = futuresPortfolioLeverageDeltaPctFromLots({
          lots,
          contract: afterTotal > 0 ? contract : null,
          equity: cash,
          targetLeverage: params.targetLeverage,
          mark: markOpen,
        });
        const intAmt = intRemainOpenTrim;
        if (intAmt > 0) intRemainOpenTrim = 0;
        const isMarginLiquidation = excessO <= 0;
        transactions.push({
          date,
          action: "sell",
          instrument: "futures",
          symbol: isMarginLiquidation ? `${sym} (LIQUIDATE)` : sym,
          qtyDelta: -sellQty,
          qtyAfter: afterTotal,
          fillPrice,
          fees,
          spread,
          cashInterestEarned: intAmt,
          ...takeCashInterestFieldsForAttribution(intAmt),
          excessLiquidity: 0,
          leverageDeltaPctBefore: levBeforeTrim,
          leverageDeltaPct: levAfterTrim,
          equity: cash,
        });
        if (intAmt > 0) accruedInterestSinceLastTx = 0;
      }
    }

    // Futures equity available at the open, before any roll/routine sizing.
    const equityBeforeTrade: number = cash;
    // Only allow futures positions when we are in risk-on AND have no risk-off holdings.
    // This enforces "sell risk-off first to free collateral cash".
    const hasRiskOffHoldings = Boolean(riskOffShares || riskOffCash);
    const wantsRiskOn = Boolean(invested[i]) && !hasRiskOffHoldings;
    const targetLev = wantsRiskOn ? params.targetLeverage : 0;

    let targetNotional = wantsRiskOn ? params.targetLeverage * equityBeforeTrade : 0;
    targetNotional = Math.max(0, targetNotional);

    const nextContract = wantsRiskOn ? chooseContract(params.index) : null;
    const markFuturesOpen = (sym: string) => futuresFillAt(sym);

    const quarterlyRollAppliesToday = (): boolean => {
      if (!wantsRiskOn || contract == null || sumLots(lots) <= 0 || nextContract == null) return false;
      for (const [sym, rollQty] of lots.entries()) {
        if (rollQty <= 0) continue;
        const snap = rollSnapForSymbolFromMap(sym, date, rollDateByQuarter);
        if (snap !== date) continue;
        const nextSym = advanceQuarterlySymbol(sym, date);
        if (nextSym !== sym) return true;
      }
      return false;
    };

    const executeQuarterlyRolls = () => {
      if (!wantsRiskOn || contract == null || sumLots(lots) <= 0 || nextContract == null) return;
      const legs = [...lots.entries()].filter(([, q]) => q > 0);
      for (const [sym, rollQty] of legs) {
        const snap = rollSnapForSymbolFromMap(sym, date, rollDateByQuarter);
        if (snap !== date) continue;
        const nextSym = advanceQuarterlySymbol(sym, date);
        if (nextSym === sym) continue;

        const sellFillPrice = futuresFillAt(sym);
        const buyFillPrice = futuresFillAt(nextSym);
        const sellFees = Math.abs(rollQty) * feePerContractAt(sellFillPrice);
        const buyFees = Math.abs(rollQty) * feePerContractAt(buyFillPrice);
        const sellSpread = getTransactionSpreadCost({
          instrument: "futures",
          symbol: sym,
          qtyDelta: -rollQty,
          fillPrice: sellFillPrice,
          dollarScale: futuresPriceScale(sellFillPrice),
        });
        const buySpread = getTransactionSpreadCost({
          instrument: "futures",
          symbol: nextSym,
          qtyDelta: rollQty,
          fillPrice: buyFillPrice,
          dollarScale: futuresPriceScale(buyFillPrice),
        });

        const rollLevBeforeSell = futuresPortfolioLeverageDeltaPctFromLots({
          lots,
          contract,
          equity: cash,
          targetLeverage: params.targetLeverage,
          mark: markFuturesOpen,
        });
        cash -= sellFees + sellSpread;
        totalFees += sellFees;
        totalSpreadCosts += sellSpread;
        lots.set(sym, (lots.get(sym) ?? 0) - rollQty);
        reconcileLots(lots);
        const rollLevAfterSell = futuresPortfolioLeverageDeltaPctFromLots({
          lots,
          contract,
          equity: cash,
          targetLeverage: params.targetLeverage,
          mark: markFuturesOpen,
        });
        const interestOnRollOpen = accruedInterestSinceLastTx;
        transactions.push({
          date,
          action: "sell",
          instrument: "futures",
          symbol: `${sym} (ROLL)`,
          qtyDelta: -rollQty,
          qtyAfter: sumLots(lots),
          fillPrice: sellFillPrice,
          fees: sellFees,
          spread: sellSpread,
          cashInterestEarned: interestOnRollOpen,
          ...takeCashInterestFieldsForAttribution(interestOnRollOpen),
          excessLiquidity: 0,
          leverageDeltaPctBefore: rollLevBeforeSell,
          leverageDeltaPct: rollLevAfterSell,
          equity: cash,
        });
        accruedInterestSinceLastTx = 0;

        const rollLevBeforeBuy = rollLevAfterSell;
        cash -= buyFees + buySpread;
        totalFees += buyFees;
        totalSpreadCosts += buySpread;
        lots.set(nextSym, (lots.get(nextSym) ?? 0) + rollQty);
        reconcileLots(lots);
        const rollLevAfterBuy = futuresPortfolioLeverageDeltaPctFromLots({
          lots,
          contract,
          equity: cash,
          targetLeverage: params.targetLeverage,
          mark: markFuturesOpen,
        });
        transactions.push({
          date,
          action: "buy",
          instrument: "futures",
          symbol: `${nextSym} (ROLL)`,
          qtyDelta: rollQty,
          qtyAfter: sumLots(lots),
          fillPrice: buyFillPrice,
          fees: buyFees,
          spread: buySpread,
          cashInterestEarned: 0,
          excessLiquidity: 0,
          leverageDeltaPctBefore: rollLevBeforeBuy,
          leverageDeltaPct: rollLevAfterBuy,
          equity: cash,
        });
      }
    };

    let currentQtyAfterRolls = sumLots(lots);

    // If contract family changes we fully close and reopen for clarity.
    const needsContractSwitch =
      wantsRiskOn &&
      contract != null &&
      nextContract != null &&
      contract !== nextContract &&
      currentQtyAfterRolls > 0;

    const nextContractLabel =
      wantsRiskOn && nextContract != null
        ? newTradesContractLabel(nextContract, date, rollDateByQuarter)
        : null;
    const nextContractOpenPrice = nextContractLabel ? futuresFillAt(nextContractLabel) : idxOpen;

    const maxQtyMaint =
      wantsRiskOn && nextContract != null
        ? maxQtyByMaintenance({
            equity: equityBeforeTrade,
            close: nextContractOpenPrice,
            contract: nextContract,
            maintenanceMarginRate: maintMarginRate,
          })
        : Number.POSITIVE_INFINITY;
    const maxQtyLev =
      wantsRiskOn && nextContract != null
        ? maxQtyByLeverage({
            equity: equityBeforeTrade,
            close: nextContractOpenPrice,
            contract: nextContract,
            maxLeverage,
          })
        : Number.POSITIVE_INFINITY;
    const targetQtyPreCost =
      wantsRiskOn && nextContract != null
        ? Math.min(
            enforceMinimumQty({
              qty: targetQty({ targetNotional, close: nextContractOpenPrice, contract: nextContract }),
              targetNotional,
              contract: nextContract,
              close: nextContractOpenPrice,
            }),
            maxQtyMaint,
            maxQtyLev
          )
        : 0;
    const desiredTargetQty =
      wantsRiskOn && nextContract != null
        ? capQtyForPostTradeMaintenance({
            desiredQty: targetQtyPreCost,
            currentQty: currentQtyAfterRolls,
            cashBefore: cash,
            riskOffValueAtClose: 0,
            contract: nextContract,
            symbol: nextContractLabel ?? nextContract,
            fillPrice: nextContractOpenPrice,
            tradeDate: date,
          })
        : 0;

    const currentNotional =
      contract != null && currentQtyAfterRolls > 0
        ? totalFuturesNotionalAtMark({
            lots,
            contract,
            mark: markFuturesOpen,
          })
        : 0;
    const currentLeverage = equityBeforeTrade > 0 ? currentNotional / equityBeforeTrade : 0;
    const currentLeverageDeltaPct = computeLeverageDeltaPct(currentLeverage, targetLev);
    const isMaintenanceBreach = wantsRiskOn && currentQtyAfterRolls > maxQtyMaint;
    const driftBreachesTolerance =
      wantsRiskOn &&
      currentQtyAfterRolls > 0 &&
      contract === nextContract &&
      Math.abs(currentLeverageDeltaPct) > leverageTolerancePct;
    const shouldRebalance =
      wantsRiskOn &&
      (currentQtyAfterRolls === 0 ||
        contract !== nextContract ||
        isMaintenanceBreach ||
        driftBreachesTolerance);
    let targetQtyValue = shouldRebalance ? desiredTargetQty : currentQtyAfterRolls;

    const rebalanceOnlyDrift =
      wantsRiskOn &&
      nextContract != null &&
      currentQtyAfterRolls > 0 &&
      contract === nextContract &&
      !isMaintenanceBreach &&
      driftBreachesTolerance &&
      shouldRebalance;
    if (rebalanceOnlyDrift && desiredTargetQty !== currentQtyAfterRolls) {
      const tradeSymbol = newTradesContractLabel(nextContract, date, rollDateByQuarter);
      const probeFillPrice = futuresFillAt(tradeSymbol);
      const deltaProbe = desiredTargetQty - currentQtyAfterRolls;
      const feesProbe = Math.abs(deltaProbe) * feePerContractAt(probeFillPrice);
      const spreadProbe = getTransactionSpreadCost({
        instrument: "futures",
        symbol: tradeSymbol,
        qtyDelta: deltaProbe,
        fillPrice: probeFillPrice,
        dollarScale: futuresPriceScale(probeFillPrice),
      });
      const cashAfterProbe = cash - feesProbe - spreadProbe;
      const nextLotsProbe = new Map(lots);
      if (deltaProbe > 0) {
        nextLotsProbe.set(tradeSymbol, (nextLotsProbe.get(tradeSymbol) ?? 0) + deltaProbe);
      } else {
        let rem = -deltaProbe;
        for (const sym of contractSymbolsSortedForReduction(nextLotsProbe, date)) {
          if (rem <= 0) break;
          const q = nextLotsProbe.get(sym) ?? 0;
          if (q <= 0) continue;
          const take = Math.min(q, rem);
          nextLotsProbe.set(sym, q - take);
          rem -= take;
        }
        reconcileLots(nextLotsProbe);
      }
      const markAfterProbe = (sym: string) =>
        sym === tradeSymbol && deltaProbe !== 0 ? probeFillPrice : futuresFillAt(sym);
      const projectedDelta = futuresPortfolioLeverageDeltaPctFromLots({
        lots: nextLotsProbe,
        contract: nextContract,
        equity: cashAfterProbe,
        targetLeverage: params.targetLeverage,
        mark: markAfterProbe,
      });
      const improvement = Math.abs(currentLeverageDeltaPct) - Math.abs(projectedDelta);
      if (improvement < leverageTolerancePct) {
        targetQtyValue = currentQtyAfterRolls;
      }
    }

    // Roll **before** rebalance only when we need more contracts same day (buy adds to the new
    // front month). Otherwise roll **after** rebalance so trims hit the expiring symbol (e.g. sell
    // NQM06, then roll NQM06→NQU06) and front/deferred columns stay consistent in the ledger.
    const rollToday = quarterlyRollAppliesToday();
    const wantNetAdd = wantsRiskOn && nextContract != null && targetQtyValue > currentQtyAfterRolls;
    let rolledEarlyForNetAdd = false;
    if (rollToday && wantNetAdd) {
      executeQuarterlyRolls();
      rolledEarlyForNetAdd = true;
      currentQtyAfterRolls = sumLots(lots);
    }

    const shouldTrade =
      needsContractSwitch ||
      (!wantsRiskOn && currentQtyAfterRolls > 0) ||
      (wantsRiskOn &&
        nextContract != null &&
        (currentQtyAfterRolls !== targetQtyValue || contract !== nextContract));

    if (shouldTrade) {
      const mustCloseAll =
        currentQtyAfterRolls > 0 &&
        contract != null &&
        (!wantsRiskOn || needsContractSwitch || (nextContract != null && contract !== nextContract));
      if (mustCloseAll) {
        let runningQty = currentQtyAfterRolls;
        let intRemainMust = accruedInterestSinceLastTx;
        for (const sym of contractSymbolsSortedForReduction(lots, date)) {
          const qLeg = lots.get(sym) ?? 0;
          if (qLeg <= 0) continue;
          const delta = -qLeg;
          const fillPrice = futuresFillAt(sym);
          const fees = Math.abs(delta) * feePerContractAt(fillPrice);
          const levBeforeClose = futuresPortfolioLeverageDeltaPctFromLots({
            lots,
            contract,
            equity: cash,
            targetLeverage: params.targetLeverage,
            mark: markFuturesOpen,
          });
          const spread = getTransactionSpreadCost({
            instrument: "futures",
            symbol: sym,
            qtyDelta: delta,
            fillPrice,
            dollarScale: futuresPriceScale(fillPrice),
          });
          cash -= fees + spread;
          totalFees += fees;
          totalSpreadCosts += spread;
          runningQty -= qLeg;
          lots.set(sym, 0);
          reconcileLots(lots);
          const levAfterClose = futuresPortfolioLeverageDeltaPctFromLots({
            lots,
            contract: runningQty > 0 ? contract : null,
            equity: cash,
            targetLeverage: params.targetLeverage,
            mark: markFuturesOpen,
          });
          const intAmt = intRemainMust;
          if (intAmt > 0) intRemainMust = 0;
          transactions.push({
            date,
            action: "sell",
            instrument: "futures",
            symbol: sym,
            qtyDelta: delta,
            qtyAfter: runningQty,
            fillPrice,
            fees,
            spread,
            cashInterestEarned: intAmt,
            ...takeCashInterestFieldsForAttribution(intAmt),
            excessLiquidity: 0,
            leverageDeltaPctBefore: levBeforeClose,
            leverageDeltaPct: levAfterClose,
            equity: cash,
          });
        }
        contract = null;
        accruedInterestSinceLastTx = 0;
      }

      if (wantsRiskOn && nextContract != null) {
        const afterCloseQty = sumLots(lots);
        const delta = targetQtyValue - afterCloseQty;
        if (delta !== 0) {
          if (delta > 0) {
            const tradeSymbol = newTradesContractLabel(nextContract, date, rollDateByQuarter);
            const fillPrice = futuresFillAt(tradeSymbol);
            const fees = Math.abs(delta) * feePerContractAt(fillPrice);
            const levBefore = futuresPortfolioLeverageDeltaPctFromLots({
              lots,
              contract: afterCloseQty > 0 ? contract : null,
              equity: cash,
              targetLeverage: params.targetLeverage,
              mark: markFuturesOpen,
            });
            const spread = getTransactionSpreadCost({
              instrument: "futures",
              symbol: tradeSymbol,
              qtyDelta: delta,
              fillPrice,
              dollarScale: futuresPriceScale(fillPrice),
            });
            cash -= fees + spread;
            totalFees += fees;
            totalSpreadCosts += spread;
            lots.set(tradeSymbol, (lots.get(tradeSymbol) ?? 0) + delta);
            reconcileLots(lots);
            contract = nextContract;
            const newTotal = sumLots(lots);
            const levAfter = futuresPortfolioLeverageDeltaPctFromLots({
              lots,
              contract,
              equity: cash,
              targetLeverage: params.targetLeverage,
              mark: markFuturesOpen,
            });
            const intOnBuy = accruedInterestSinceLastTx;
            transactions.push({
              date,
              action: "buy",
              instrument: "futures",
              symbol: tradeSymbol,
              qtyDelta: delta,
              qtyAfter: newTotal,
              fillPrice,
              fees,
              spread,
              cashInterestEarned: intOnBuy,
              ...takeCashInterestFieldsForAttribution(intOnBuy),
              excessLiquidity: 0,
              leverageDeltaPctBefore: levBefore,
              leverageDeltaPct: levAfter,
              equity: cash,
            });
            accruedInterestSinceLastTx = 0;
          } else {
            let toSell = -delta;
            let runningAfter = afterCloseQty;
            let intRemainPartial = accruedInterestSinceLastTx;
            for (const sym of contractSymbolsSortedForReduction(lots, date)) {
              if (toSell <= 0) break;
              const qLeg = lots.get(sym) ?? 0;
              if (qLeg <= 0) continue;
              const take = Math.min(qLeg, toSell);
              const legDelta = -take;
              const fillPrice = futuresFillAt(sym);
              const legFees = Math.abs(legDelta) * feePerContractAt(fillPrice);
              const levBefore = futuresPortfolioLeverageDeltaPctFromLots({
                lots,
                contract,
                equity: cash,
                targetLeverage: params.targetLeverage,
                mark: markFuturesOpen,
              });
              const spread = getTransactionSpreadCost({
                instrument: "futures",
                symbol: sym,
                qtyDelta: legDelta,
                fillPrice,
                dollarScale: futuresPriceScale(fillPrice),
              });
              cash -= legFees + spread;
              totalFees += legFees;
              totalSpreadCosts += spread;
              runningAfter -= take;
              toSell -= take;
              lots.set(sym, qLeg - take);
              reconcileLots(lots);
              const levAfter = futuresPortfolioLeverageDeltaPctFromLots({
                lots,
                contract: runningAfter > 0 ? nextContract : null,
                equity: cash,
                targetLeverage: params.targetLeverage,
                mark: markFuturesOpen,
              });
              const intAmt = intRemainPartial;
              if (intAmt > 0) intRemainPartial = 0;
              transactions.push({
                date,
                action: "sell",
                instrument: "futures",
                symbol: sym,
                qtyDelta: legDelta,
                qtyAfter: runningAfter,
                fillPrice,
                fees: legFees,
                spread,
                cashInterestEarned: intAmt,
                ...takeCashInterestFieldsForAttribution(intAmt),
                excessLiquidity: 0,
                leverageDeltaPctBefore: levBefore,
                leverageDeltaPct: levAfter,
                equity: cash,
              });
              if (intAmt > 0) accruedInterestSinceLastTx = 0;
            }
            if (sumLots(lots) === 0) {
              contract = null;
            } else {
              contract = nextContract;
            }
          }
        }
      }
    }

    if (rollToday && !rolledEarlyForNetAdd) {
      executeQuarterlyRolls();
    }

    // Mark-to-market remaining open-to-close futures PnL after open trades.
    // Daily carry was already attributed to positions held from the prior close.
    const markFuturesClose = (sym: string) => futuresFillAt(sym, spot);
    if (contract != null && sumLots(lots) > 0) {
      const mult = getContractMultiplier(contract);
      for (const [, q] of lots) {
        if (q <= 0) continue;
        cash += q * mult * (spot - idxOpen);
      }
    }

    // Cash interest (sweep) on equity above the maintenance requirement, with
    // a haircut for the broker spread and an additional unswept-cash buffer.
    const heldNotional =
      contract != null && sumLots(lots) > 0
        ? totalFuturesNotionalAtMark({
            lots,
            contract,
            mark: markFuturesClose,
          })
        : 0;
    const heldMaintenance = heldNotional * maintMarginRate;
    const cashYieldBase = Math.max(0, cash - heldMaintenance - freeCashAt(date));
    const spreadDaily = spreadAnnual / 360;
    const cashRateDaily = Math.max(0, rateDaily - spreadDaily);
    const interestEarned = cashYieldBase * cashRateDaily;
    accrueCashInterest(interestEarned, 1);

    // Total equity includes any risk-off holdings marked to today's close.
    let riskOffValueAtClose = 0;
    if (riskOffShares || riskOffCash) {
      for (let j = 0; j < riskOffTickers.length; j++) {
        const t = riskOffTickers[j];
        const shares = riskOffShares?.[j] ?? 0;
        const closeArr = params.riskOffCloseByTicker?.[t];
        const px = riskOffCloseMarkPrice({ closeValues: closeArr, index: i, lastPrice: riskOffLastPrice?.[j] });
        if (shares > 0) {
          if (Number.isFinite(px) && (px as number) > 0) {
            riskOffValueAtClose += shares * (px as number);
            if (riskOffLastPrice) riskOffLastPrice[j] = px as number;
          } else {
            // Risk-off price missing (e.g. pre-launch). Convert to cash using last known price and compound.
            const last = riskOffLastPrice?.[j];
            const fallbackPrice = Number.isFinite(last ?? NaN) && (last as number) > 0 ? (last as number) : 0;
            const cashValue = fallbackPrice > 0 ? shares * fallbackPrice : 0;
            if (riskOffShares) riskOffShares[j] = 0;
            if (riskOffCash) riskOffCash[j] = (riskOffCash[j] ?? 0) + cashValue;
          }
        }
        const cashPiece = riskOffCash?.[j] ?? 0;
        if (Number.isFinite(cashPiece) && cashPiece > 0) {
          // Simple compounding fallback for cash-like exposure.
          const fallbackReturn = rateDaily > 0 ? rateDaily : 0;
          if (riskOffCash) riskOffCash[j] = cashPiece * (1 + fallbackReturn);
          riskOffValueAtClose += (riskOffCash ? riskOffCash[j] : cashPiece);
        }
      }
    }

    // Post-trade: compute equity and risk metrics for that close.
    const notional =
      contract != null && sumLots(lots) > 0
        ? totalFuturesNotionalAtMark({
            lots,
            contract,
            mark: markFuturesClose,
          })
        : 0;
    const maintenanceMarginUsed = notional * maintMarginRate;
    const equity = cash + riskOffValueAtClose;
    const excessLiquidity = equity - maintenanceMarginUsed;
    const actualLeverage = equity > 0 ? notional / equity : 0;
    const leverageDeltaPct = computeLeverageDeltaPct(actualLeverage, targetLev);
    if (
      invested[i] &&
      contract != null &&
      sumLots(lots) > 0 &&
      equity > 0
    ) {
      maxAbsLeverageDeltaRiskOnPct = Math.max(
        maxAbsLeverageDeltaRiskOnPct,
        Math.abs(leverageDeltaPct)
      );
    }
    const endEquity = equity;
    const endNotional = notional;
    const endLeverageDeltaPct = leverageDeltaPct;
    const endExcessLiquidity = excessLiquidity;

    // Fill EOD columns for all transactions on this date (if any). Do not overwrite `equity`:
    // each row carries post-trade book value for the ledger Value column; stamping it with
    // `endEquity` would make every intraday line on the same date identical.
    for (let t = transactions.length - 1; t >= 0; t--) {
      if (transactions[t].date !== date) break;
      transactions[t].excessLiquidity = endExcessLiquidity;
      if (transactions[t].instrument !== "futures") {
        transactions[t].leverageDeltaPct = endLeverageDeltaPct;
      }
    }

    // Do NOT treat cash==0 as bankruptcy: when in risk-off we may be fully invested
    // in risk-off holdings with zero free cash.
    if (endEquity <= 0) {
      cash = 0;
      lots.clear();
      contract = null;
      riskOffShares = null;
      riskOffCash = null;
      riskOffLastPrice = null;
      dailyEquity[i] = 0;
      for (let j = i + 1; j < dates.length; j++) dailyEquity[j] = 0;
      break;
    }

    // If we are in risk-off, equity should reflect marked-to-close risk-off value too.
    // Sweep interest posts to cash monthly, but it is the account's money from the
    // day it accrues — carrying the unposted balance here keeps the equity curve
    // smooth instead of stepping up ~1% of equity on every month's first session
    // (at 1981 rates). Trading and margin still size off posted `cash` only.
    dailyEquity[i] = clampToFinite(endEquity + pendingMonthlyCashInterest, dailyEquity[i - 1]);

    if (invested[i] && sumLots(lots) > 0 && contract !== null && endEquity > 0) {
      const lev = endNotional / endEquity;
      if (Number.isFinite(lev)) {
        sumActualLeverageRiskOn += lev;
        riskOnLeverageDayCount += 1;
      }
    }

  }

  // Book-close row for the transaction ledger (same idea as backtest SMA tables).
  const lastIdx = dates.length - 1;
  if (lastIdx >= 0) {
    // Post the final month's sweep to cash for the ledger. No equity adjustment:
    // `dailyEquity` already carries the accrued balance day by day.
    creditPendingCashInterest();
  }
  const windowFinalEquity = dailyEquity[lastIdx] ?? 0;
  if (transactions.length > 0 && lastIdx >= 0 && windowFinalEquity > 0) {
    const finalDate = dates[lastIdx]!;
    const endsRiskOn = Boolean(invested[lastIdx]);
    const hasOpenFutures = contract != null && sumLots(lots) > 0;

    // Helper to compute a basis-adjusted futures price at the window close.
    const finalRateDaily = rateLookup.getRate(finalDate);
    const finalSpot = smaInput[lastIdx] ?? 0;
    const finalOpen =
      Number.isFinite(indexOpenPx[lastIdx]) && (indexOpenPx[lastIdx] as number) > 0
        ? (indexOpenPx[lastIdx] as number)
        : finalSpot;
    const finalSpotRet = lastIdx >= 1 && (smaInput[lastIdx - 1] ?? 0) > 0
      ? (finalSpot / (smaInput[lastIdx - 1] as number)) - 1
      : 0;
    const finalTrPrev = adjCloses[Math.max(0, lastIdx - 1)];
    const finalTrNow = adjCloses[lastIdx];
    const finalTrRet =
      Number.isFinite(finalTrPrev) && Number.isFinite(finalTrNow) && (finalTrPrev ?? 0) > 0 && (finalTrNow ?? 0) > 0
        ? ((finalTrNow as number) / (finalTrPrev as number)) - 1
        : finalSpotRet;
    const finalDividendDailyRaw = finalTrRet - finalSpotRet;
    const finalDividendDaily = Number.isFinite(finalDividendDailyRaw)
      ? Math.max(-MAX_ABS_DIVIDEND_DAILY, Math.min(MAX_ABS_DIVIDEND_DAILY, finalDividendDailyRaw))
      : 0;
    const futuresFillAtFinal = (symbol: string, spotPrice = finalOpen) => futuresBasisFillPrice({
      spotPrice,
      symbol,
      tradeDate: finalDate,
      rateDaily: finalRateDaily,
      dividendDaily: finalDividendDaily,
    });

    if (endsRiskOn && hasOpenFutures && contract != null) {
      const markFinal = (sym: string) => futuresFillAtFinal(sym);
      const ordered = contractSymbolsSortedForReduction(lots, finalDate);
      let totalFeesTerm = 0;
      let totalSpreadTerm = 0;
      for (const sym of ordered) {
        const qLeg = lots.get(sym) ?? 0;
        if (qLeg <= 0) continue;
        const fp = futuresFillAtFinal(sym);
        totalFeesTerm += qLeg * feePerContractAt(fp);
        totalSpreadTerm += getTransactionSpreadCost({
          instrument: "futures",
          symbol: sym,
          qtyDelta: -qLeg,
          fillPrice: fp,
          dollarScale: futuresPriceScale(fp),
        });
      }
      const equityNet = Math.max(0, windowFinalEquity - totalFeesTerm - totalSpreadTerm);
      const levAfterTerm = futuresLegLeverageDeltaPct({
        qty: 0,
        contract: null,
        futuresMarkPrice: finalOpen,
        equity: equityNet,
        targetLeverage: params.targetLeverage,
      });
      dailyEquity[lastIdx] = equityNet;
      totalFees += totalFeesTerm;
      totalSpreadCosts += totalSpreadTerm;
      let runQty = sumLots(lots);
      const cFam = contract;
      let intRemainTerm = accruedInterestSinceLastTx;
      for (const sym of ordered) {
        const qLeg = lots.get(sym) ?? 0;
        if (qLeg <= 0) continue;
        const fillPrice = futuresFillAtFinal(sym);
        const fees = qLeg * feePerContractAt(fillPrice);
        const spread = getTransactionSpreadCost({
          instrument: "futures",
          symbol: sym,
          qtyDelta: -qLeg,
          fillPrice,
          dollarScale: futuresPriceScale(fillPrice),
        });
        const levBefore = futuresPortfolioLeverageDeltaPctFromLots({
          lots,
          contract: cFam,
          equity: windowFinalEquity,
          targetLeverage: params.targetLeverage,
          mark: markFinal,
        });
        runQty -= qLeg;
        lots.set(sym, 0);
        reconcileLots(lots);
        const levAfter =
          runQty === 0
            ? levAfterTerm
            : futuresPortfolioLeverageDeltaPctFromLots({
                lots,
                contract: cFam,
                equity: equityNet,
                targetLeverage: params.targetLeverage,
                mark: markFinal,
              });
        const intAmt = intRemainTerm;
        if (intAmt > 0) intRemainTerm = 0;
        const sweepMeta =
          intAmt > 0
            ? {
                cashInterestTradingDays: Math.max(1, interestSweepSessionCount),
                cashInterestAnnualRatePct: sweepNetAnnualPctFromRateDaily(finalRateDaily, spreadAnnual),
              }
            : {};
        if (intAmt > 0) interestSweepSessionCount = 0;
        transactions.push({
          date: finalDate,
          action: "sell",
          instrument: "futures",
          symbol: `${sym} (LIQUIDATE)`,
          qtyDelta: -qLeg,
          qtyAfter: runQty,
          fillPrice,
          fees,
          spread,
          cashInterestEarned: intAmt,
          ...sweepMeta,
          excessLiquidity: equityNet,
          leverageDeltaPctBefore: levBefore,
          leverageDeltaPct: levAfter,
          equity: equityNet,
          ...(runQty === 0 ? { isEndLiquidation: true as const } : {}),
        });
      }
      accruedInterestSinceLastTx = 0;
    } else if (!endsRiskOn && (riskOffShares || riskOffCash)) {
      // For risk-off, keep a single terminal ledger row (no per-leg liquidation).
      let totalRiskOffExitFees = 0;
      let totalRiskOffExitSpread = 0;
      for (let j = 0; j < riskOffTickers.length; j++) {
        const t = riskOffTickers[j];
        const shares = riskOffShares?.[j] ?? 0;
        if (!(Number.isFinite(shares) && shares > 0)) continue;
        const closeArr = params.riskOffCloseByTicker?.[t];
        const px = riskOffCloseMarkPrice({
          closeValues: closeArr,
          index: lastIdx,
          lastPrice: riskOffLastPrice?.[j],
        });
        if (!Number.isFinite(px) || (px as number) <= 0) continue;
        const fillPrice = px as number;
        totalRiskOffExitFees += getRiskOffCommission({
          qtyDelta: shares,
          fillPrice,
          dollarScale: feeDollarScaleForDate(finalDate),
        });
        totalRiskOffExitSpread += getTransactionSpreadCost({
          instrument: "riskoff",
          symbol: t,
          qtyDelta: shares,
          fillPrice,
        });
      }
      const riskOffEquityNet = Math.max(0, windowFinalEquity - totalRiskOffExitFees - totalRiskOffExitSpread);
      // Make the strategy's reported end value reflect closing costs.
      dailyEquity[lastIdx] = riskOffEquityNet;
      totalFees += totalRiskOffExitFees;
      totalSpreadCosts += totalRiskOffExitSpread;
      transactions.push({
        date: finalDate,
        action: "sell",
        instrument: "riskoff",
        symbol: `${formatRiskOffLiquidationAbbrev(params.riskOffAsset)} (LIQUIDATE)`,
        qtyDelta: 0,
        qtyAfter: 0,
        fillPrice: 0,
        fees: totalRiskOffExitFees,
        spread: totalRiskOffExitSpread,
        cashInterestEarned: 0,
        excessLiquidity: riskOffEquityNet,
        leverageDeltaPct: 0,
        equity: riskOffEquityNet,
        isEndLiquidation: true as const,
      });
    }
  }

  // Total trading cost expressed as a percent of ending equity.
  const finalEquity = dailyEquity[dailyEquity.length - 1] ?? 0;
  const totalTradingCostPct = finalEquity > 0 ? ((totalFees + totalSpreadCosts) / finalEquity) * 100 : 0;

  const leverageLabel = formatLeverageLabel(params.targetLeverage);
  const name = params.displayName ?? `${leverageLabel}x ${params.index === "sp500" ? "SPX" : "NDQ"} SMA`;
  const id = `${params.targetLeverage}x-${params.index}-futures-sma`;
  const etfResult = buildEtfResult({
    id,
    name,
    sourceIndex: params.index,
    dates,
    dailyValues: dailyEquity,
    smaSignals: sma.signals,
    smaPrices: sma.smaValues,
    totalTradingCostPct,
  });

  let riskOffSessionDayCount = 0;
  for (let i = 0; i < invested.length; i++) {
    if (!invested[i]) riskOffSessionDayCount += 1;
  }
  const avgActualLeverageRiskOn =
    riskOnLeverageDayCount > 0 ? sumActualLeverageRiskOn / riskOnLeverageDayCount : NaN;

  return {
    etfResult,
    targetLeverage: params.targetLeverage,
    index: params.index,
    transactions,
    initialEquity: clampToFinite(params.initialEquity, 0),
    avgActualLeverageRiskOn,
    maxAbsLeverageDeltaRiskOnPct,
    riskOffSessionDayCount,
    sessionDayCount: invested.length,
  };
}
