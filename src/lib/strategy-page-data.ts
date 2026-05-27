import { buildYearlyCpiInflation, sampleYearlyRealGrowth } from "@/lib/inflation";
import { LABEL_INDEX_NASDAQ100_TR, LABEL_INDEX_SP500_TR } from "@/lib/constants";
import { ETF_PRESETS } from "@/lib/simulation/presets";
import type { BacktestResult, EtfConfig } from "@/lib/simulation/types";

type StrategyYearlyGrowthSeries = {
  years: string[];
  series: Array<{ label: string; values: Array<number | null> }>;
  inflation?: Array<number | null>;
};

type StrategyVariant = {
  label: string;
  config: EtfConfig;
};

type StrategyVariantBuckets = {
  sp500Variants: StrategyVariant[];
  nasdaqVariants: StrategyVariant[];
};

export function normalizeStrategyLabel(label: string): string {
  return label
    .replace(/ SMA \(next open\)$/i, " SMA Next Open")
    .replace(/ SMA \(next close\)$/i, " SMA Next Close")
    .replace(/ SMA \(no\)$/i, " SMA Next Open")
    .replace(/ SMA \(nc\)$/i, " SMA Next Close")
    .replace(/ SMA$/i, " SMA Close")
    .replace(/^(SPX|S&P 500)$/i, "VOO")
    .replace(/^(NDX|Nasdaq 100)$/i, "QQQ");
}

/**
 * Compact labels for backtest value chart / results table (aligns with strategies tab: "UPRO", "TQQQ SMA").
 * Engine uses "NAME (No SMA)" and "NAME (SMA, risk-off…)".
 */
export function shortBacktestAssetLabel(fullName: string): string {
  const noSma = /^(.*) \(No SMA\)$/.exec(fullName);
  if (noSma) return noSma[1].trim();
  const sma = /^(.*) \(SMA,.*\)$/.exec(fullName);
  if (sma) return `${sma[1].trim()} SMA`;
  return fullName;
}

export function shouldIncludeStrategyChartLabel(label: string): boolean {
  const normalized = normalizeStrategyLabel(label);
  if (normalized === LABEL_INDEX_SP500_TR || normalized === LABEL_INDEX_NASDAQ100_TR) return true;
  if (normalized === "UPRO" || normalized === "TQQQ" || normalized === "SSO" || normalized === "QLD") return true;
  if (normalized === "UPRO SMA Next Open") return true;
  if (normalized === "TQQQ SMA Next Open") return true;
  if (normalized === "SSO SMA Next Open") return true;
  if (normalized === "QLD SMA Next Open") return true;
  return false;
}

export function buildStrategyVariants(params: {
  smaSpPeriod: number;
  smaNqPeriod: number;
  smaSpUpperBuffer: number;
  smaSpLowerBuffer: number;
  smaNqUpperBuffer: number;
  smaNqLowerBuffer: number;
  riskOffAsset: EtfConfig["riskOffAsset"];
  tradeAfterHours?: boolean;
}): StrategyVariantBuckets {
  const uproPreset = ETF_PRESETS["UPRO"];
  const tqqqPreset = ETF_PRESETS["TQQQ"];
  const ssoPreset = ETF_PRESETS["SSO"];
  const qldPreset = ETF_PRESETS["QLD"];

  const baseConfig = (
    preset: typeof uproPreset,
    smaEnabled: boolean,
    executionMode: EtfConfig["smaExecutionMode"] = "next-day-open"
  ): EtfConfig => ({
    id: `${preset.name}-${smaEnabled ? "sma" : "nosma"}${
      executionMode === "next-day-close" ? "-nextclose" :
      executionMode === "next-day-open" ? "-nextopen" :
      ""
    }`,
    name: preset.name,
    leverage: preset.leverage,
    expenseRatio: preset.expenseRatio,
    simulated: true,
    smaEnabled,
    smaPeriod: preset.index === "nasdaq100" ? params.smaNqPeriod : params.smaSpPeriod,
    smaUpperBuffer: preset.index === "nasdaq100" ? params.smaNqUpperBuffer : params.smaSpUpperBuffer, smaLowerBuffer: preset.index === "nasdaq100" ? params.smaNqLowerBuffer : params.smaSpLowerBuffer,
    smaIndex: preset.index,
    smaExecutionMode: executionMode,
    riskOffAsset: params.riskOffAsset,
  });

  const indexConfig = (indexName: typeof LABEL_INDEX_SP500_TR | typeof LABEL_INDEX_NASDAQ100_TR): EtfConfig => ({
    id: `index-${indexName}`,
    name: indexName,
    leverage: 1,
    expenseRatio: 0,
    simulated: true,
    smaEnabled: false,
    smaPeriod: indexName === LABEL_INDEX_SP500_TR ? params.smaSpPeriod : params.smaNqPeriod,
    smaUpperBuffer: 0, smaLowerBuffer: 0,
    smaIndex: indexName === LABEL_INDEX_SP500_TR ? "sp500" : "nasdaq100",
    riskOffAsset: params.riskOffAsset,
  });

  const buildSmaVariants = (
    baseLabel: string,
    preset: typeof uproPreset
  ): StrategyVariant[] => {
    return [
      {
        label: `${baseLabel} SMA Next Open`,
        config: baseConfig(preset, true, "next-day-open"),
      },
      {
        label: `${baseLabel} SMA Close`,
        config: baseConfig(preset, true, "trigger-day-close"),
      },
    ];
  };

  const executionMode = params.tradeAfterHours ? "trigger-day-close" : "next-day-open";

  return {
    sp500Variants: [
      { label: "UPRO", config: baseConfig(uproPreset, false, executionMode) },
      ...buildSmaVariants("UPRO", uproPreset),
      { label: "SSO", config: baseConfig(ssoPreset, false, executionMode) },
      ...buildSmaVariants("SSO", ssoPreset),
      { label: LABEL_INDEX_SP500_TR, config: indexConfig(LABEL_INDEX_SP500_TR) },
    ],
    nasdaqVariants: [
      { label: "TQQQ", config: baseConfig(tqqqPreset, false, executionMode) },
      ...buildSmaVariants("TQQQ", tqqqPreset),
      { label: "QLD", config: baseConfig(qldPreset, false, executionMode) },
      ...buildSmaVariants("QLD", qldPreset),
      { label: LABEL_INDEX_NASDAQ100_TR, config: indexConfig(LABEL_INDEX_NASDAQ100_TR) },
    ],
  };
}

