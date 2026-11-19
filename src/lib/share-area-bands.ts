/**
 * Band edges for a stacked area whose bands split the height under a total line in
 * proportion to each asset's share — on screen, on either axis.
 *
 * On a linear axis from zero that is plain stacking. On a log axis plain stacking
 * would squash every band but the top one (a 50% holding stacked under another 50%
 * fills only log10(2) of a decade), so each edge is placed where its cumulative
 * share falls between the axis floor and the total *in log space*:
 * `floor * (total / floor) ** share`. Its pixel height is then exactly that share
 * of the column under the total.
 */

/** Axis floor for a log chart: half the smallest positive total in view. */
export function logAxisFloor(totals: readonly number[]): number {
  let min = Infinity;
  for (const total of totals) if (total > 0 && total < min) min = total;
  return Number.isFinite(min) ? min / 2 : 1;
}

/**
 * `edges[a][k]` is the top of asset `a`'s band on day `k` (the last asset's top is
 * the day's total). `values[a][k]` are non-negative dollars. Days with no positive
 * total get null edges so they draw as gaps.
 */
export function shareAreaBandEdges(
  values: ReadonlyArray<ReadonlyArray<number>>,
  options: { logScale: boolean; floor: number }
): Array<Array<number | null>> {
  const dayCount = values[0]?.length ?? 0;
  const edges = values.map(() => new Array<number | null>(dayCount).fill(null));
  for (let k = 0; k < dayCount; k++) {
    let total = 0;
    for (const series of values) total += Math.max(0, series[k] ?? 0);
    if (!(total > 0)) continue;
    let cumulative = 0;
    values.forEach((series, a) => {
      cumulative += Math.max(0, series[k] ?? 0);
      const share = cumulative / total;
      edges[a][k] = options.logScale
        ? total > options.floor
          ? options.floor * Math.pow(total / options.floor, share)
          : total
        : options.floor + share * (total - options.floor);
    });
  }
  return edges;
}
