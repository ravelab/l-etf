/**
 * Let the browser paint and handle input between chunks of a long main-thread
 * computation. Resolves immediately outside a browser (Node, Web Workers), so
 * server-side callers pay nothing.
 */
export function yieldToBrowser(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  return new Promise((resolve) => {
    window.setTimeout(resolve, 0);
  });
}
