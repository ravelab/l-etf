/**
 * O(log n) range max-drawdown over a fixed value series.
 *
 * A window's max drawdown is otherwise an O(window length) walk, so sweeping W
 * rolling windows costs O(W x length). Building this segment tree once per
 * config makes it O(n) to build and O(log n) per window.
 *
 * Drawdown percentage is invariant under a uniform positive rescale, so the
 * tree can be built on the raw daily values and still answer correctly for a
 * window that gets renormalized to a common starting investment.
 */

type DrawdownNode = {
  min: number;
  max: number;
  maxDrawdownPct: number;
};

export type DrawdownRangeQuery = (
  startIdx: number,
  endIdx: number
) => { pct: number; dollar: number; longestDays: number };

function mergeDrawdownNodes(left: DrawdownNode, right: DrawdownNode): DrawdownNode {
  const crossDrawdownPct = left.max > 0 ? (left.max - right.min) / left.max : 0;
  return {
    min: Math.min(left.min, right.min),
    max: Math.max(left.max, right.max),
    maxDrawdownPct: Math.max(left.maxDrawdownPct, right.maxDrawdownPct, crossDrawdownPct),
  };
}

/** Returns a query where `pct` is already scaled to percentage points. */
export function buildDrawdownRangeQuery(values: number[]): DrawdownRangeQuery {
  let size = 1;
  while (size < values.length) size *= 2;
  const tree: DrawdownNode[] = Array.from({ length: size * 2 }, () => ({
    min: Infinity,
    max: -Infinity,
    maxDrawdownPct: 0,
  }));

  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    tree[size + i] = { min: value, max: value, maxDrawdownPct: 0 };
  }
  for (let i = size - 1; i > 0; i--) {
    tree[i] = mergeDrawdownNodes(tree[i * 2], tree[i * 2 + 1]);
  }

  return (startIdx: number, endIdx: number) => {
    if (endIdx - startIdx < 1) return { pct: 0, dollar: 0, longestDays: 0 };
    let left = startIdx + size;
    let right = endIdx + size;
    let leftNode: DrawdownNode | null = null;
    let rightNode: DrawdownNode | null = null;

    while (left <= right) {
      if (left % 2 === 1) {
        leftNode = leftNode ? mergeDrawdownNodes(leftNode, tree[left]) : tree[left];
        left += 1;
      }
      if (right % 2 === 0) {
        rightNode = rightNode ? mergeDrawdownNodes(tree[right], rightNode) : tree[right];
        right -= 1;
      }
      left = Math.floor(left / 2);
      right = Math.floor(right / 2);
    }

    const node = leftNode && rightNode
      ? mergeDrawdownNodes(leftNode, rightNode)
      : leftNode ?? rightNode;
    if (!node) return { pct: 0, dollar: 0, longestDays: 0 };
    return { pct: node.maxDrawdownPct * 100, dollar: 0, longestDays: 0 };
  };
}
