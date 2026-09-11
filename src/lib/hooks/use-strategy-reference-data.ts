"use client";

import { useEffect, useState } from "react";
import {
  fetchMarketData,
  loadRiskOffPriceSeries,
  MARKET_DATA_EARLIEST_START,
} from "@/lib/fetch-market-data";
import { effectiveStartDateFromAlignedSeries } from "@/lib/simulation/effective-start";
import type { EtfConfig, PricePoint, RatePoint } from "@/lib/simulation/types";

/** Risk-off close/open series, keyed by the asset the config asks for. */
type RiskOffValuesByAsset = Partial<Record<EtfConfig["riskOffAsset"], number[]>>;

const EMPTY_RISK_OFF_SERIES = {
  closeValuesByAsset: {} as RiskOffValuesByAsset,
  openValuesByAsset: {} as RiskOffValuesByAsset,
};

/**
 * Index prices and the series priced against them, loaded as one unit.
 *
 * The request parameters are carried back alongside the data so a consumer always
 * renders the range the series were actually loaded for, never a newer form value
 * that a reload has not caught up with yet.
 */
export interface StrategyReferenceData {
  startDate: string;
  endDate: string;
  spxPrices: PricePoint[];
  ndxPrices: PricePoint[];
  rates: RatePoint[];
  monthlyCpi: Array<{ date: string; value: number }>;
  spxRiskOffValues: RiskOffValuesByAsset;
  spxRiskOffOpenValues: RiskOffValuesByAsset;
  ndxRiskOffValues: RiskOffValuesByAsset;
  ndxRiskOffOpenValues: RiskOffValuesByAsset;
  effectiveStartSp: string;
  effectiveStartNq: string;
}

interface StrategyReferenceParams {
  startDate: string;
  endDate: string;
  smaSpPeriod: number;
  smaNqPeriod: number;
  smaSpUpperBuffer: number;
  smaSpLowerBuffer: number;
  smaNqUpperBuffer: number;
  smaNqLowerBuffer: number;
  riskOffAsset: EtfConfig["riskOffAsset"];
  /** Skip the fetch entirely while the sections consuming it are off screen. */
  enabled?: boolean;
}

/**
 * Loads the raw SPX and NDX price history behind the forward-return chart.
 *
 * The chart needs whole index `PricePoint`s to measure each day's gap to its SMA,
 * which a finished backtest result does not carry, so this fetch stays separate
 * from the page's own run rather than being derived from it.
 */
export function useStrategyReferenceData({
  startDate,
  endDate,
  smaSpPeriod,
  smaNqPeriod,
  smaSpUpperBuffer,
  smaSpLowerBuffer,
  smaNqUpperBuffer,
  smaNqLowerBuffer,
  riskOffAsset,
  enabled = true,
}: StrategyReferenceParams): StrategyReferenceData | null {
  const [data, setData] = useState<StrategyReferenceData | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let cancelled = false;

    (async () => {
      try {
        const md = await fetchMarketData(
          ["sp500", "nasdaq100"],
          startDate,
          endDate,
          controller.signal,
          undefined,
          {
            allowMissingPrices: true,
            rateStartDate: MARKET_DATA_EARLIEST_START,
            warmUpTradingDays: Math.max(smaSpPeriod, smaNqPeriod),
          },
        );
        if (cancelled) return;

        const spxPrices = md.pricesByIndex["sp500"] ?? [];
        const ndxPrices = md.pricesByIndex["nasdaq100"] ?? [];
        const hasNdxPrices = ndxPrices.length >= 2;
        const [spxRiskOff, ndxRiskOff] = await Promise.all([
          loadRiskOffPriceSeries(riskOffAsset, spxPrices, startDate, endDate, controller.signal),
          hasNdxPrices
            ? loadRiskOffPriceSeries(riskOffAsset, ndxPrices, startDate, endDate, controller.signal)
            : Promise.resolve(EMPTY_RISK_OFF_SERIES),
        ]);
        if (cancelled) return;

        setData({
          startDate,
          endDate,
          spxPrices,
          ndxPrices,
          rates: md.rates,
          monthlyCpi: md.monthlyCpi,
          spxRiskOffValues: spxRiskOff.closeValuesByAsset,
          spxRiskOffOpenValues: spxRiskOff.openValuesByAsset,
          ndxRiskOffValues: ndxRiskOff.closeValuesByAsset,
          ndxRiskOffOpenValues: ndxRiskOff.openValuesByAsset,
          effectiveStartSp: effectiveStartDateFromAlignedSeries({
            requestedStartDate: startDate,
            dates: spxPrices.map((price) => price.date),
            closeByTicker: spxRiskOff.closeValuesByAsset,
          }),
          effectiveStartNq: effectiveStartDateFromAlignedSeries({
            requestedStartDate: startDate,
            dates: ndxPrices.map((price) => price.date),
            closeByTicker: ndxRiskOff.closeValuesByAsset,
          }),
        });
      } catch {
        // Silent fallback — the sections show their own empty state.
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [
    enabled,
    startDate,
    endDate,
    smaSpPeriod,
    smaNqPeriod,
    smaSpUpperBuffer,
    smaSpLowerBuffer,
    smaNqUpperBuffer,
    smaNqLowerBuffer,
    riskOffAsset,
  ]);

  return data;
}