export function buildStrategyYearlyGrowthSeries(params: {
  sp500Backtest: BacktestResult;
  nasdaqBacktest: BacktestResult | null;
  sp500Variants: StrategyVariant[];
  nasdaqVariants: StrategyVariant[];
  monthlyCpi: Array<{ date: string; value: number }>;
}): StrategyYearlyGrowthSeries {
  const cpiInflation = buildYearlyCpiInflation(params.monthlyCpi);
  const sp500Sampled = sampleYearlyRealGrowth(
    params.sp500Backtest.dates,
    params.sp500Backtest.nonLeveragedValues,
    cpiInflation,
    params.monthlyCpi
  );
  const yearLabels = sp500Sampled.years;
  const series: StrategyYearlyGrowthSeries["series"] = [{ label: LABEL_INDEX_SP500_TR, values: sp500Sampled.values }];

  if (params.nasdaqBacktest) {
    const nasdaqSampled = sampleYearlyRealGrowth(
      params.nasdaqBacktest.dates,
      params.nasdaqBacktest.nonLeveragedValues,
      cpiInflation,
      params.monthlyCpi
    );
    if (nasdaqSampled.years.length > 0) {
      const offset = yearLabels.indexOf(nasdaqSampled.years[0]);
      series.push({
        label: LABEL_INDEX_NASDAQ100_TR,
        values: offset > 0 ? [...Array(offset).fill(null), ...nasdaqSampled.values] : nasdaqSampled.values,
      });
    }
  }

  for (const variant of [...params.sp500Variants, ...params.nasdaqVariants]) {
    if (variant.label === LABEL_INDEX_SP500_TR || variant.label === LABEL_INDEX_NASDAQ100_TR) {
      continue;
    }
    if (!shouldIncludeStrategyChartLabel(variant.label)) {
      continue;
    }
    const backtest = variant.config.smaIndex === "nasdaq100" ? params.nasdaqBacktest : params.sp500Backtest;
    if (!backtest) continue;
    const targetId = variant.config.smaEnabled ? `${variant.config.id}-sma` : variant.config.id;
    const etfResult = backtest.etfResults.find((result) => result.id === targetId);
    if (!etfResult) continue;
    const sampled = sampleYearlyRealGrowth(
      backtest.dates,
      etfResult.dailyValues,
      cpiInflation,
      params.monthlyCpi
    );
    const offset = yearLabels.indexOf(sampled.years[0]);
    series.push({
      label: variant.label,
      values: offset > 0 ? [...Array(offset).fill(null), ...sampled.values] : sampled.values,
    });
  }

  return {
    years: yearLabels,
    series,
    inflation: sp500Sampled.inflation,
  };
}
