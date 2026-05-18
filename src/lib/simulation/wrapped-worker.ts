import type { EtfConfig, PricePoint, RatePoint } from "./types";
import type { RollingWindow } from "./rolling";
import {
  buildWrappedTailCache,
  extractCachedWrappedWindowResult,
  extractOptimizedWrappedWindowResult,
  type WrappedPrecomputedConfigDailyValues,
} from "./wrapped-window";

interface WrappedWorkerData {
  precomputedDailyValues: WrappedPrecomputedConfigDailyValues[];
  windows: RollingWindow[];
  prices: PricePoint[];
  rates: RatePoint[];
  configs: EtfConfig[];
  riskOffValuesByAsset?: Partial<Record<EtfConfig["riskOffAsset"], number[]>>;
  riskOffOpenValuesByAsset?: Partial<Record<EtfConfig["riskOffAsset"], number[]>>;
}

self.onmessage = (event: MessageEvent<WrappedWorkerData>) => {
  try {
    const { precomputedDailyValues, windows, prices, rates, configs, riskOffValuesByAsset, riskOffOpenValuesByAsset } = event.data;
    const configById = new Map(configs.map((config) => [config.id, config]));
    const buckets = precomputedDailyValues.map((precomputed) => {
      const config = configById.get(precomputed.configId);
      const tailCache = config
        ? buildWrappedTailCache(
            windows,
            prices,
            config,
            rates,
            riskOffValuesByAsset,
            riskOffOpenValuesByAsset
          )
        : null;
      const simulations = config
        ? windows
            .map((window) =>
              tailCache
                ? extractCachedWrappedWindowResult(precomputed, window, prices, tailCache)
                : extractOptimizedWrappedWindowResult(
                    precomputed,
                    window,
                    prices,
                    config,
                    rates,
                    riskOffValuesByAsset,
                    riskOffOpenValuesByAsset
                  )
            )
            .filter((simulation) => simulation != null)
        : [];
      return {
        configId: precomputed.configId,
        simulations,
      };
    });

    self.postMessage({ type: "result", result: buckets });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Wrapped worker failed";
    self.postMessage({ type: "error", message });
  }
};
