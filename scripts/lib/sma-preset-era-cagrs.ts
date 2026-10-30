import { SMA_CALIBRATION_ERAS, SMA_CALIBRATION_VOL_GATE } from "../../src/lib/simulation/sma-calibration-eras";
import { DEFAULT_RISK_OFF_ASSETS } from "../../src/lib/simulation/defaults";
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

interface EraCagr { startDate: string; endDate: string; cagr: number;
  realCagr: number; inflation: { startDate: string; endDate: string; ratio: number } }

async function eraCagrs(index: IndexKey, combo: SmaCombo, endDate: string): Promise<Record<string, EraCagr>> {
  const out: Record<string, EraCagr> = {};
  for (const era of SMA_CALIBRATION_ERAS[index].filter((era) => era.key !== "start")) {
    // An era is its own backtest with its own warm-up, never a slice of a
    // longer series. These nominal whole-era CAGRs differ from rolling scores.
    const result = await runBacktestCore({
      preset: index === "sp500" ? "UPRO" : "TQQQ", smaEnabled: true,
      startDate: era.startDate, endDate: era.endDate ?? endDate, ...combo,
      smaVolGate: SMA_CALIBRATION_VOL_GATE[index], riskOffAsset: DEFAULT_RISK_OFF_ASSETS[index], smaExecutionMode: DEFAULT_SMA_EXECUTION_MODE,
    });
    out[era.key] = { startDate: result.startDate, endDate: result.endDate, cagr: result.cagrPct,
      ...await realReturn(result.finalMultiple, result.startDate, result.endDate) };
  }
  return out;
}

/**
 * Every CAGR the Signals page displays is re-run here with each index's site default risk-off
 * asset (`DEFAULT_RISK_OFF_ASSETS`), the basket a visitor's backtest of the same rule holds. The
 * search that picked the rules scores on `DEFAULT_RISK_OFF_ASSET`; its own CAGRs are replaced.
 */
export async function withEraCagrs<T extends { sp500: SmaCombo & { finalMultiple: number }; nasdaq100: SmaCombo & { finalMultiple: number } }>(presets: T[], startDate: string, endDate: string) {
  const out = [];
  for (const preset of presets) {
    const sp500 = await eraCagrs("sp500", preset.sp500, endDate);
    const nasdaq100 = await eraCagrs("nasdaq100", preset.nasdaq100, endDate);
    const spxModern = await runBacktestCore({
      preset: "UPRO", smaEnabled: true, startDate, endDate,
      smaPeriod: preset.sp500.smaPeriod, smaUpperBuffer: preset.sp500.smaUpperBuffer,
      smaLowerBuffer: preset.sp500.smaLowerBuffer, smaVolGate: SMA_CALIBRATION_VOL_GATE.sp500,
      riskOffAsset: DEFAULT_RISK_OFF_ASSETS.sp500, smaExecutionMode: DEFAULT_SMA_EXECUTION_MODE,
    });
    const ndxModern = await runBacktestCore({
      preset: "TQQQ", smaEnabled: true, startDate: CONSTANT_NASDAQ100_SHORTCUT_DATE, endDate,
      smaPeriod: preset.nasdaq100.smaPeriod, smaUpperBuffer: preset.nasdaq100.smaUpperBuffer,
      smaLowerBuffer: preset.nasdaq100.smaLowerBuffer, smaVolGate: SMA_CALIBRATION_VOL_GATE.nasdaq100,
      riskOffAsset: DEFAULT_RISK_OFF_ASSETS.nasdaq100, smaExecutionMode: DEFAULT_SMA_EXECUTION_MODE,
    });
    out.push({ ...preset,
      sp500: { ...preset.sp500, ...await realReturn(spxModern.finalMultiple, spxModern.startDate, spxModern.endDate),
        cagr: spxModern.cagrPct, finalMultiple: spxModern.finalMultiple,
        maxDrawdown: spxModern.maxDrawdownPct, trades: spxModern.numTrades,
        realCagrStartDate: spxModern.startDate, realCagrEndDate: spxModern.endDate, eraCagrs: sp500 },
      nasdaq100: { ...preset.nasdaq100, ...await realReturn(ndxModern.finalMultiple, ndxModern.startDate, ndxModern.endDate),
        cagr: ndxModern.cagrPct, finalMultiple: ndxModern.finalMultiple,
        maxDrawdown: ndxModern.maxDrawdownPct, trades: ndxModern.numTrades,
        realCagrStartDate: ndxModern.startDate, realCagrEndDate: ndxModern.endDate, eraCagrs: nasdaq100,
        switchHistory: { startDate: ndxModern.startDate, endDate: ndxModern.endDate, count: ndxModern.numTrades } } });
  }
  return out;
}
