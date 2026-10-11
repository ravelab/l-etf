import { SMA_CALIBRATION_ERAS } from "../../src/lib/simulation/sma-calibration-eras";
import { DEFAULT_RISK_OFF_ASSET } from "../../src/lib/simulation/defaults";
import { DEFAULT_SMA_EXECUTION_MODE } from "../../src/lib/input-normalization";
import { runBacktestCore } from "../../src/lib/mcp/tools/run-backtest";
import type { SmaCombo } from "../../src/lib/simulation/sma-search";
import type { IndexKey } from "../../src/lib/simulation/types";
import { fetchInflationData } from "./sweep-data";
import { cpiIndexRatioEndOverStart } from "../../src/lib/inflation";
import { calcCagr } from "../../src/lib/simulation/metrics";

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
      riskOffAsset: DEFAULT_RISK_OFF_ASSET, smaExecutionMode: DEFAULT_SMA_EXECUTION_MODE,
    });
    out[era.key] = { startDate: result.startDate, endDate: result.endDate, cagr: result.cagrPct,
      ...await realReturn(result.finalMultiple, result.startDate, result.endDate) };
  }
  return out;
}

export async function withEraCagrs<T extends { sp500: SmaCombo & { finalMultiple: number }; nasdaq100: SmaCombo & { finalMultiple: number } }>(presets: T[], startDate: string, endDate: string) {
  const out = [];
  for (const preset of presets) {
    const sp500 = await eraCagrs("sp500", preset.sp500, endDate);
    const nasdaq100 = await eraCagrs("nasdaq100", preset.nasdaq100, endDate);
    out.push({ ...preset,
      sp500: { ...preset.sp500, ...await realReturn(preset.sp500.finalMultiple, startDate, endDate), eraCagrs: sp500 },
      nasdaq100: { ...preset.nasdaq100, ...await realReturn(preset.nasdaq100.finalMultiple, startDate, endDate), eraCagrs: nasdaq100 } });
  }
  return out;
}
