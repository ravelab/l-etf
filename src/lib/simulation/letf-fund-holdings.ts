// What the UPRO/TQQQ fund holds at each close, by ticker: each sleeve's LETF while
// it is risk-on, and its risk-off basket's legs while it is out.
//
// The fund's own composition (letf-dual-sleeve.ts) tracks each sleeve's dollars.
// Within a sleeve, the engine (single-etf-risk-off.ts) buys the basket in equal
// dollars per leg at the open of the first risk-off day (the first close for a run
// that starts risk-off) and then holds those units untouched, so a leg's share on a
// later close is its units times that close, read off the same aligned prices.
// A leg with no price to buy at holds dollars; it is shown as Cash.

import { getRiskOffFetchTickers } from "@/lib/constants";
import { alignCloseSeriesToDates, alignOpenSeriesToDates } from "@/lib/utils";
import {
  alignLetfComboSleeves,
  composeLetfFundPath,
  findLetfComboSleeves,
  heldRiskOnByDay,
  toLetfFundPathSleeves,
  type LetfComboRun,
} from "./letf-dual-sleeve";
import { riskOffCloseMarkPrice, riskOffOpenTradePrice } from "./risk-off";
import type { BacktestResult, EtfResult, PricePoint } from "./types";

export const FUND_CASH_ASSET = "Cash";

/** Dollars per asset at each close; the entries add up to the line's (or fund's) value. */
export type LetfFundHoldings = {
  dates: string[];
  /** Assets in display order: each sleeve's LETF then its basket legs, `Cash` last. */
  assets: string[];
  values: Readonly<Record<string, readonly number[]>>;
  /** Fund days on which both sleeves had been risk-off and the fund reset to 50/50 (none for one sleeve). */
  resetDates: string[];
};

type LegShare = Readonly<Record<string, number>>;

/** Aligned close/open series for one leg on the sleeve's own dates. */
function legSeries(dates: string[], points: PricePoint[] | undefined) {
  if (!points?.length) return { close: undefined, open: undefined };
  const reference = dates.map((date) => ({ date }) as PricePoint);
  return {
    close: alignCloseSeriesToDates(reference, points),
    open: alignOpenSeriesToDates(reference, points),
  };
}

/**
 * Each sleeve day's split of the sleeve's value by asset (fractions summing to 1):
 * the LETF on a risk-on day, the basket's legs on a risk-off day.
 */
export function sleeveShareByDay(
  sleeve: Pick<EtfResult, "dates" | "smaSignals" | "smaStartInvested">,
  letfName: string,
  riskOffAsset: string,
  pricesByTicker: Record<string, PricePoint[]>
): LegShare[] {
  const held = heldRiskOnByDay(sleeve);
  const tickers = getRiskOffFetchTickers(riskOffAsset);
  const series = tickers.map((ticker) => legSeries(sleeve.dates, pricesByTicker[ticker]));
  let entryPrices: number[] = [];

  return held.map((riskOn, i) => {
    if (riskOn) return { [letfName]: 1 };
    if (i === 0 || held[i - 1]) {
      // Bought at this day's open after a sell signal; a run that starts out holds
      // what its first close established.
      entryPrices = series.map((leg) => i === 0
        ? riskOffCloseMarkPrice({ closeValues: leg.close, index: 0 })
        : riskOffOpenTradePrice({ openValues: leg.open, closeValues: leg.close, index: i }));
    }
    const legValues = tickers.map((ticker, j) => {
      const entry = entryPrices[j];
      if (!Number.isFinite(entry) || entry <= 0) return { asset: FUND_CASH_ASSET, value: 1 };
      const mark = riskOffCloseMarkPrice({ closeValues: series[j].close, index: i, lastPrice: entry });
      return { asset: ticker, value: mark / entry };
    });
    const total = legValues.reduce((sum, leg) => sum + leg.value, 0);
    const share: Record<string, number> = {};
    for (const leg of legValues) share[leg.asset] = (share[leg.asset] ?? 0) + leg.value / total;
    return share;
  });
}

