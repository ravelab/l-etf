import {
  CONSTANT_INITIAL_INVESTMENT,
  getRiskOffSpread,
  getSymbolSpread,
} from "@/lib/constants";
import { cpiIndexRatioEndOverStart } from "@/lib/inflation";
import type { EtfConfig, EtfResult, PricePoint } from "@/lib/simulation/types";
import type { FuturesTaxRates } from "./futures-tax";
import { runLetfTaxLedger } from "./letf-tax";
import { composeLetfFundPath, heldRiskOnByDay, type LetfFundPathSleeve } from "./letf-dual-sleeve";
import { buildTaxCalendar, buildWindowTaxSchedule, runLetfFundTaxLedger, taxesApply } from "./after-tax-window";
import {
  computeRenormalizedPathMetrics,
  finalizeTradingCosts,
  resolveEdgeRiskOffStates,
  selectEdgeSpreads,
} from "@/lib/simulation/window-calculations";

export interface ForwardSmaReturnPoint {
  date: string;
  gap: number;
  realReturnFactor: number;
}

export function buildForwardSmaReturnPoints(params: {
  indexPrices: PricePoint[];
  strategyResult: EtfResult | null;
  config: EtfConfig;
  monthlyCpi: Array<{ date: string; value: number }>;
  startDate: string;
  endDate: string;
  forwardTradingDays?: number;
  taxRates?: FuturesTaxRates;
}): ForwardSmaReturnPoint[] {
  const {
    indexPrices,
    strategyResult,
    config,
    monthlyCpi,
    startDate,
    endDate,
    forwardTradingDays = 252,
    taxRates,
  } = params;
  if (!strategyResult || indexPrices.length === 0 || strategyResult.dailyValues.length === 0) return [];

  const pricesByDate = new Map(indexPrices.map((price) => [price.date, price]));
  const carriedInRiskOff = strategyResult.smaStartInvested === false;
  const spreads = {
    riskOnSpreadRegular: getSymbolSpread(config.name, false),
    riskOffSpreadRegular: getRiskOffSpread(config.riskOffAsset, false),
  };

  // Built once: each start date then taxes only its own switches and tax dates.
  const held = taxesApply(taxRates) ? heldRiskOnByDay(strategyResult) : null;
  const calendar = held ? buildTaxCalendar(strategyResult.dates, (k) => held[k]) : null;

  const out: ForwardSmaReturnPoint[] = [];
  for (let i = 0; i < strategyResult.dates.length; i++) {
    const date = strategyResult.dates[i];
    const day = pricesByDate.get(date);
    if (!day || date < startDate || date > endDate) continue;

    const sma = strategyResult.smaPrices[i];
    if (!Number.isFinite(sma) || sma <= 0) continue;

    const dayClose = day.close;
    if (!Number.isFinite(dayClose) || dayClose <= 0) continue;
    const gap = (dayClose / sma - 1) * 100;

    const forwardIdx = i + forwardTradingDays;
    if (forwardIdx >= strategyResult.dates.length) continue;
    const forwardDate = strategyResult.dates[forwardIdx];
    const { startInRiskOff, endInRiskOff } = resolveEdgeRiskOffStates(
      strategyResult.smaSignals,
      date,
      forwardDate,
      carriedInRiskOff,
    );
    const { entrySpread, exitSpread } = selectEdgeSpreads(spreads, startInRiskOff, endInRiskOff);
    const metrics = computeRenormalizedPathMetrics(
      strategyResult.dailyValues,
      i,
      forwardIdx,
      entrySpread,
    );
    if (!metrics) continue;
    const finalValue = finalizeTradingCosts({
      rawFinalValue: metrics.finalValue,
      entrySpread,
      exitSpread,
    }).finalValue;
    const cpiRatio = cpiIndexRatioEndOverStart(monthlyCpi, date, forwardDate);
    if (!Number.isFinite(cpiRatio) || cpiRatio <= 0) continue;
    let afterTaxValue = finalValue;
    if (calendar && taxesApply(taxRates)) {
      const { schedule } = buildWindowTaxSchedule({
        calendar,
        startDay: i,
        endDay: forwardIdx,
        valueAt: (k) => strategyResult.dailyValues[k] * metrics.factor,
        exitFraction: metrics.finalValue > 0 ? finalValue / metrics.finalValue : 1,
      });
      const run = runLetfTaxLedger(schedule, taxRates);
      if (!run) continue;
      afterTaxValue = run.finalValue;
    }
    const nominalReturn = afterTaxValue / CONSTANT_INITIAL_INVESTMENT;
    const realReturn = nominalReturn / cpiRatio;
    if (!Number.isFinite(realReturn) || realReturn <= 0) continue;

    out.push({ date, gap, realReturnFactor: realReturn });
  }
  return out;
}

type ForwardSleeveInput = {
  indexPrices: PricePoint[];
  strategyResult: EtfResult | null;
  config: EtfConfig;
};

