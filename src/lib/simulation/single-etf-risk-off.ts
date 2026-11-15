// The risk-off basket an LETF sleeve holds while its timing rule is out.
//
// Positions are tracked as units of each leg's price series, so the value is
// read directly off prices (no compounded floating-point drift) and a buy and
// a later sell compare like with like. The basket splits equally across its
// legs ONLY on entry to risk-off, so a 1885 start that first exits in 1972
// still enters with the configured proportions. A leg with no tradable price
// holds dollars instead, accruing the borrow rate.
//
// These helpers update a basket's legs in place: one basket is owned by one
// simulation's daily loop, and copying it every day would cost allocations
// across every config of every sweep for nothing.

import type { EtfConfig } from "./types";
import { getRiskOffFetchTickers } from "../constants";
import { riskOffCloseMarkPrice, riskOffOpenTradePrice } from "./risk-off";

type RiskOffSeriesByAsset = Partial<Record<EtfConfig["riskOffAsset"], number[]>>;

/** Risk-off leg prices aligned to the simulation's trading days. */
export interface RiskOffPriceSeries {
  close?: RiskOffSeriesByAsset;
  open?: RiskOffSeriesByAsset;
}

export interface RiskOffBasket {
  tickers: string[];
  /** Units of each leg's price series. */
  shares: number[];
  /** Dollars held by a leg that had no price to trade at. */
  cash: number[];
}

function closeSeries(prices: RiskOffPriceSeries, ticker: string): number[] | undefined {
  return prices.close?.[ticker as EtfConfig["riskOffAsset"]];
}

function openSeries(prices: RiskOffPriceSeries, ticker: string): number[] | undefined {
  return prices.open?.[ticker as EtfConfig["riskOffAsset"]];
}

/** Daily return on a cash leg: the borrow rate, never negative. */
function idleCashDailyReturn(borrowRate: number): number {
  return borrowRate > 0 ? borrowRate : 0;
}

function openBasket(
  riskOffAsset: EtfConfig["riskOffAsset"],
  investableValue: number,
  entryPriceOf: (ticker: string) => number
): RiskOffBasket {
  const tickers = getRiskOffFetchTickers(riskOffAsset);
  const shares = new Array<number>(tickers.length).fill(0);
  const cash = new Array<number>(tickers.length).fill(0);
  const valuePerComponent = investableValue / tickers.length;
  for (let j = 0; j < tickers.length; j++) {
    const entryPrice = entryPriceOf(tickers[j]);
    if (Number.isFinite(entryPrice)) {
      shares[j] = valuePerComponent / entryPrice;
    } else {
      cash[j] = valuePerComponent;
    }
  }
  return { tickers, shares, cash };
}

/** Enter risk-off at day `dayIdx`'s open (next-day-open execution). */
export function openBasketAtOpen(
  riskOffAsset: EtfConfig["riskOffAsset"],
  investableValue: number,
  prices: RiskOffPriceSeries,
  dayIdx: number
): RiskOffBasket {
  return openBasket(riskOffAsset, investableValue, (ticker) =>
    riskOffOpenTradePrice({ openValues: openSeries(prices, ticker), closeValues: closeSeries(prices, ticker), index: dayIdx })
  );
}

/** Enter risk-off at the close of day `closeIdx` (close executions). */
export function openBasketAtClose(
  riskOffAsset: EtfConfig["riskOffAsset"],
  investableValue: number,
  prices: RiskOffPriceSeries,
  closeIdx: number
): RiskOffBasket {
  return openBasket(riskOffAsset, investableValue, (ticker) =>
    riskOffCloseMarkPrice({ closeValues: closeSeries(prices, ticker), index: closeIdx })
  );
}

/**
 * A leg whose close mark vanished: convert it to cash at `lastPrice` (1 per
 * unit when even that is missing), accrue one day, and return its value.
 */
function liquidateLegToCash(basket: RiskOffBasket, j: number, lastPrice: number, borrowRate: number): number {
  basket.cash[j] = basket.shares[j] * (Number.isFinite(lastPrice) ? lastPrice : 1);
  basket.shares[j] = 0;
  basket.cash[j] *= (1 + idleCashDailyReturn(borrowRate));
  return basket.cash[j];
}

/**
 * Close value on the day the basket was bought at the open. A cash leg earns
 * nothing for the part-day; a leg with no close mark falls back to its open
 * trade price.
 */
export function markBasketOnOpenEntryDay(
  basket: RiskOffBasket,
  prices: RiskOffPriceSeries,
  dayIdx: number,
  borrowRate: number
): number {
  let value = 0;
  for (let j = 0; j < basket.tickers.length; j++) {
    const ticker = basket.tickers[j];
    const closeValues = closeSeries(prices, ticker);
    if (basket.shares[j] > 0) {
      const markPrice = riskOffCloseMarkPrice({ closeValues, index: dayIdx });
      if (Number.isFinite(markPrice)) {
        value += basket.shares[j] * markPrice;
      } else {
        const lastPrice = riskOffOpenTradePrice({ openValues: openSeries(prices, ticker), closeValues, index: dayIdx });
        value += liquidateLegToCash(basket, j, lastPrice, borrowRate);
      }
    } else {
      value += basket.cash[j];
    }
  }
  return value;
}

/**
 * Close value of a basket held through day `dayIdx`. Cash legs accrue a day;
 * a leg whose close mark vanished converts to cash at the previous mark.
 * (No console warning on that fallback: this runs inside the daily loop across
 * every sweep config and would flood the console; it is the designed handling.)
 */
export function markBasketAtClose(
  basket: RiskOffBasket,
  prices: RiskOffPriceSeries,
  dayIdx: number,
  borrowRate: number
): number {
  let value = 0;
  for (let j = 0; j < basket.tickers.length; j++) {
    const closeValues = closeSeries(prices, basket.tickers[j]);
    if (basket.shares[j] > 0) {
      const markPrice = riskOffCloseMarkPrice({ closeValues, index: dayIdx });
      if (Number.isFinite(markPrice)) {
        value += basket.shares[j] * markPrice;
      } else {
        const lastPrice = riskOffCloseMarkPrice({ closeValues, index: dayIdx - 1 });
        value += liquidateLegToCash(basket, j, lastPrice, borrowRate);
      }
    } else {
      basket.cash[j] *= (1 + idleCashDailyReturn(borrowRate));
      value += basket.cash[j];
    }
  }
  return value;
}

/** Value of the basket at day `dayIdx`'s open, when it is sold to re-enter risk-on. */
export function valueBasketAtOpen(basket: RiskOffBasket, prices: RiskOffPriceSeries, dayIdx: number): number {
  return basket.tickers.reduce((sum, ticker, j) => {
    const openPrice = riskOffOpenTradePrice({
      openValues: openSeries(prices, ticker),
      closeValues: closeSeries(prices, ticker),
      index: dayIdx,
    });
    if (basket.shares[j] > 0) {
      if (Number.isFinite(openPrice)) return sum + basket.shares[j] * openPrice;
      return sum + basket.shares[j];
    }
    return sum + (basket.cash[j] ?? 0);
  }, 0);
}
