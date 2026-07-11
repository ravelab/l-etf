import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time string comparison for secrets (cron tokens, bearer headers).
 * A plain `!==` short-circuits on the first differing character, which leaks
 * how much of the secret matched through response timing.
 *
 * Length differences still return early — that only reveals the secret's
 * length, which is standard and acceptable.
 */
export function timingSafeStringEqual(candidate: string | null | undefined, expected: string): boolean {
  if (typeof candidate !== "string") return false;
  const candidateBytes = Buffer.from(candidate, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  if (candidateBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(candidateBytes, expectedBytes);
}
