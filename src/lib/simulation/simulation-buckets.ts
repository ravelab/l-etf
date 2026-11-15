// Rolling-window results per config, built on the main thread from
// precomputed daily values. Regular windows are sliced by
// `window-extraction.ts`; windows that run past the data into a History Wrap
// tail are resimulated by `wrapped-window.ts`.

import type { EtfConfig, PricePoint, RatePoint } from "./types";
import type { RollingSimulationPoint, RollingWindow } from "./rolling";
import type { PrecomputedConfigDailyValues } from "./precompute";
import type { ConfigSimulationBucket } from "./parallel-results";
import { buildWindowDrawdownRanges, extractRegularWindowSimulation } from "./window-extraction";
import { buildWrappedTailCache, extractCachedWrappedWindowResult, extractOptimizedWrappedWindowResult } from "./wrapped-window";
import { throwIfAborted } from "../abort";
import { yieldToBrowser } from "../yield-to-browser";

export interface SimulationBucketOptions {
  /** With `configs`, enables resimulating History Wrap windows; without both they are skipped. */
  rates?: RatePoint[];
  configs?: EtfConfig[];
  riskOffValuesByAsset?: Partial<Record<EtfConfig["riskOffAsset"], number[]>>;
  riskOffOpenValuesByAsset?: Partial<Record<EtfConfig["riskOffAsset"], number[]>>;
}

/** Configs bucketed between yields to the browser's event loop. */
const CONFIGS_PER_YIELD = 2;

function buildConfigBucket(
  precomputed: PrecomputedConfigDailyValues,
  config: EtfConfig | undefined,
  windows: RollingWindow[],
  prices: PricePoint[],
  options: SimulationBucketOptions | undefined
): ConfigSimulationBucket {
  const rates = options?.rates;
  const wrappedTailCache = config && rates
    ? buildWrappedTailCache(
        precomputed,
        windows,
        prices,
        config,
        rates,
        options?.riskOffValuesByAsset,
        options?.riskOffOpenValuesByAsset
      )
    : null;
  const drawdownRanges = buildWindowDrawdownRanges(precomputed);

  const simulations: RollingSimulationPoint[] = [];
  for (const window of windows) {
    let simulation: RollingSimulationPoint | null;
    if (window.usesSyntheticTail && config && rates) {
      simulation = wrappedTailCache
        ? extractCachedWrappedWindowResult(precomputed, window, prices, wrappedTailCache)
        : extractOptimizedWrappedWindowResult(
            precomputed,
            window,
            prices,
            config,
            rates,
            options?.riskOffValuesByAsset,
            options?.riskOffOpenValuesByAsset
          );
    } else {
      simulation = extractRegularWindowSimulation(precomputed, window, drawdownRanges);
    }
    if (simulation) simulations.push(simulation);
  }

  return { configId: precomputed.configId, simulations };
}

function configLookup(options: SimulationBucketOptions | undefined): (configId: string) => EtfConfig | undefined {
  const configById = new Map(options?.configs?.map((config) => [config.id, config]) ?? []);
  return (configId) => configById.get(configId);
}

/**
 * Extract rolling window results from pre-computed daily values.
 * NO simulation - just slicing and metrics!
 * Exported for use by the snapshot generator.
 */
export function buildSimulationBuckets(
  precomputedDailyValues: PrecomputedConfigDailyValues[],
  windows: RollingWindow[],
  prices: PricePoint[],
  options?: SimulationBucketOptions
): ConfigSimulationBucket[] {
  const configFor = configLookup(options);
  return precomputedDailyValues.map((precomputed) =>
    buildConfigBucket(precomputed, configFor(precomputed.configId), windows, prices, options)
  );
}

/**
 * {@link buildSimulationBuckets} for the browser: reports per-config progress,
 * checks `signal` between configs and yields so the page stays responsive.
 */
export async function buildSimulationBucketsAsync(
  precomputedDailyValues: PrecomputedConfigDailyValues[],
  windows: RollingWindow[],
  prices: PricePoint[],
  options?: SimulationBucketOptions,
  onProgress?: (completed: number, total: number, label?: string) => void,
  signal?: AbortSignal
): Promise<ConfigSimulationBucket[]> {
  const configFor = configLookup(options);
  const total = precomputedDailyValues.length;
  const buckets: ConfigSimulationBucket[] = [];

  for (let configIndex = 0; configIndex < total; configIndex += 1) {
    throwIfAborted(signal);
    const precomputed = precomputedDailyValues[configIndex];
    buckets.push(buildConfigBucket(precomputed, configFor(precomputed.configId), windows, prices, options));
    onProgress?.(configIndex + 1, total, `Preparing results (${configIndex + 1}/${total})...`);

    if (configIndex < total - 1 && configIndex % CONFIGS_PER_YIELD === CONFIGS_PER_YIELD - 1) {
      await yieldToBrowser();
    }
  }

  return buckets;
}