/** Gap (%) of each strategy day's index close to its SMA, or NaN where either is missing. */
function smaGaps(sleeve: ForwardSleeveInput & { strategyResult: EtfResult }): number[] {
  const closeByDate = new Map(sleeve.indexPrices.map((price) => [price.date, price.close]));
  return sleeve.strategyResult.dates.map((date, i) => {
    const sma = sleeve.strategyResult.smaPrices[i];
    const close = closeByDate.get(date);
    return close !== undefined && Number.isFinite(close) && close > 0 && Number.isFinite(sma) && sma > 0
      ? (close / sma - 1) * 100
      : NaN;
  });
}

/**
 * The UPRO/TQQQ fund's forward real return from each date both sleeves trade, as
 * its rolling windows measure it: opened 50/50, reset by the fund's own rule, and
 * taxed as one account (`composeLetfFundPath`, `runLetfFundTaxLedger`). The gap
 * is the average of the two indexes' gaps to their SMAs.
 */
export function buildForwardFundReturnPoints(params: {
  spx: ForwardSleeveInput;
  ndx: ForwardSleeveInput;
  monthlyCpi: Array<{ date: string; value: number }>;
  startDate: string;
  endDate: string;
  forwardTradingDays?: number;
  taxRates?: FuturesTaxRates;
}): ForwardSmaReturnPoint[] {
  const { monthlyCpi, startDate, endDate, forwardTradingDays = 252, taxRates } = params;
  const spxResult = params.spx.strategyResult;
  const ndxResult = params.ndx.strategyResult;
  if (!spxResult || !ndxResult || spxResult.dates.length < 2 || ndxResult.dates.length < 2) return [];
  const sleeves = [
    { ...params.spx, strategyResult: spxResult },
    { ...params.ndx, strategyResult: ndxResult },
  ] as const;

  const dates = [...new Set([...spxResult.dates, ...ndxResult.dates])].sort();
  const prepared = sleeves.map((sleeve) => {
    const indexByDate = new Map(sleeve.strategyResult.dates.map((date, i) => [date, i]));
    return {
      ...sleeve,
      dayIndex: Int32Array.from(dates, (date) => indexByDate.get(date) ?? -1),
      heldRiskOn: heldRiskOnByDay(sleeve.strategyResult),
      gaps: smaGaps(sleeve),
      carriedInRiskOff: sleeve.strategyResult.smaStartInvested === false,
      spreads: {
        riskOnSpreadRegular: getSymbolSpread(sleeve.config.name, false),
        riskOffSpreadRegular: getRiskOffSpread(sleeve.config.riskOffAsset, false),
      },
    };
  });

  const out: ForwardSmaReturnPoint[] = [];
  for (let first = 0; first + forwardTradingDays < dates.length; first++) {
    const date = dates[first];
    if (date < startDate || date > endDate) continue;
    const last = first + forwardTradingDays;
    const forwardDate = dates[last];
    const starts = prepared.map((sleeve) => sleeve.dayIndex[first]);
    if (starts.some((i) => i < 0) || prepared.some((sleeve) => sleeve.dayIndex[last] < 0)) continue;
    const gaps = prepared.map((sleeve, s) => sleeve.gaps[starts[s]]);
    if (gaps.some((gap) => !Number.isFinite(gap))) continue;
    const cpiRatio = cpiIndexRatioEndOverStart(monthlyCpi, date, forwardDate);
    if (!Number.isFinite(cpiRatio) || cpiRatio <= 0) continue;

    const pathSleeves = prepared.map((sleeve, s): LetfFundPathSleeve => {
      const { startInRiskOff, endInRiskOff } = resolveEdgeRiskOffStates(
        sleeve.strategyResult.smaSignals,
        date,
        forwardDate,
        sleeve.carriedInRiskOff,
      );
      const { entrySpread, exitSpread } = selectEdgeSpreads(sleeve.spreads, startInRiskOff, endInRiskOff);
      const startPrice = sleeve.strategyResult.dailyValues[starts[s]];
      return {
        dayIndex: sleeve.dayIndex,
        dailyValues: sleeve.strategyResult.dailyValues,
        heldRiskOn: sleeve.heldRiskOn,
        startValue: startPrice > 0 ? (CONSTANT_INITIAL_INVESTMENT * (1 - entrySpread)) / 2 : 0,
        riskOffAsset: sleeve.config.riskOffAsset,
        exitFraction: 1 - exitSpread,
        totalTradingCostPct: 0,
      };
    }) as [LetfFundPathSleeve, LetfFundPathSleeve];
    if (pathSleeves.some((sleeve) => !(sleeve.startValue > 0))) continue;

    const finalValue = taxesApply(taxRates)
      ? runLetfFundTaxLedger({ sleeves: pathSleeves, firstDay: first, dayCount: forwardTradingDays + 1, dates, rates: taxRates })?.run.finalValue
      : composeLetfFundPath(pathSleeves, first, forwardTradingDays + 1).finalValue;
    if (finalValue === undefined) continue;
    const realReturn = finalValue / CONSTANT_INITIAL_INVESTMENT / cpiRatio;
    if (!Number.isFinite(realReturn) || realReturn <= 0) continue;
    out.push({ date, gap: (gaps[0] + gaps[1]) / 2, realReturnFactor: realReturn });
  }
  return out;
}
