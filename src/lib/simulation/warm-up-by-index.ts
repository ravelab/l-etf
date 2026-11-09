import type { EtfConfig, IndexKey } from "./types";
import { lineWarmUpDays } from "./signal-rules";

/**
 * Where to start loading each index's data for one backtest run.
 *
 * The SMA configs share one warm-up, sized by the longest SMA period anywhere in
 * the run, exactly as before any `signalRule` line existed: the SMA band, vol gate
 * and RSI brake all carry state from the first loaded close, so a longer warm-up
 * can move an existing line (it moved UPRO's 1988 run by 0.6%). A `signalRule`
 * config that needs more history extends only its own index's warm-up.
 *
 * `earliest` is the start for the shared inputs (rates, risk-off, ETF prices).
 */
export function warmUpStartDatesByIndex(
  configs: ReadonlyArray<Pick<EtfConfig, "smaIndex" | "smaEnabled" | "smaPeriod" | "signalRule">>,
  displayStartDate: string,
  warmUpStart: (startDate: string, warmUpTradingDays: number) => string
): { byIndex: Partial<Record<IndexKey, string>>; earliest: string } {
  const shared = Math.max(0, ...configs.filter((cfg) => !cfg.signalRule).map(lineWarmUpDays));
  const byIndex: Partial<Record<IndexKey, string>> = {};
  for (const index of new Set(configs.map((cfg) => cfg.smaIndex))) {
    const ruleDays = configs.filter((cfg) => cfg.smaIndex === index && cfg.signalRule).map(lineWarmUpDays);
    byIndex[index] = warmUpStart(displayStartDate, Math.max(shared, ...ruleDays));
  }
  const starts = Object.values(byIndex).sort();
  return { byIndex, earliest: starts[0] ?? warmUpStart(displayStartDate, shared) };
}
