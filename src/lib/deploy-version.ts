/**
 * Deployment-id bookkeeping for {@link ../components/DeployVersionWatcher}.
 *
 * Kept free of React and browser globals so the reload decision is unit-testable
 * on its own; the component owns the polling, the popup and the actual reload.
 */

/** localStorage key holding the deployment id this tab is running. */
export const DEPLOY_ID_STORAGE_KEY = "l-etf-deploy-id";

/** Poll cadence for /api/deploy-version while the tab is open. */
export const DEPLOY_POLL_MS = 5 * 60 * 1000;

/** First poll runs this long after mount, so it never competes with hydration. */
export const DEPLOY_FIRST_CHECK_MS = 3000;

/** How long the "Updating app" popup stays up before the reload fires. */
export const DEPLOY_UPDATE_NOTICE_MS = 1500;

export type DeployAction =
  /** Nothing to do: unusable response, or the id we are already running. */
  | "ignore"
  /** First id this tab has seen — record it silently, no reload. */
  | "adopt"
  /** A new deployment shipped — show the popup, then reload. */
  | "update";

/**
 * Validates the /api/deploy-version body. The route promises `{ v: string }`,
 * but a proxy, an offline shim or an error page can return anything, and a bad
 * value here would reload the tab on every poll.
 */
export function parseDeployVersion(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const { v } = body as { v?: unknown };
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed === "" ? null : trimmed;
}

/** Decides what a freshly polled deployment id means for a tab holding `stored`. */
export function decideDeployAction(stored: string | null, incoming: string | null): DeployAction {
  if (incoming === null) return "ignore";
  if (stored === null) return "adopt";
  return stored === incoming ? "ignore" : "update";
}

/**
 * True when a `storage` event means another tab already adopted a newer
 * deployment, so this tab should follow it onto the new build.
 */
export function isDeployStorageUpdate(event: Pick<StorageEvent, "key" | "oldValue" | "newValue">): boolean {
  if (event.key !== DEPLOY_ID_STORAGE_KEY) return false;
  const incoming = typeof event.newValue === "string" ? event.newValue.trim() : "";
  if (incoming === "") return false;
  return incoming !== event.oldValue;
}
