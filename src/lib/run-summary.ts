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
};

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
}): RunSummary {
  return {
    ...summary,
    tradeAfterHours: summary.tradeAfterHours ?? false,
  };
}
