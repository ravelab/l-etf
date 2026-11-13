/**
 * Quarterly ES/NQ/MES/MNQ listings: symbols, expiries and the roll calendar,
 * basis-adjusted fill prices and carry, and the per-listing lot book.
 */

import type { IndexKey } from "@/lib/simulation/types";

export type FuturesContractSymbol = "ES" | "NQ" | "MES" | "MNQ";

/** Micro roots first: "MESZ26" must not be read as an ES listing. */
const FUTURES_LISTING_PATTERN = /^(MES|MNQ|ES|NQ)([HMUZ])(\d{2})/;

type FuturesMonthCode = "H" | "M" | "U" | "Z"; // Mar/Jun/Sep/Dec

/** Whole calendar days from ISO date a to b (b − a). E.g. Fri → Mon = 3. */
export function calendarDaysBetweenIso(isoA: string, isoB: string): number {
  const t = (s: string) =>
    Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  return Math.round((t(isoB) - t(isoA)) / 86_400_000);
}

export function addCalendarDaysIso(date: string, days: number): string {
  const d = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))));
  d.setUTCDate(d.getUTCDate() + days);
  return iso(d);
}

export function getContractMultiplier(contract: FuturesContractSymbol): number {
  switch (contract) {
    case "ES":
      return 50;
    case "NQ":
      return 20;
    case "MES":
      return 5;
    case "MNQ":
      return 2;
  }
}

/** Family of a dated listing ("MESZ26" → "MES"); null for anything else. */
export function familyOfSymbol(symbol: string): FuturesContractSymbol | null {
  const match = FUTURES_LISTING_PATTERN.exec(symbol);
  return match ? (match[1] as FuturesContractSymbol) : null;
}

export function microFamilyOf(family: FuturesContractSymbol): FuturesContractSymbol {
  return family === "ES" || family === "MES" ? "MES" : "MNQ";
}

