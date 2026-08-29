export const RISK_OFF_ASSET_OPTIONS = [
  {
    value: "SGOV",
    label: "SGOV (0-3M Treasury)",
  },
  {
    value: "VGSH",
    label: "VGSH (1-3Y Treasury)",
  },
  {
    value: "GLDM",
    label: "GLDM (Gold)",
  },
  {
    value: "BRK.B",
    label: "BRK.B",
  },
  {
    value: "VOO",
    label: "VOO",
  },
  {
    value: "QQQ",
    label: "QQQ",
  },
  {
    value: "BRK.B+GLDM",
    label: "BRK.B + GLDM",
  },
  {
    value: "VGSH+GLDM",
    label: "VGSH + GLDM",
  },
  {
    value: "BRK.B+VGSH",
    label: "BRK.B + VGSH",
  },
  {
    value: "BRK.B+GLDM+VGSH",
    label: "BRK.B + GLDM + VGSH",
  },
] as const;

export const CONSTANT_SP500_START_DATE = "1885-03-20";
export const CONSTANT_NASDAQ100_START_DATE = "1971-02-05";
/** Calendar icon shortcut: first day of the rules-based large-cap proxy. From
 *  here to CONSTANT_SP500_SHORTCUT_DATE the S&P series is replaced by the
 *  Fama-French cap-weighted basket of the market's biggest 30% by size
 *  (FF_SPLICE_START in scripts/fetch-data.ts); everything earlier is the
 *  Cowles-era reconstruction. */
export const CONSTANT_SP500_PROXY_START_DATE = "1926-07-01";
/** Calendar icon shortcut: earliest meaningful start for S&P 500 strategies.
 *  1988-04-06 is when S&P stopped using sector quotas to choose constituents. */
export const CONSTANT_SP500_SHORTCUT_DATE = "1988-04-06";
/** Calendar icon shortcut: earliest meaningful start for Nasdaq 100 strategies */
export const CONSTANT_NASDAQ100_SHORTCUT_DATE = "1985-01-31";

/** Unleveraged index total-return series (Strategies tab + Backtest charts/tables). */
export const LABEL_INDEX_SP500_TR = "VOO";
export const LABEL_INDEX_NASDAQ100_TR = "QQQ";

/**
 * Per-symbol bid-ask half-spread as a fraction of price (NOT a percentage).
 * e.g. 0.0001 = 0.01% = 1 basis point.
 * Regular hours = market open; after hours = extended-hours session.
 *
 * Methodology: estimates based on typical bid-ask spreads observed for each
 * symbol, divided by 2 (half-spread = cost per side of a trade).
 *
 * Risk-on leveraged ETFs:
 *   TQQQ — highest volume LETF (~150M shares/day), penny spread → ~1 bp regular.
 *   UPRO — very high volume (~30M shares/day), penny spread → ~1 bp regular.
 *   QLD  — moderate volume (~5M shares/day), slightly wider → ~2 bp regular.
 *   SSO  — moderate volume (~3M shares/day), similar to QLD → ~2 bp regular.
 *
 * Risk-off:
 *   SGOV — ultra-short T-bill ETF, tight institutional spread → ~1 bp regular.
 *   VGSH — short-term treasury, moderate volume → ~2 bp regular.
 *   GLDM — gold ETF, moderate volume (~5M shares/day) → ~2 bp regular.
 *   BRK.B — high volume (~4M shares/day), tight spread → ~1 bp regular.
 *   VOO  — very liquid S&P 500 ETF → ~1 bp regular.
 *   QQQ  — very liquid Nasdaq 100 ETF → ~1 bp regular.
 *
 * After-hours multipliers: spreads widen ~4-5x for liquid names (TQQQ, UPRO,
 * BRK.B, SGOV) and ~3-4x for less liquid names due to thinner order books.
 */
const SPREAD_COSTS: Record<string, { regularHours: number; afterHours: number }> = {
  // Risk-on (leveraged ETFs)
  TQQQ: { regularHours: 0.0001, afterHours: 0.0010 },  // ~$0.01 on ~$60
  UPRO: { regularHours: 0.0001, afterHours: 0.0010 },  // ~$0.01 on ~$80
  QLD:  { regularHours: 0.0002, afterHours: 0.0012 },  // ~$0.02 on ~$95
  SSO:  { regularHours: 0.0002, afterHours: 0.0012 },  // ~$0.02 on ~$90
  // Risk-off
  SGOV:    { regularHours: 0.0001, afterHours: 0.0006 },  // ~$0.01 on ~$100
  VGSH:    { regularHours: 0.0002, afterHours: 0.0008 },  // ~$0.01 on ~$58
  GLDM:    { regularHours: 0.0002, afterHours: 0.0010 },  // ~$0.01 on ~$50
  "BRK.B": { regularHours: 0.0002, afterHours: 0.0008 },  // ~$0.05 on ~$480
  VOO:     { regularHours: 0.0001, afterHours: 0.0006 },  // ~$0.01 on ~$500
  QQQ:     { regularHours: 0.0001, afterHours: 0.0008 },  // ~$0.01 on ~$500
};

