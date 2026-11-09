import type { EtfConfig, IndexKey, SmaSignal } from "./types";
import { NDX_THREE_GATE_RULE } from "./three-gate";
import { NDX_SMA_VOL_ARGMAX_RULE } from "./sma-vol-argmax";

/**
 * Plug-in timing rules: anything that decides "hold the LETF or sit in risk-off"
 * from the index closes, run by the engine in place of the SMA band.
 *
 * To offer a rule on the backtest page, implement `SignalRule` (usually in its own
 * file, like `three-gate.ts`) and add it to `BUILT_IN_SIGNAL_RULES`. It then appears
 * in the page's "Extra Strategies" picker; ticking it adds one more line beside each
 * matching SMA line, on the same LETF and risk-off asset, so the two differ only in
 * timing. None are ticked by default, and the canned snapshot uses that default.
 *
 * Everything else (execution at the next open, spreads, risk-off holdings, the
 * results table and chart) is the engine's usual SMA path.
 */
/** The SMA line a rule line twins; a rule may reuse its band or ignore it. */
export type SignalRuleLine = Pick<EtfConfig, "smaIndex" | "smaPeriod" | "smaUpperBuffer" | "smaLowerBuffer">;

export interface SignalRule {
  /** Stable key stored in `EtfConfig.signalRule`. */
  id: string;
  /** Shown in place of "SMA" in the line's name, e.g. "TQQQ <label>". */
  label: string;
  /** Option name in the Extra Strategies picker. */
  title: string;
  /** One or two sentences for the picker's help text. */
  description: string;
  /** Where the rule comes from, linked from the picker. */
  sourceUrl?: string;
  /**
   * Trading days of history the rule needs before its first decision. The line
   * loads the larger of this and its own SMA period.
   */
  warmUpDays: number;
  /** Indices it applies to; all when omitted. */
  indices?: readonly IndexKey[];
  /**
   * Regime decided at each close (true = hold the LETF), one entry per date.
   * The engine acts on a change at the next session, like an SMA signal.
   */
  regime: (dates: string[], closes: number[], line: SignalRuleLine) => boolean[];
  /** The SMA to draw on the line's details chart, for rules built on one. */
  smaValues?: (dates: string[], closes: number[], line: SignalRuleLine) => number[];
}

/** Registered rules, in picker order. Plug new ones in here. */
const BUILT_IN_SIGNAL_RULES: readonly SignalRule[] = [NDX_THREE_GATE_RULE, NDX_SMA_VOL_ARGMAX_RULE];

/** Extra strategies ticked by default on the backtest page (and in its canned snapshot). */
export const DEFAULT_EXTRA_STRATEGY_IDS: readonly string[] = [];

const registry = new Map<string, SignalRule>(BUILT_IN_SIGNAL_RULES.map((rule) => [rule.id, rule]));

/** Add a rule at runtime (tests, experiments); returns a function that removes it. */
export function registerSignalRule(rule: SignalRule): () => void {
  if (registry.has(rule.id)) throw new Error(`Signal rule "${rule.id}" is already registered`);
  registry.set(rule.id, rule);
  return () => {
    if (registry.get(rule.id) === rule) registry.delete(rule.id);
  };
}

export function getSignalRule(id: string): SignalRule {
  const rule = registry.get(id);
  if (!rule) throw new Error(`Unknown signal rule "${id}"`);
  return rule;
}

export function listSignalRules(): SignalRule[] {
  return [...registry.values()];
}

/**
 * Registered ids from untrusted input (stored form, URL), deduped and in picker
 * order; anything else is dropped rather than failing the page.
 */
export function normalizeExtraStrategyIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  const wanted = new Set(ids.filter((id): id is string => typeof id === "string"));
  return listSignalRules().map((rule) => rule.id).filter((id) => wanted.has(id));
}

/** URL key carrying the ticked extra strategies, comma-separated, so links reproduce a run. */
const EXTRA_STRATEGIES_URL_KEY = "xs";

export function appendExtraStrategiesUrlParam(params: URLSearchParams, ids: readonly string[]): void {
  if (ids.length > 0) params.set(EXTRA_STRATEGIES_URL_KEY, ids.join(","));
}

/** An absent key means none: a shared link describes the whole run. */
export function parseExtraStrategiesUrlParam(params: URLSearchParams): string[] {
  return normalizeExtraStrategyIds(params.get(EXTRA_STRATEGIES_URL_KEY)?.split(",") ?? []);
}

/** Whether `label` names a registered rule (for parsing result names back). */
export function isSignalRuleLabel(label: string): boolean {
  for (const rule of registry.values()) if (rule.label === label) return true;
  return false;
}

/** Run a rule into the same shape `generateSmaSignals` returns. */
export function runSignalRule(
  rule: SignalRule,
  dates: string[],
  closes: number[],
  line: SignalRuleLine
): { signals: SmaSignal[]; smaValues: number[]; invested: boolean[] } {
  const invested = rule.regime(dates, closes, line);
  if (invested.length !== dates.length) {
    throw new Error(`Signal rule "${rule.id}" returned ${invested.length} decisions for ${dates.length} dates`);
  }
  const signals: SmaSignal[] = [];
  for (let i = 1; i < invested.length; i++) {
    if (invested[i] !== invested[i - 1]) {
      signals.push({ date: dates[i], type: invested[i] ? "buy" : "sell", price: closes[i] });
    }
  }
  // Always a full-length series: the page shows a line's details (chart and trade
  // dates) only when it has one. NaN draws no SMA for rules without one.
  const smaValues = rule.smaValues?.(dates, closes, line) ?? new Array<number>(dates.length).fill(Number.NaN);
  if (smaValues.length !== dates.length) {
    throw new Error(`Signal rule "${rule.id}" returned ${smaValues.length} SMA values for ${dates.length} dates`);
  }
  return { signals, smaValues, invested };
}

/** Trading days of data a line needs before the display start. */
export function lineWarmUpDays(cfg: Pick<EtfConfig, "smaEnabled" | "smaPeriod" | "signalRule">): number {
  if (!cfg.smaEnabled) return 0;
  return cfg.signalRule ? Math.max(cfg.smaPeriod, getSignalRule(cfg.signalRule).warmUpDays) : cfg.smaPeriod;
}

/**
 * The page's configs plus, for each rule id, a twin of every simulated SMA line
 * the rule applies to. A twin keeps its line's SMA band (for rules that reuse it)
 * and turns `smaVolGate` off, since the rule owns every gate. Twins are appended
 * after the page's own configs so their ids (and the UPRO+TQQQ fund's etf1/etf2
 * sleeves) keep their places.
 */
export function withSignalRuleLines(configs: EtfConfig[], ruleIds: readonly string[]): EtfConfig[] {
  const twins = ruleIds.flatMap((id) => {
    const rule = getSignalRule(id);
    return configs
      .filter((cfg) => cfg.simulated && cfg.smaEnabled && !cfg.signalRule)
      .filter((cfg) => !rule.indices || rule.indices.includes(cfg.smaIndex))
      .map((cfg) => ({ ...cfg, signalRule: rule.id, smaVolGate: false }));
  });
  return [...configs, ...twins.map((cfg, k) => ({ ...cfg, id: `etf${configs.length + k + 1}` }))];
}
