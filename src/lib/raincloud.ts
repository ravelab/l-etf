export interface RaincloudDensityPoint {
  value: number;
  density: number;
}

function quantile(sortedAsc: number[], p: number): number {
  const idx = (sortedAsc.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

/**
 * Builds a normalized kernel-density profile in log space so the cloud's
 * geometry matches a logarithmic chart axis. `lower` and `upper` are the
 * visible whisker bounds; observations outside them still influence density
 * near the edges but are not added as extra profile coordinates.
 */
export function buildLogRaincloudDensity(
  values: number[],
  lower: number,
  upper: number,
  steps = 28,
): RaincloudDensityPoint[] {
  const logs = values
    .filter((value) => Number.isFinite(value) && value > 0)
    .map(Math.log)
    .sort((a, b) => a - b);
  if (logs.length === 0 || !Number.isFinite(lower) || !Number.isFinite(upper) || lower <= 0 || upper <= 0) {
    return [];
  }

  const lo = Math.log(Math.min(lower, upper));
  const hi = Math.log(Math.max(lower, upper));
  if (Math.abs(hi - lo) < 1e-9) {
    return [{ value: Math.exp(lo), density: 1 }];
  }

  const mean = logs.reduce((sum, value) => sum + value, 0) / logs.length;
  const variance = logs.reduce((sum, value) => sum + (value - mean) ** 2, 0) / logs.length;
  const stdDev = Math.sqrt(variance);
  const robustScale = (quantile(logs, 0.75) - quantile(logs, 0.25)) / 1.34;
  const scaleCandidates = [stdDev, robustScale].filter((value) => Number.isFinite(value) && value > 1e-9);
  const scale = scaleCandidates.length > 0 ? Math.min(...scaleCandidates) : (hi - lo) / 6;
  const bandwidth = Math.max((hi - lo) / 80, 0.9 * scale * logs.length ** -0.2);
  const sampleCount = Math.max(8, Math.round(steps));
  const rawProfile = Array.from({ length: sampleCount }, (_, index) => {
    const x = lo + ((hi - lo) * index) / (sampleCount - 1);
    const density = logs.reduce((sum, observation) => {
      const z = (x - observation) / bandwidth;
      return sum + Math.exp(-0.5 * z * z);
    }, 0);
    return { value: Math.exp(x), density };
  });
  const maxDensity = Math.max(...rawProfile.map((point) => point.density));
  if (!Number.isFinite(maxDensity) || maxDensity <= 0) return [];

  return rawProfile.map((point) => ({
    value: point.value,
    density: point.density / maxDensity,
  }));
}

/**
 * Caps the number of rain marks without random redraw jitter. Evenly spaced
 * order statistics preserve tails and the overall distribution shape.
 */
export function sampleRaincloudValues(values: number[], maxPoints = 40): number[] {
  const sorted = values
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
  const limit = Math.max(1, Math.floor(maxPoints));
  if (sorted.length <= limit) return sorted;
  if (limit === 1) return [sorted[Math.floor((sorted.length - 1) / 2)]];

  return Array.from({ length: limit }, (_, index) => {
    const sourceIndex = Math.round((index * (sorted.length - 1)) / (limit - 1));
    return sorted[sourceIndex];
  });
}
