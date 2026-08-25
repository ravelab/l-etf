import type { BacktestResult, EtfResult } from "./types";

/**
 * Select a backtest result by the config id the caller asked for.
 *
 * `expandEtfConfigs` splits an SMA config into `<id>-base` and `<id>-sma`, and
 * the engine then collapses configs that compute identically — most often the
 * `<id>-base` twins of several SMA configs on one LETF — down to a single
 * simulation, emitted once so charts draw no duplicate series. The ids that were
 * folded away live in `etfResultIdAliases`, so a bare
 * `etfResults.find(r => r.id === wanted)` returns undefined for them. Always go
 * through here instead (and never through `etfResults[0]`).
 */
export function findEtfResult(
  result: Pick<BacktestResult, "etfResults" | "etfResultIdAliases">,
  id: string
): EtfResult | undefined {
  const direct = result.etfResults.find((etf) => etf.id === id);
  if (direct) return direct;

  const canonicalId = result.etfResultIdAliases?.[id];
  if (canonicalId === undefined) return undefined;
  return result.etfResults.find((etf) => etf.id === canonicalId);
}
