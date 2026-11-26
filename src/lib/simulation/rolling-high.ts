/** Highest close over the trailing window, including the current close. */
export function rollingHigh(closes: number[], window: number): number[] {
  const out = new Array<number>(closes.length);
  const queue: number[] = [];
  let head = 0;
  for (let i = 0; i < closes.length; i++) {
    while (queue.length > head && closes[queue[queue.length - 1]] <= closes[i]) queue.pop();
    queue.push(i);
    if (queue[head] <= i - window) head++;
    out[i] = closes[queue[head]];
  }
  return out;
}
