export type RunSummary = {
  letf: string;
  startDate: string;
  endDate: string;
  windowLength: number;
  smaSpPeriod: number;
  smaSpBuffer: number;
  smaNqPeriod: number;
  smaNqBuffer: number;
  riskOffAsset: string;
  tradeAfterHours: boolean;
  amount?: number;
  leverageTolerance?: string;
};

export function buildRunSummary(summary: {
  letf: string;
  startDate: string;
  endDate: string;
  windowLength: number;
  smaSpPeriod: number;
  smaSpBuffer: number;
  smaNqPeriod: number;
  smaNqBuffer: number;
  riskOffAsset: string;
  tradeAfterHours?: boolean;
  amount?: number;
  leverageTolerance?: string;
}): RunSummary {
  return {
    ...summary,
    tradeAfterHours: summary.tradeAfterHours ?? false,
  };
}
