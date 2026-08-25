/**
 * Cancellation helpers shared by every tool page.
 *
 * Cancel paths are matched with `isAbortError`, which keys off `name`. A plain
 * `new Error("Aborted")` has name "Error", so it slips past that guard and gets
 * handled as a genuine failure — wiping the displayed results and raising an
 * error banner instead of quietly standing down. Always raise cancellation
 * through `abortError` so the two halves agree.
 */

export function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException("The operation was aborted.", "AbortError");
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** Raise if `signal` has been aborted, as a properly-named AbortError. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}
