interface CloseObservation {
  date: string;
  adj_close?: number;
  source?: string;
}

/** Latest observed, confirmed close shared by every series; never forward-fill an endpoint. */
export function latestCommonCloseDate(
  series: readonly (readonly CloseObservation[])[],
  endDate: string,
): string | undefined {
  if (series.length === 0) return undefined;
  const dates = series.map((points) => new Set(points
    .filter((point) => point.date <= endDate
      && Number.isFinite(point.adj_close) && (point.adj_close ?? 0) > 0
      && !point.source?.includes("provisional"))
    .map((point) => point.date)));
  let latest: string | undefined;
  for (const date of dates[0]) {
    if ((!latest || date > latest) && dates.every((set) => set.has(date))) latest = date;
  }
  return latest;
}
