import { SMA_HISTORICAL_ERAS, SMA_CALIBRATION_INFLATION_ADJUSTED, SMA_CALIBRATION_VOL_GATE } from "../../src/lib/simulation/sma-calibration-eras";
import { DEFAULT_RISK_OFF_ASSETS } from "../../src/lib/simulation/defaults";
import { smaAlternateBand } from "../../src/lib/simulation/risk-off-gates";
import { DEFAULT_SMA_EXECUTION_MODE } from "../../src/lib/input-normalization";
import { runBacktestCore } from "../../src/lib/mcp/tools/run-backtest";
import type { SmaCombo } from "../../src/lib/simulation/sma-search";
import type { IndexKey } from "../../src/lib/simulation/types";
import { fetchInflationData } from "./sweep-data";
import { cpiIndexRatioEndOverStart } from "../../src/lib/inflation";
import { calcCagr } from "../../src/lib/simulation/metrics";
import { CONSTANT_NASDAQ100_SHORTCUT_DATE } from "../../src/lib/constants";

async function realReturn(finalMultiple: number, startDate: string, endDate: string) {
  const { monthlyCpi } = await fetchInflationData(startDate, endDate);
  const startCpi = monthlyCpi.filter((point) => point.date <= startDate).at(-1);
  const endCpi = monthlyCpi.at(-1);
  if (!startCpi || !endCpi || startCpi.value <= 0 || endCpi.value <= 0) {
    throw new Error(`Missing CPI coverage for preset CAGR ${startDate}..${endDate}`);
  }
  const ratio = cpiIndexRatioEndOverStart(monthlyCpi, startDate, endDate);
  return { realCagr: calcCagr(1, finalMultiple / ratio, startDate, endDate),
    inflation: { startDate: startCpi.date, endDate: endCpi.date, ratio } };
}

/** Calculate every displayed return with the index's default risk-off asset and next-open fills. */
async function withRuleCagrs<T extends SmaCombo>(index: IndexKey, combo: T, startDate: string, endDate: string, alternateGates = false) {
  const backtest = (from: string, to: string) => runBacktestCore({
    preset: index === "sp500" ? "UPRO" : "TQQQ", smaEnabled: true,
    startDate: from, endDate: to,
    smaPeriod: combo.smaPeriod, smaUpperBuffer: combo.smaUpperBuffer, smaLowerBuffer: combo.smaLowerBuffer,
    smaVolGate: alternateGates || SMA_CALIBRATION_VOL_GATE[index], smaAlternateGates: alternateGates,
    smaInflationAdjusted: SMA_CALIBRATION_INFLATION_ADJUSTED[index],
    riskOffAsset: DEFAULT_RISK_OFF_ASSETS[index], smaExecutionMode: DEFAULT_SMA_EXECUTION_MODE,
  });
  const eraCagrs = Object.fromEntries(await Promise.all(
    SMA_HISTORICAL_ERAS[index].filter((era) => era.key !== "start").map(async (era) => {
      // Every era is a separate backtest with its own SMA warm-up.
      const result = await backtest(era.startDate, era.endDate ?? endDate);
      return [era.key, { startDate: result.startDate, endDate: result.endDate, cagr: result.cagrPct,
        ...await realReturn(result.finalMultiple, result.startDate, result.endDate) }] as const;
    }),
  ));
  const modern = await backtest(index === "sp500" ? startDate : CONSTANT_NASDAQ100_SHORTCUT_DATE, endDate);
  return { ...combo, ...await realReturn(modern.finalMultiple, modern.startDate, modern.endDate),
    cagr: modern.cagrPct, finalMultiple: modern.finalMultiple, maxDrawdown: modern.maxDrawdownPct, trades: modern.numTrades,
    realCagrStartDate: modern.startDate, realCagrEndDate: modern.endDate, eraCagrs };
}

async function withNdxCagrs<T extends SmaCombo>(combo: T, startDate: string, endDate: string, alternateGates = false) {
  const rule = await withRuleCagrs("nasdaq100", combo, startDate, endDate, alternateGates);
  return { ...rule, switchHistory: { startDate: rule.realCagrStartDate, endDate: rule.realCagrEndDate, count: rule.trades } };
}

export async function withEraCagrs<T extends Record<IndexKey, SmaCombo>>(presets: T[], startDate: string, endDate: string) {
  const out = [];
  for (const preset of presets) {
    out.push({ ...preset,
      sp500: await withRuleCagrs("sp500", preset.sp500, startDate, endDate),
      nasdaq100: await withNdxCagrs(preset.nasdaq100, startDate, endDate),
    });
  }
  return out;
}

export async function alternateGatesPreset(bands: Record<IndexKey, SmaCombo>, startDate: string, endDate: string) {
  const bandFor = (index: IndexKey): SmaCombo => {
    const { smaPeriod, smaUpperBuffer, smaLowerBuffer } = smaAlternateBand(index, SMA_CALIBRATION_INFLATION_ADJUSTED[index]) ?? bands[index];
    return { smaPeriod, smaUpperBuffer, smaLowerBuffer };
  };
  return {
    sp500: await withRuleCagrs("sp500", bandFor("sp500"), startDate, endDate, true),
    nasdaq100: await withNdxCagrs(bandFor("nasdaq100"), startDate, endDate, true),
  };
}
