/** Keep every label, in vertical order, as close as possible to its anchor. */
export function spaceChartLabels(
  anchors: readonly number[],
  top: number,
  bottom: number,
  spacing: number,
): number[] {
  if (anchors.length === 0) return [];
  const gap = anchors.length > 1 ? Math.min(spacing, (bottom - top) / (anchors.length - 1)) : 0;
  const sorted = anchors.map((y, index) => ({ y, index })).sort((a, b) => a.y - b.y || a.index - b.index);
  const blocks: Array<{ start: number; end: number; sum: number; count: number }> = [];
  sorted.forEach(({ y }, i) => {
    blocks.push({ start: i, end: i, sum: y - i * gap, count: 1 });
    // Isotonic regression after subtracting the minimum spacing: adjacent
    // crowded labels share their displacement instead of pushing only downward.
    while (blocks.length > 1) {
      const right = blocks[blocks.length - 1];
      const left = blocks[blocks.length - 2];
      if (left.sum / left.count <= right.sum / right.count) break;
      blocks.splice(-2, 2, { start: left.start, end: right.end, sum: left.sum + right.sum, count: left.count + right.count });
    }
  });
  const result = new Array<number>(anchors.length);
  const limit = bottom - (anchors.length - 1) * gap;
  for (const block of blocks) {
    const y = Math.max(top, Math.min(limit, block.sum / block.count));
    for (let i = block.start; i <= block.end; i++) result[sorted[i].index] = y + i * gap;
  }
  return result;
}
