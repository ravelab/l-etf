import {
  CONSTANT_INITIAL_INVESTMENT,
  getRiskOffSpread,
  getSymbolSpread,
} from "@/lib/constants";
import { cpiIndexRatioEndOverStart } from "@/lib/inflation";
import type { EtfConfig, EtfResult, PricePoint } from "@/lib/simulation/types";
import type { FuturesTaxRates } from "./futures-tax";
import { runLetfTaxLedger } from "./letf-tax";
import { heldRiskOnByDay } from "./letf-dual-sleeve";
import { buildTaxCalendar, buildWindowTaxSchedule, taxesApply } from "./after-tax-window";
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