/**
 * Returns the half-spread cost (fraction) for a single symbol.
 * Handles strategy names/IDs by stripping common suffixes.
 */
export function getSymbolSpread(symbol: string, afterHours: boolean): number {
  const field = afterHours ? "afterHours" : "regularHours";
  const ticker = symbol
    .split(" ")[0]            // Get first word (e.g. "UPRO")
    .replace(/-real$/, "")
    .replace(/-base$/, "")
    .replace(/-sma.*$/, "")
    .replace(/^(SPX|S&P)$/, "VOO")    // Map "SPX" / legacy "S&P 500" -> VOO
    .replace(/^(NDX|Nasdaq)$/, "QQQ"); // Map "NDX" / legacy "Nasdaq 100" -> QQQ
  return SPREAD_COSTS[ticker]?.[field] ?? 0;
}

/**
 * Returns the average half-spread cost (fraction) for a (possibly composite) risk-off asset.
 */
export function getRiskOffSpread(riskOffAsset: string, afterHours: boolean): number {
  const riskOffTickers = getRiskOffFetchTickers(riskOffAsset);
  let sum = 0;
  for (const ticker of riskOffTickers) {
    sum += getSymbolSpread(ticker, afterHours);
  }
  return sum / Math.max(1, riskOffTickers.length);
}

/**
 * Computes the total spread cost for a risk-on ↔ risk-off transition.
 * Returns a fraction (e.g. 0.0003) representing the combined half-spread
 * of selling one side and buying the other.
 */
function getTransitionSpreadCost(
  riskOnSymbol: string,
  riskOffAsset: string,
  afterHours: boolean,
): number {
  return getSymbolSpread(riskOnSymbol, afterHours) + getRiskOffSpread(riskOffAsset, afterHours);
}

/**
 * Per-transition spread cost for a strategy config — the single owner of
 * risk-on ticker resolution. Resolves from `config.name` (matching the
 * entry/exit spread paths), never `config.id`: sweep and backtest configs
 * carry ids like "buffer-2.5" or "etf1" that name no ticker and would
 * silently resolve the risk-on half-spread to 0.
 */
export function getTransitionSpreadCostForConfig(
  config: { name: string; riskOffAsset: string },
  afterHours: boolean,
): number {
  return getTransitionSpreadCost(config.name, config.riskOffAsset, afterHours);
}

export const CONSTANT_INITIAL_INVESTMENT = 1;

export const CONSTANT_SMA_CHECK_FREQUENCY = 1;
export const CONSTANT_STEP_MONTHS = 1;

/**
 * History wrap is always enabled. The legacy user-controllable toggle (and `tw`
 * URL param) was removed; the simulation engine always wraps when a window
 * extends past the last trade date so recent starting months still produce
 * full-length windows.
 */
export const CONSTANT_HISTORY_WRAP_ENABLED = true;

export const CHART_COLORS = {
  nonLeveraged: "#ffffff",
  invested: "#6b7280",
  etf: ["#16f3ce", "#ef4444", "#eab308", "#3b82f6"],
} as const;

/**
 * Returns the underlying asset tickers that need to be fetched for a risk-off asset.
 * Composite assets (e.g. "BRK.B+GLDM") return multiple tickers.
 */
export function getRiskOffFetchTickers(asset: string): string[] {
  if (asset.includes("+")) return asset.split("+");
  return [asset];
}

/**
 * Short label for liquidation copy on composite risk-off (e.g. BRK.B+GLDM+VGSH → B+G+V).
 * Single-ticker presets return the ticker unchanged.
 */
export function formatRiskOffLiquidationAbbrev(asset: string): string {
  if (!asset.includes("+")) return asset;
  return asset
    .split("+")
    .map((t) => {
      if (t === "BRK.B") return "B";
      if (t === "GLDM") return "G";
      if (t === "VGSH") return "V";
      if (t === "SGOV") return "S";
      return t;
    })
    .join("+");
}

export const INDEX_DATE_RANGES: Record<string, { min: string; max: string }> = {
  sp500: { min: CONSTANT_SP500_START_DATE, max: "2099-12-31" },
  nasdaq100: { min: CONSTANT_NASDAQ100_START_DATE, max: "2099-12-31" },
};
