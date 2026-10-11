export const SMA_REFRESH_LIMITS = {
  total: 55, data: 3, seeds: 10, calibration: 15,
  presets: 15, presetGrace: 3, finalization: 3, snapshots: 5,
} as const;

/** Share a refinement deadline fairly between the two indices. */
export class SmaSearchBudget {
  private readonly deadline: number;

  constructor(milliseconds: number, private readonly now: () => number = Date.now) {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new Error("Invalid SMA search budget");
    this.deadline = now() + milliseconds;
  }

  allocate(remainingIndices: number): SmaSearchBudget {
    if (!Number.isInteger(remainingIndices) || remainingIndices < 1) throw new Error("Invalid index count");
    return new SmaSearchBudget(Math.max(0, this.deadline - this.now()) / remainingIndices, this.now);
  }

  canRefine(): boolean {
    // Leave time for an in-flight batch, fully checked fallback rules, and output.
    return this.now() + 30_000 < this.deadline;
  }
}

export function smaBudgetMinutes(args: string[], fallback = 15): number {
  const flag = args.find((arg) => arg.startsWith("--budget-minutes="));
  const minutes = flag ? Number(flag.slice("--budget-minutes=".length)) : fallback;
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > 45) throw new Error("SMA budget must be between 0 and 45 minutes");
  return minutes;
}
