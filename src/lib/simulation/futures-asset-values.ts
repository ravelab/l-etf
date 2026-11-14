import type { IndexKey } from "@/lib/simulation/types";
import { familyOfSymbol } from "@/lib/simulation/futures-contracts";
import type { FuturesSleeve } from "@/lib/simulation/futures-types";

/**
 * Where the account's money sits at each close, in dollars, one entry per date of
 * the result it rides on (`etfResult.dates`): each index's futures margin cash, every
 * ETF at market, and the rest as `Cash`. The entries add up to the account's equity.
 * Futures notional is exposure rather than money held, so it is not an entry.
 */
export type DailyAssetValues = Readonly<Record<string, readonly number[]>>;

/** One sleeve's book at a close, as the composition splits it. */
export type SleeveCloseSnapshot = {
  index: IndexKey;
  /** Ledger-shaped positions: futures notional by listing, ETFs at market. */
  positions: Readonly<Record<string, number>>;
  /**
   * Cash in the futures (commodities) account: the margin requirement plus its
   * buffer and the P&L since the last sweep. Absent without the Treasury account model.
   */
  marginCash?: number;
  equity: number;
};

export const CASH_ASSET = "Cash";

const MARGIN_CASH_LABEL: Readonly<Record<IndexKey, string>> = {
  sp500: "SPX margin cash",
  nasdaq100: "NDX margin cash",
};

/**
 * Under a dollar is float residue of a position sold down to nothing (SGOV-first
 * sales, in-kind sleeve splits leave ~1e-60), not a holding. The ledger's Assets
 * cell drops it by the same rule; on a log axis it would plot as a cliff. Larger
 * negatives are kept: `Cash` runs a short debit when Treasuries are bought ahead of
 * the next sweep, and dropping it would stop the entries adding up to equity.
 */
const MIN_HELD_VALUE = 1;

/** Margin cash first (SPX, NDX), then ETFs by ticker, `Cash` last. */
function assetRank(asset: string): number {
  if (asset === MARGIN_CASH_LABEL.sp500) return 0;
  if (asset === MARGIN_CASH_LABEL.nasdaq100) return 1;
  return asset === CASH_ASSET ? 3 : 2;
}

function compareAssets(a: string, b: string): number {
  return assetRank(a) - assetRank(b) || a.localeCompare(b);
}

export function sleeveCloseSnapshot(index: IndexKey, sleeve: FuturesSleeve, day: number): SleeveCloseSnapshot {
  const { commoditiesCash } = sleeve.readHoldings();
  return {
    index,
    positions: sleeve.positions(),
    ...(commoditiesCash !== undefined ? { marginCash: commoditiesCash } : {}),
    equity: sleeve.equityAt(day),
  };
}

/** The account's dollars at one close, by asset; sums to the sleeves' equity. */
export function accountComposition(sleeves: readonly SleeveCloseSnapshot[]): Record<string, number> {
  const held: Record<string, number> = {};
  for (const sleeve of sleeves) {
    for (const [symbol, value] of Object.entries(sleeve.positions)) {
      if (familyOfSymbol(symbol) != null || !Number.isFinite(value)) continue;
      held[symbol] = (held[symbol] ?? 0) + value;
    }
    if (sleeve.marginCash !== undefined && Number.isFinite(sleeve.marginCash)) {
      const label = MARGIN_CASH_LABEL[sleeve.index];
      held[label] = (held[label] ?? 0) + sleeve.marginCash;
    }
  }
  const equity = sleeves.reduce((sum, sleeve) => sum + sleeve.equity, 0);
  const cash = equity - Object.values(held).reduce((sum, value) => sum + value, 0);
  return Object.fromEntries(
    Object.entries({ ...held, [CASH_ASSET]: cash }).filter(([, value]) => Math.abs(value) >= MIN_HELD_VALUE)
  );
}

/**
 * One series per asset ever held, zero on days it was not. `days[k]` is the
 * by-asset map of day `k`.
 */
export function toDailyAssetValues(days: ReadonlyArray<Readonly<Record<string, number>>>): DailyAssetValues {
  const assets = [...new Set(days.flatMap((day) => Object.keys(day)))].sort(compareAssets);
  return Object.fromEntries(assets.map((asset) => [asset, days.map((day) => day[asset] ?? 0)]));
}

/** Collects each close's composition; `values()` returns what was collected so far. */
export function createAssetValueRecorder(): {
  record: (sleeves: readonly SleeveCloseSnapshot[]) => void;
  values: () => DailyAssetValues;
} {
  const days: Array<Record<string, number>> = [];
  return {
    record: (sleeves) => {
      days.push(accountComposition(sleeves));
    },
    values: () => toDailyAssetValues(days),
  };
}
