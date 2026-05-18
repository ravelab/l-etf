import type { PricePoint } from "@/lib/simulation/types";

type WindowRange = {
  startDate: string;
  endDate: string;
};

function getPriceOnOrBeforeDate(sortedPoints: PricePoint[], targetDate: string): number | null {
  let lo = 0;
  let hi = sortedPoints.length - 1;
  let bestIdx = -1;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const midDate = sortedPoints[mid].date;
    if (midDate <= targetDate) {
      bestIdx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  if (bestIdx === -1) return null;
  return sortedPoints[bestIdx].adj_close;
}

export function buildSgovFinalValuesByWindow(
  windows: WindowRange[],
  sgovPoints: PricePoint[],
  initialInvestment: number,
): Map<string, number> {
  const sorted = [...sgovPoints].sort((a, b) => a.date.localeCompare(b.date));
  const byWindow = new Map<string, number>();

  for (const window of windows) {
    const startPrice = getPriceOnOrBeforeDate(sorted, window.startDate);
    const endPrice = getPriceOnOrBeforeDate(sorted, window.endDate);
    if (!startPrice || !endPrice || startPrice <= 0 || endPrice <= 0) continue;
    byWindow.set(
      `${window.startDate}|${window.endDate}`,
      initialInvestment * (endPrice / startPrice)
    );
  }

  return byWindow;
}
