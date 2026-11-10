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
/** Earliest Nasdaq row, and the first day of the NDX proxy: from here to
 *  CONSTANT_NASDAQ100_SHORTCUT_DATE the Nasdaq series is Ken French's Business
 *  Equipment industry (scripts/build-ndx-proxy.py), which matches NDX's
 *  volatility and trend. Unlike SPX, NDX has no older proto era. The date preset
 *  shares the SPX proxy's entry, since both proxies start the same day. */
export const CONSTANT_NASDAQ100_START_DATE = "1926-07-01";
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
 *
 * Regular hours for the LETFs and risk-off assets instead model the user's
 * execution: a marketable limit order priced LIMIT_ORDER_OFFSET_DOLLARS through
 * the quote, filled at that limit. The dollar offset becomes a fraction via
 * each ticker's closing share price on 2026-11-09; refresh the prices when they
 * drift far (e.g. after a reverse split).
 */
export const LIMIT_ORDER_OFFSET_DOLLARS = 0.02;
const LIMIT_ORDER_REFERENCE_PRICES: Record<string, number> = {
  TQQQ: 57.58,
  UPRO: 137.91,
  QLD: 79.15,
  SSO: 66.85,
  SGOV: 100.5,
  VGSH: 57.83,
  GLDM: 81.91,
  "BRK.B": 569, // BRK-A 853,500 / 1,500
};
const limitOrderCost = (ticker: string) =>
  LIMIT_ORDER_OFFSET_DOLLARS / LIMIT_ORDER_REFERENCE_PRICES[ticker];

const SPREAD_COSTS: Record<string, { regularHours: number; afterHours: number }> = {
  // Risk-on (leveraged ETFs)
  TQQQ: { regularHours: limitOrderCost("TQQQ"), afterHours: 0.0010 },
  UPRO: { regularHours: limitOrderCost("UPRO"), afterHours: 0.0010 },
  QLD:  { regularHours: limitOrderCost("QLD"), afterHours: 0.0012 },
  SSO:  { regularHours: limitOrderCost("SSO"), afterHours: 0.0012 },
  // Risk-off
  SGOV:    { regularHours: limitOrderCost("SGOV"), afterHours: 0.0006 },
  VGSH:    { regularHours: limitOrderCost("VGSH"), afterHours: 0.0008 },
  GLDM:    { regularHours: limitOrderCost("GLDM"), afterHours: 0.0010 },
  "BRK.B": { regularHours: limitOrderCost("BRK.B"), afterHours: 0.0008 },
  VOO:     { regularHours: 0.0001, afterHours: 0.0006 },  // ~$0.01 on ~$500
  QQQ:     { regularHours: 0.0001, afterHours: 0.0008 },  // ~$0.01 on ~$500
};

/** SEC Section 31 fee on sale proceeds: $20.60 per million from 2026-04-04. */
export const SEC_SECTION_31_FEE_RATE = 20.6 / 1_000_000;
/**
 * FINRA Trading Activity Fee per share sold (2026 schedule; paused Oct-Dec 2026,
 * resumes 2027-01-01). Its $9.79 per-trade cap is ignored, which overcharges
 * only sales above ~50k shares, by cents.
 */
export const FINRA_TAF_PER_SHARE = 0.000195;

/**
 * Both regulatory fees apply to sells only. Every round trip sells each asset
 * once, so half the sell fee is charged on each side of every trade; tickers
 * without a reference price pay the SEC fee alone (their TAF is under 0.01 bp).
 */
function regulatoryFeePerSide(ticker: string): number {
  const price = LIMIT_ORDER_REFERENCE_PRICES[ticker];
  const taf = price ? FINRA_TAF_PER_SHARE / price : 0;
  return (SEC_SECTION_31_FEE_RATE + taf) / 2;
}

/**
 * Returns the per-side trading cost (fraction) for a single symbol: the
 * half-spread or limit-order offset plus half the sell-side regulatory fees.
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
  const spread = SPREAD_COSTS[ticker]?.[field];
  return spread == null ? 0 : spread + regulatoryFeePerSide(ticker);
}

/**
 * Futures collateral (SGOV/VGSH) maintenance is not time-sensitive, so it is
 * placed one cent through the quote rather than LIMIT_ORDER_OFFSET_DOLLARS.
 */
export const COLLATERAL_LIMIT_ORDER_OFFSET_DOLLARS = 0.01;

/** Per-side cost (fraction) of a collateral order: the 1-cent limit offset plus half the sell fees. */
export function getCollateralTradeCost(ticker: "SGOV" | "VGSH"): number {
  return COLLATERAL_LIMIT_ORDER_OFFSET_DOLLARS / LIMIT_ORDER_REFERENCE_PRICES[ticker] + regulatoryFeePerSide(ticker);
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

/** Every underlying ticker the given (possibly composite) risk-off assets need, once each. */
export function getRiskOffFetchTickersForAll(assets: readonly string[]): string[] {
  return [...new Set(assets.flatMap(getRiskOffFetchTickers))];
}

const RISK_OFF_TICKER_ABBREV: Readonly<Record<string, string>> = {
  "BRK.B": "B",
  GLDM: "G",
  VGSH: "V",
  SGOV: "S",
};

/** One-letter ledger label for a risk-off ticker (BRK.B → B); any other ticker keeps its name. */
export function riskOffTickerAbbrev(ticker: string): string {
  return RISK_OFF_TICKER_ABBREV[ticker] ?? ticker;
}

/**
 * Short label for liquidation copy on composite risk-off (e.g. BRK.B+GLDM+VGSH → B+G+V).
 * Single-ticker presets return the ticker unchanged.
 */
export function formatRiskOffLiquidationAbbrev(asset: string): string {
  if (!asset.includes("+")) return asset;
  return asset.split("+").map(riskOffTickerAbbrev).join("+");
}

export const INDEX_DATE_RANGES: Record<string, { min: string; max: string }> = {
  sp500: { min: CONSTANT_SP500_START_DATE, max: "2099-12-31" },
  nasdaq100: { min: CONSTANT_NASDAQ100_START_DATE, max: "2099-12-31" },
};
