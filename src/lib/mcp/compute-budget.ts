// Time budget for the heavy (rolling-window sweep) MCP tools.
//
// These tools run the single-threaded engine inside one serverless invocation,
// so breadth used to be capped at a flat 24 configs. Measured against the real
// engine over full 1885-2026 history (1,572 rolling windows), 24 configs takes
// ~0.7 s and 1,000 takes ~37 s against a 300 s function budget: the flat count
// was roughly 40x too conservative on CPU, and what actually bound it was
// retained heap (see `sweep-chunking.ts`). With chunking holding memory flat,
// the honest ceiling is a *time* budget, which is what this module models.

import { SWEEP_CHUNK_SIZE } from "@/lib/mcp/sweep-chunking";

/**
 * Milliseconds per (config x rolling window) unit.
 *
 * Measured at ~0.024 ms on a development machine across 24..1,000 configs over
 * full history. The constant carries a 3x margin for a Vercel Fluid vCPU, which
 * is slower than local hardware — estimates are used to *refuse* work, so they
 * must never undercut reality.
 */
export const SWEEP_MS_PER_CONFIG_WINDOW = 0.075;

/**
 * Fixed setup cost per chunk: rebuilding the index simulation context and the
 * rolling-window list (~50 ms locally, same 3x margin applied).
 */
const SWEEP_CHUNK_OVERHEAD_MS = 150;

/**
 * Wall-clock budget for one heavy tool call. The route's `maxDuration` is 300 s;
 * the remainder covers loading and aligning market data, joining rows, and
 * serializing the response, none of which this estimate covers.
 */
export const MCP_SWEEP_BUDGET_MS = 200_000;

/** A start instant plus a budget. Immutable: create a new one per tool call. */
export interface Deadline {
  readonly startedAt: number;
  readonly budgetMs: number;
}

/** Start a budget window. `now` is injectable so the math stays testable. */
export function createDeadline(budgetMs: number, now: number = Date.now()): Deadline {
  return Object.freeze({ startedAt: now, budgetMs });
}

/** Milliseconds left in the window, clamped at zero. */
export function deadlineRemainingMs(deadline: Deadline, now: number = Date.now()): number {
  return Math.max(0, deadline.startedAt + deadline.budgetMs - now);
}

export function isDeadlineExpired(deadline: Deadline, now: number = Date.now()): boolean {
  return deadlineRemainingMs(deadline, now) <= 0;
}

/**
 * Estimated wall time for a sweep of `configCount` configs over `windowCount`
 * rolling windows, including per-chunk setup.
 */
export function estimateSweepMs(configCount: number, windowCount: number): number {
  if (configCount <= 0 || windowCount <= 0) return 0;
  const chunks = Math.ceil(configCount / SWEEP_CHUNK_SIZE);
  return configCount * windowCount * SWEEP_MS_PER_CONFIG_WINDOW + chunks * SWEEP_CHUNK_OVERHEAD_MS;
}

/**
 * The largest config count that fits `budgetMs` at this window count — the
 * inverse of `estimateSweepMs`, used to tell a caller how far to narrow a
 * request rather than just refusing it.
 *
 * The per-chunk term is a step function, so the analytic start point can miss
 * by a few configs; the walk settles it exactly. Never returns less than 1: a
 * single config always gets its chance, however wide the window count.
 */
export function maxConfigsInBudget(windowCount: number, budgetMs: number): number {
  const perConfigMs = windowCount * SWEEP_MS_PER_CONFIG_WINDOW;
  if (perConfigMs <= 0) return Number.MAX_SAFE_INTEGER;

  let count = Math.max(1, Math.floor(budgetMs / perConfigMs));
  while (count > 1 && estimateSweepMs(count, windowCount) > budgetMs) count -= 1;
  while (estimateSweepMs(count + 1, windowCount) <= budgetMs) count += 1;
  return count;
}
