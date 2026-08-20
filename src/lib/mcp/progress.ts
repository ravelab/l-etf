// Progress notifications for the long-running MCP tools.
//
// A sweep can occupy most of the function's 300s budget in a single call. The
// endpoint answers over a streamed response, so notifications sent while the
// tool runs reach the client immediately instead of the caller waiting in
// silence. Per the MCP spec this is opt-in: without a `progressToken` on the
// request we build no reporter at all and do no work.

import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import type { SweepProgress } from "@/lib/mcp/sweep-core";

export type McpRequestExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** Minimum advance, as a fraction of the whole job, worth a notification. */
const MIN_FRACTION_DELTA = 0.02;
/** Always let a notification through once this long has passed. */
const MIN_INTERVAL_MS = 500;

/**
 * Build a progress reporter for one request, or `undefined` when the client
 * didn't ask for progress. The returned callback is fire-and-forget: it never
 * throws, never awaits, and never lets a failed notification fail the tool —
 * losing a progress ping matters far less than losing the result.
 *
 * Emitted values are monotonic and clamped to [0, 1] with `total: 1`, so a
 * client can render them as a percentage directly.
 */
export function makeProgressReporter(
  extra: McpRequestExtra,
  options?: { label?: string },
): SweepProgress | undefined {
  const progressToken = extra._meta?.progressToken;
  if (progressToken == null) return undefined;

  let lastFraction = -1;
  let lastSentAt = 0;

  return (fraction: number, label?: string) => {
    const clamped = Math.max(0, Math.min(1, fraction));
    // Progress must never move backwards; a stage that restarts its own
    // counter would otherwise emit a lower value than the client has seen.
    if (clamped <= lastFraction) return;

    const now = Date.now();
    const advancedEnough = clamped - lastFraction >= MIN_FRACTION_DELTA;
    const waitedEnough = now - lastSentAt >= MIN_INTERVAL_MS;
    if (!advancedEnough && !waitedEnough && clamped < 1) return;

    lastFraction = clamped;
    lastSentAt = now;

    void extra
      .sendNotification({
        method: "notifications/progress",
        params: {
          progressToken,
          progress: clamped,
          total: 1,
          message: label ?? options?.label ?? "Running simulations...",
        },
      })
      .catch(() => {
        // The client may have gone away, or the transport may not carry
        // notifications. Either way the tool result still matters.
      });
  };
}

/**
 * A reporter for tools that advance in discrete steps rather than a continuous
 * engine fraction (e.g. one sweep per holding period). Returns `undefined` when
 * the client didn't ask for progress.
 */
export function makeStepReporter(
  extra: McpRequestExtra,
  totalSteps: number,
): ((completedSteps: number, label?: string) => void) | undefined {
  const report = makeProgressReporter(extra);
  if (!report || totalSteps <= 0) return undefined;
  return (completedSteps: number, label?: string) => report(completedSteps / totalSteps, label);
}
