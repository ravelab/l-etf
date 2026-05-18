import { fetchMarketData, MARKET_DATA_EARLIEST_START } from "@/lib/fetch-market-data";
import type { EtfPreset } from "@/lib/simulation/presets";
import type { IndexKey, PricePoint, RatePoint, SmaComparisonRow } from "@/lib/simulation/types";

type InflationData = {
  annualizedInflation: number;
  monthlyCpi: Array<{ date: string; value: number }>;
};

type SweepOutcome<TRow> = {
  rows: TRow[];
  baseline: SmaComparisonRow | null;
};

export async function runCompareSweep<TRow, TRiskOffValues>(p: {
  comboSubs: EtfPreset[] | null;
  selectedPreset: EtfPreset;
  index: IndexKey;
  startDate: string;
  endDate: string;
  warmUpTradingDays?: number;
  onProgress: (pct: number, label: string) => void;
  loadRiskOffValues: (preset: EtfPreset, prices: PricePoint[]) => Promise<TRiskOffValues>;
  runSweepForPreset: (
    preset: EtfPreset,
    prices: PricePoint[],
    rates: RatePoint[],
    riskOffValues: TRiskOffValues,
    pctBase: number,
    pctSpan: number,
    cpiData?: Array<{ date: string; value: number }>,
    signal?: AbortSignal,
  ) => Promise<SweepOutcome<TRow>>;
  signal?: AbortSignal;
}): Promise<{
  rows: TRow[];
  baseline: SmaComparisonRow | null;
  rows2: TRow[];
  baseline2: SmaComparisonRow | null;
  inflationData: InflationData;
  inflationWarning: boolean;
}> {
  const indicesToFetch: IndexKey[] = p.comboSubs
    ? [...new Set(p.comboSubs.map((sub) => sub.index))] as IndexKey[]
    : [p.index];

  const marketData = await fetchMarketData(
    indicesToFetch,
    p.startDate,
    p.endDate,
    p.signal,
    ({ completed, total, label }) => {
      const pct = 5 + (completed / total) * 10;
      p.onProgress(pct, label);
    },
    {
      allowMissingPrices: true,
      rateStartDate: MARKET_DATA_EARLIEST_START,
      warmUpTradingDays: p.warmUpTradingDays,
    }
  );
  const { rates, pricesByIndex, inflationWarning } = marketData;
  const inflationData: InflationData = {
    annualizedInflation: marketData.annualizedInflation,
    monthlyCpi: marketData.monthlyCpi,
  };

  p.onProgress(16, "Preparing risk-off prices...");

  if (p.comboSubs) {
    const availableSubs = p.comboSubs.filter((sub) => (pricesByIndex[sub.index]?.length ?? 0) >= 2);

    // If one leg is missing data (e.g. nasdaq100 404), degrade gracefully and run the available leg only.
    if (availableSubs.length === 1) {
      const sub = availableSubs[0];
      const prices = pricesByIndex[sub.index];
      const riskOffValues = await p.loadRiskOffValues(sub, prices);
      p.onProgress(20, `Running ${sub.name}...`);
      const res = await p.runSweepForPreset(sub, prices, rates, riskOffValues, 20, 70, inflationData.monthlyCpi, p.signal);
      return {
        rows: res.rows,
        baseline: res.baseline,
        rows2: [],
        baseline2: null,
        inflationData,
        inflationWarning,
      };
    }

    const [sub1, sub2] = p.comboSubs;
    const prices1 = pricesByIndex[sub1.index];
    const prices2 = pricesByIndex[sub2.index];
    const riskOff1 = await p.loadRiskOffValues(sub1, prices1);
    const riskOff2 = sub2.index === sub1.index ? riskOff1 : await p.loadRiskOffValues(sub2, prices2);

    p.onProgress(20, `Running ${sub1.name}...`);
    const res1 = await p.runSweepForPreset(sub1, prices1, rates, riskOff1, 20, 35, inflationData.monthlyCpi, p.signal);
    p.onProgress(55, `Running ${sub2.name}...`);
    const res2 = await p.runSweepForPreset(sub2, prices2, rates, riskOff2, 55, 35, inflationData.monthlyCpi, p.signal);

    return {
      rows: res1.rows,
      baseline: res1.baseline,
      rows2: res2.rows,
      baseline2: res2.baseline,
      inflationData,
      inflationWarning,
    };
  }

  const prices = pricesByIndex[p.index];
  const riskOffValues = await p.loadRiskOffValues(p.selectedPreset, prices);
  p.onProgress(20, "Running simulations...");
  const res = await p.runSweepForPreset(
    p.selectedPreset,
    prices,
    rates,
    riskOffValues,
    20,
    70,
    inflationData.monthlyCpi,
    p.signal,
  );

  return {
    rows: res.rows,
    baseline: res.baseline,
    rows2: [],
    baseline2: null,
    inflationData,
    inflationWarning,
  };
}