export function isMicroFamily(family: FuturesContractSymbol | null): boolean {
  return family === "MES" || family === "MNQ";
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

/** UTC-midnight epoch and calendar year of one `YYYY-MM-DD` trade date. */
export type TradeDayStamp = { readonly year: number; readonly epochMs: number };

type ContractSymbolParts = { readonly quarterMonth: 3 | 6 | 9 | 12; readonly yy: number };

/**
 * Symbol parses, expiry dates and trade-date epochs are pure functions of their
 * inputs, yet they are re-derived on *every* futures mark — a multi-decade run
 * across several ladder rungs takes millions of marks — so all three are memoized.
 * Keys are bounded by the distinct contract symbols and index calendar dates in the
 * loaded data, so the maps stay small and their values can never go stale.
 */
const tradeDayStampCache = new Map<string, TradeDayStamp>();

const contractSymbolPartsCache = new Map<string, ContractSymbolParts | null>();

const contractExpiryEpochCache = new Map<number, number>();

/** Per-day stamp hoisted out of the per-mark path: a lookup instead of a `Date` allocation. */
export function tradeDayStamp(tradeDate: string): TradeDayStamp {
  const cached = tradeDayStampCache.get(tradeDate);
  if (cached) return cached;
  const stamp: TradeDayStamp = {
    year: Number(tradeDate.slice(0, 4)),
    epochMs: new Date(`${tradeDate}T00:00:00Z`).getTime(),
  };
  tradeDayStampCache.set(tradeDate, stamp);
  return stamp;
}

function resolveTwoDigitYear(yy: number, tradeYear: number): number {
  let year = Math.floor(tradeYear / 100) * 100 + yy;
  if (year < tradeYear - 50) year += 100;
  if (year > tradeYear + 50) year -= 100;
  return year;
}

function parseContractSymbolParts(symbol: string): ContractSymbolParts | null {
  const cached = contractSymbolPartsCache.get(symbol);
  if (cached !== undefined) return cached;
  const match = symbol.match(FUTURES_LISTING_PATTERN);
  const parts: ContractSymbolParts | null = match
    ? {
        quarterMonth: quarterMonthFromMonthCode(match[2] as FuturesMonthCode),
        yy: Number(match[3]),
      }
    : null;
  contractSymbolPartsCache.set(symbol, parts);
  return parts;
}

function thirdFridayEpochMs(year: number, quarterMonth: 3 | 6 | 9 | 12): number {
  // Quarter months are 3/6/9/12, so `year * 12 + quarterMonth` cannot collide.
  const key = year * 12 + quarterMonth;
  const cached = contractExpiryEpochCache.get(key);
  if (cached !== undefined) return cached;
  const epochMs = thirdFriday(year, quarterMonth).getTime();
  contractExpiryEpochCache.set(key, epochMs);
  return epochMs;
}

/**
 * Expiry epoch (ms) of a contract symbol, read through `tradeYear`'s century window.
 * `null` only when the symbol is not a quarterly ES/NQ listing.
 */
export function getContractExpiryEpochMs(symbol: string, tradeYear: number): number | null {
  const parts = parseContractSymbolParts(symbol);
  if (!parts) return null;
  return thirdFridayEpochMs(resolveTwoDigitYear(parts.yy, tradeYear), parts.quarterMonth);
}

/** Dollars per index point of an ES/NQ/MES/MNQ listing (e.g. "NQM88"); null for anything else. */
export function futuresListingMultiplier(symbol: string): number | null {
  const family = familyOfSymbol(symbol);
  return family ? getContractMultiplier(family) : null;
}

/** Expiry of a listing as seen from `tradeDate` (two-digit years resolve against it); null if unparseable. */
export function futuresContractExpiryEpochMs(symbol: string, tradeDate: string): number | null {
  return getContractExpiryEpochMs(symbol, tradeDayStamp(tradeDate).year);
}

function daysToContractExpiry(symbol: string, tradeDate: string): number {
  const stamp = tradeDayStamp(tradeDate);
  const expiryMs = getContractExpiryEpochMs(symbol, stamp.year);
  if (expiryMs == null) return 0;
  const days = (expiryMs - stamp.epochMs) / (24 * 60 * 60 * 1000);
  return Number.isFinite(days) ? Math.max(0, days) : 0;
}

export function futuresBasisFillPrice(params: {
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
 * held position earn exactly `indexTotalReturn − (rate + fundingSpread) × days`: price return plus
 * the dividend it gives up equals the total return by construction. That keeps
 * the futures path on the same index the LETF engine compounds (`adj_close`)
 * instead of on the raw `close` column, which for spliced history is a
 * different series and disagrees with it by up to 3% on some days.
 */
export function futuresCarryForHoldingPeriod(params: {
  rateDaily: number;
  /** Annual premium the contract's embedded financing carries over the risk-free rate. */
  fundingSpreadAnnual?: number;
  /** Dividend paid over the whole holding period, as a fraction of the prior close. */
  dividendForPeriod: number;
  calendarDays: number;
}): number {
  const days = Math.max(0, params.calendarDays);
  if (days <= 0) return 0;
  const spreadAnnual = Number.isFinite(params.fundingSpreadAnnual)
    ? (params.fundingSpreadAnnual as number)
    : 0;
  const rateAnnual = (Number.isFinite(params.rateDaily) ? params.rateDaily * 360 : 0) + spreadAnnual;
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

export function parseQuarterlyFutureSymbol(
  symbol: string,
  anchorTradeDate: string
): {
  family: FuturesContractSymbol;
  expiryYear: number;
  quarterMonth: 3 | 6 | 9 | 12;
} | null {
  const match = symbol.match(/^(MES|MNQ|ES|NQ)([HMUZ])(\d{2})$/);
  if (!match) return null;
  const family = match[1] as FuturesContractSymbol;
  const year2 = Number(match[3]);
  const monthCode = match[2] as FuturesMonthCode;
  const expiryYear = resolveTwoDigitYear(year2, tradeDayStamp(anchorTradeDate).year);
  const quarterMonth = quarterMonthFromMonthCode(monthCode);
  return { family, expiryYear, quarterMonth };
}

export function advanceQuarterlySymbol(symbol: string, anchorTradeDate: string): string {
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
  const expiryMs = getContractExpiryEpochMs(symbol, tradeDayStamp(anchorTradeDate).year);
  if (expiryMs == null) return null;
  const dateSet = new Set(dates);
  const rollTarget = new Date(expiryMs - daysBeforeExpiry * 24 * 60 * 60 * 1000);
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

export function rollSnapForSymbolFromMap(
  symbol: string,
  anchorTradeDate: string,
  rollDateByQuarter: Map<string, string>
): string | null {
  const parsed = parseQuarterlyFutureSymbol(symbol, anchorTradeDate);
  if (!parsed) return null;
  return rollDateByQuarter.get(`${parsed.expiryYear}-${parsed.quarterMonth}`) ?? null;
}

/** In the contract's expiry **calendar month** (and year), new trades use the **next** quarter's symbol. */
export function newTradesContractLabel(
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

export function sumLots(lots: Map<string, number>): number {
  let s = 0;
  for (const q of lots.values()) s += q;
  return s;
}

export function reconcileLots(lots: Map<string, number>): void {
  for (const [k, v] of [...lots.entries()]) {
    if (v <= 0) lots.delete(k);
  }
}

/**
 * Sell nearer-expiry (calendar front) legs first when shrinking so reductions peel the
 * contracts that would otherwise need rolling soonest, avoiding redundant roll fees on
 * inventory you are exiting anyway.
 */
export function contractSymbolsSortedForReduction(lots: Map<string, number>, anchorDate: string): string[] {
  const anchorYear = tradeDayStamp(anchorDate).year;
  // Micros before full contracts: they cost more to hold through every roll, and
  // draining them first keeps a reduction exact (see `microFutures`).
  const microRank = (sym: string) => (isMicroFamily(familyOfSymbol(sym)) ? 0 : 1);
  return [...lots.entries()]
    .filter(([, q]) => q > 0)
    .sort((a, b) => {
      const byMicro = microRank(a[0]) - microRank(b[0]);
      if (byMicro !== 0) return byMicro;
      const expA = getContractExpiryEpochMs(a[0], anchorYear) ?? 0;
      const expB = getContractExpiryEpochMs(b[0], anchorYear) ?? 0;
      return expA - expB;
    })
    .map(([sym]) => sym);
}

export function chooseContract(index: IndexKey): FuturesContractSymbol {
  return index === "sp500" ? "ES" : "NQ";
}

export function stripFuturesLedgerSuffix(symbol: string): string {
  return symbol.replace(/\s*\((?:ROLL|LIQUIDATE)\)\s*$/i, "").trim();
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
