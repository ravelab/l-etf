// Futures ladder plans and the LETF configs "Check Emulations" compares them
// against, built from one shared SMA band per index.
//
// These used to be two literals ~40 lines apart in futures-tool/page.tsx, and
// they drifted: the ladder carried a single `buffer` per index and used it for
// both sides of the band, while the LETF configs took the calibrated asymmetric
// pair. Since the upper buffer governs re-entry and the lower one governs the
// exit, that did not widen the band — it moved the trapdoor, and the ladders
// rode 1973-74 down 91.5% where their LETF twins stopped at 65.9%.
//
// Same failure mode `sweep-items.ts` exists to prevent. Both builders here read
// the same `SmaBand` objects, so an emulation pair cannot disagree about its own
// rule; `unit-tests/futures-plan.test.ts` asserts it.

import type { EtfConfig, IndexKey, RiskOffAsset } from "@/lib/simulation/types";
import { createPresetEtfConfig, ETF_PRESETS } from "@/lib/simulation/presets";

/** SMA rule for one index: period plus the asymmetric re-entry/exit band. */
export type SmaBand = {
  period: number;
  /** Re-entry threshold, percent above the SMA. */
  upperBuffer: number;
  /** Exit threshold, percent below the SMA. */
  lowerBuffer: number;
};

export type FuturesLadderStep = {
  index: IndexKey;
  leverage: number;
  maxLeverage?: number;
  displayName?: string;
  sma: SmaBand;
};

export type SmaBandsByIndex = {
  sp500: SmaBand;
  nasdaq100: SmaBand;
};

/**
 * The rungs "Check Emulations" checks, each paired with the LETF it is checked
 * against. One declaration drives both sides.
 */
const EMULATION_PAIRS = [
  { index: "sp500", leverage: 3, configId: "upro", presetKey: "UPRO" },
  { index: "nasdaq100", leverage: 3, configId: "tqqq", presetKey: "TQQQ" },
  { index: "nasdaq100", leverage: 2, configId: "qld", presetKey: "QLD" },
] as const;

/** Windows longer than this drop the mid ladder rungs — the sims get expensive. */
const LONG_WINDOW_YEARS = 90;

export function buildFuturesLadderPlan(params: {
  /** Emulation mode runs only the rungs that have an LETF twin. */
  showEmulations: boolean;
  hasNasdaqData: boolean;
  yearSpan: number;
  bands: SmaBandsByIndex;
}): FuturesLadderStep[] {
  const { showEmulations, hasNasdaqData, yearSpan, bands } = params;
  const bandFor = (index: IndexKey): SmaBand => bands[index as keyof SmaBandsByIndex];

  if (showEmulations) {
    return EMULATION_PAIRS.filter((pair) => hasNasdaqData || pair.index !== "nasdaq100").map((pair) => ({
      index: pair.index as IndexKey,
      leverage: pair.leverage,
      sma: bandFor(pair.index as IndexKey),
    }));
  }

  const sp = bandFor("sp500");
  const nq = bandFor("nasdaq100");
  const maxSpx: FuturesLadderStep = {
    index: "sp500",
    leverage: 4.5,
    maxLeverage: 4.5,
    displayName: "Max 4.5x SPX SMA",
    sma: sp,
  };

  if (yearSpan > LONG_WINDOW_YEARS) {
    return [maxSpx, { index: "sp500", leverage: 3, sma: sp }];
  }

  return [
    maxSpx,
    { index: "sp500", leverage: 5, sma: sp },
    { index: "sp500", leverage: 3, sma: sp },
    ...(hasNasdaqData
      ? [
          { index: "nasdaq100" as IndexKey, leverage: 4, sma: nq },
          { index: "nasdaq100" as IndexKey, leverage: 3, sma: nq },
        ]
      : []),
  ];
}

/**
 * LETF SMA series for the emulation view. Deliberately index-based (no real ETF
 * price history) so the comparison is purely the futures-vs-swap cost model.
 */
export function buildEmulationEtfConfigs(params: {
  hasNasdaqData: boolean;
  bands: SmaBandsByIndex;
  riskOffAsset: RiskOffAsset;
}): EtfConfig[] {
  const { hasNasdaqData, bands, riskOffAsset } = params;
  return EMULATION_PAIRS.filter((pair) => hasNasdaqData || pair.index !== "nasdaq100").map((pair) => {
    const band = bands[pair.index as keyof SmaBandsByIndex];
    return createPresetEtfConfig(pair.configId, ETF_PRESETS[pair.presetKey], {
      smaEnabled: true,
      smaPeriod: band.period,
      smaUpperBuffer: band.upperBuffer,
      smaLowerBuffer: band.lowerBuffer,
      riskOffAsset,
    });
  });
}
