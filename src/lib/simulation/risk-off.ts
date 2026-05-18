export function firstFinitePositive(...values: Array<number | null | undefined>): number {
  for (const value of values) {
    if (Number.isFinite(value) && (value as number) > 0) return value as number;
  }
  return NaN;
}

export function riskOffOpenTradePrice(params: {
  openValues?: number[];
  closeValues?: number[];
  index: number;
  lastPrice?: number;
}): number {
  const i = params.index;
  return firstFinitePositive(
    params.openValues?.[i],
    params.closeValues?.[i],
    params.closeValues?.[Math.max(0, i - 1)],
    params.lastPrice
  );
}

export function riskOffCloseMarkPrice(params: {
  closeValues?: number[];
  index: number;
  lastPrice?: number;
}): number {
  const i = params.index;
  return firstFinitePositive(
    params.closeValues?.[i],
    params.closeValues?.[Math.max(0, i - 1)],
    params.lastPrice
  );
}