/**
 * Each sleeve's LETF followed by its own basket legs, sleeve by sleeve, `Cash`
 * last: a sleeve's switch then trades places inside one region of the stack.
 */
function orderAssets(seen: Set<string>, sleeveAssets: ReadonlyArray<readonly string[]>): string[] {
  const ordered = [...new Set(sleeveAssets.flat())].filter((asset) => seen.has(asset) && asset !== FUND_CASH_ASSET);
  return [...ordered, ...(seen.has(FUND_CASH_ASSET) ? [FUND_CASH_ASSET] : [])];
}

/**
 * The fund's holdings by ticker, or null when the run has no UPRO/TQQQ fund. Built
 * from the same sleeves and composition as the fund row, so the entries add up to
 * the fund's daily values.
 */
export function letfComboFundHoldings(
  result: BacktestResult | null,
  run: LetfComboRun | null,
  pricesByTicker: Record<string, PricePoint[]>
): LetfFundHoldings | null {
  const found = findLetfComboSleeves(result, run);
  if (!found || !run) return null;
  const { sleeves, letfNames } = alignLetfComboSleeves({ ...found, ...run });
  if (sleeves.some(({ result: r }) => r.dates.length < 2 || !(r.dailyValues[0] > 0))) return null;
  if (sleeves[0].result.dates[0] !== sleeves[1].result.dates[0]) return null;

  const { dates, sleeves: pathSleeves } = toLetfFundPathSleeves(sleeves[0], sleeves[1]);
  const { sleeveTracks, taxEvents } = composeLetfFundPath(pathSleeves, 0, dates.length, dates, true);
  if (!sleeveTracks) return null;
  const shares = sleeves.map(({ result: r, riskOffAsset }, s) =>
    sleeveShareByDay(r, letfNames[s], riskOffAsset, pricesByTicker));

  const seen = new Set<string>();
  const byDay = dates.map((_, k) => {
    const day: Record<string, number> = {};
    sleeveTracks.forEach((track, s) => {
      for (const [asset, fraction] of Object.entries(shares[s][track.dayIndex[k]] ?? {})) {
        day[asset] = (day[asset] ?? 0) + track.values[k] * fraction;
        seen.add(asset);
      }
    });
    return day;
  });
  const assets = orderAssets(seen, sleeves.map(({ riskOffAsset }, s) => [letfNames[s], ...getRiskOffFetchTickers(riskOffAsset)]));
  return {
    dates,
    assets,
    values: Object.fromEntries(assets.map((asset) => [asset, byDay.map((day) => day[asset] ?? 0)])),
    resetDates: (taxEvents ?? []).filter((event) => event.reset).map((event) => event.date),
  };
}

/**
 * One LETF line's holdings: its LETF while risk-on, its basket legs while out,
 * adding up to the line's own daily values. Null for a line too short to chart.
 */
export function letfSleeveHoldings(
  sleeve: Pick<EtfResult, "dates" | "dailyValues" | "smaSignals" | "smaStartInvested">,
  letfName: string,
  riskOffAsset: string,
  pricesByTicker: Record<string, PricePoint[]>
): LetfFundHoldings | null {
  if (sleeve.dates.length < 2) return null;
  const shares = sleeveShareByDay(sleeve, letfName, riskOffAsset, pricesByTicker);
  const seen = new Set(shares.flatMap((day) => Object.keys(day)));
  const assets = orderAssets(seen, [[letfName, ...getRiskOffFetchTickers(riskOffAsset)]]);
  return {
    dates: sleeve.dates,
    assets,
    values: Object.fromEntries(assets.map((asset) => [
      asset,
      shares.map((day, i) => (sleeve.dailyValues[i] ?? 0) * (day[asset] ?? 0)),
    ])),
    resetDates: [],
  };
}
