import { DEFAULT_FUTURES_TAX_RATES, type FuturesTaxRates } from "./simulation/futures-tax";

export type RunSummary = {
  letf: string;
  startDate: string;
  endDate: string;
  windowLength: number;
  smaSpPeriod: number;
  smaSpUpperBuffer: number;
  smaSpLowerBuffer: number;
  smaNqPeriod: number;
  smaNqUpperBuffer: number;
  smaNqLowerBuffer: number;
  smaVolGate: boolean;
  spxRiskOffAsset: string;
  ndxRiskOffAsset: string;
  tradeAfterHours: boolean;
  amount?: number;
  leverageTolerance?: string;
  /** Futures page only: sleeves carry their remainder in MES/MNQ. */
  microFutures?: boolean;
  taxRates?: FuturesTaxRates;
};

/**
 * The rates a run was taxed at, which is what its results show on every page: a
 * changed rate takes effect on the next run, like any other input. A run saved
 * without rates (the canned snapshots) was untaxed.
 */
export function runSummaryTaxRates(summary: Pick<RunSummary, "taxRates"> | null | undefined): FuturesTaxRates {
  return summary?.taxRates ?? DEFAULT_FUTURES_TAX_RATES;
}

export function buildRunSummary(summary: {
  letf: string;
  startDate: string;
  endDate: string;
  windowLength: number;
  smaSpPeriod: number;
  smaSpUpperBuffer: number;
  smaSpLowerBuffer: number;
  smaNqPeriod: number;
  smaNqUpperBuffer: number;
  smaNqLowerBuffer: number;
  smaVolGate: boolean;
  spxRiskOffAsset: string;
  ndxRiskOffAsset: string;
  tradeAfterHours?: boolean;
  amount?: number;
  leverageTolerance?: string;
  microFutures?: boolean;
  taxRates?: FuturesTaxRates;
}): RunSummary {
  return {
    ...summary,
    tradeAfterHours: summary.tradeAfterHours ?? false,
  };
}
