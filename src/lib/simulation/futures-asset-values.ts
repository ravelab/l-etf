import { familyOfSymbol, isMicroFamily } from "@/lib/simulation/futures-contracts";

/**
 * End-of-day dollar value per asset, one entry per date of the result it rides on
 * (`etfResult.dates`). Futures are notional — contracts × multiplier × the close
 * mark — with MES/MNQ folded into ES/NQ, since a micro is the same exposure in a
 * smaller unit; risk-off and Treasury ETFs are marked at market. Cash is not an
 * asset here.
 */
export type DailyAssetValues = Readonly<Record<string, readonly number[]>>;

/**
 * Under a dollar is float residue of a position sold down to nothing (SGOV-first
 * sales, in-kind sleeve splits leave ~1e-60), not a holding. The ledger's Assets
 * cell drops it by the same rule; on a log axis it would plot as a cliff.
 */
const MIN_HELD_VALUE = 1;

/** Futures before ETFs, so the chart's legend reads exposure first. */
const ASSET_ORDER: readonly string[] = ["ES", "NQ"];

/** `ESZ25` and `MESZ25` → `ES`; any other symbol is its own asset. */
export function assetValueKey(symbol: string): string {
  const family = familyOfSymbol(symbol);
  if (family == null) return symbol;
  return isMicroFamily(family) ? family.slice(1) : family;
}

/** A ledger-shaped position map (dollars per symbol) summed by asset. */
export function positionsByAsset(positions: Readonly<Record<string, number>>): Record<string, number> {
  const summed = Object.entries(positions).reduce<Record<string, number>>((acc, [symbol, value]) => {
    if (!Number.isFinite(value) || value <= 0) return acc;
    const key = assetValueKey(symbol);
    return { ...acc, [key]: (acc[key] ?? 0) + value };
  }, {});
  return Object.fromEntries(Object.entries(summed).filter(([, value]) => value >= MIN_HELD_VALUE));
}

function compareAssets(a: string, b: string): number {
  const ra = ASSET_ORDER.indexOf(a);
  const rb = ASSET_ORDER.indexOf(b);
  if (ra !== rb) return (ra === -1 ? ASSET_ORDER.length : ra) - (rb === -1 ? ASSET_ORDER.length : rb);
  return a.localeCompare(b);
}

/**
 * One series per asset ever held, zero on days it was not. `days[k]` is the
 * by-asset map of day `k`.
 */
export function toDailyAssetValues(days: ReadonlyArray<Readonly<Record<string, number>>>): DailyAssetValues {
  const assets = [...new Set(days.flatMap((day) => Object.keys(day)))].sort(compareAssets);
  return Object.fromEntries(assets.map((asset) => [asset, days.map((day) => day[asset] ?? 0)]));
}

/** Collects a day's positions; `values()` returns what was collected so far. */
export function createAssetValueRecorder(): {
  record: (positions: Readonly<Record<string, number>>) => void;
  values: () => DailyAssetValues;
} {
  const days: Array<Record<string, number>> = [];
  return {
    record: (positions) => {
      days.push(positionsByAsset(positions));
    },
    values: () => toDailyAssetValues(days),
  };
}
