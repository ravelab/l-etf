/**
 * Legend helpers for charts whose visible series span several Chart.js
 * datasets (e.g. a raincloud plus its median connector and n/total line).
 * Tagging those datasets with a shared `seriesKey` lets one legend entry
 * hide the whole series instead of only the dataset it was generated from.
 */
export interface LinkedLegendDataset {
  seriesKey?: string;
}

/**
 * Indices a legend click should toggle together: every dataset sharing the
 * clicked dataset's `seriesKey`. Datasets with no key toggle alone, and an
 * out-of-range index toggles nothing.
 */
export function linkedLegendDatasetIndices(
  datasets: readonly LinkedLegendDataset[],
  clickedIndex: number,
): number[] {
  if (clickedIndex < 0 || clickedIndex >= datasets.length) return [];
  const key = datasets[clickedIndex].seriesKey;
  if (key === undefined) return [clickedIndex];
  return datasets
    .map((dataset, index) => (dataset.seriesKey === key ? index : -1))
    .filter((index) => index >= 0);
}
