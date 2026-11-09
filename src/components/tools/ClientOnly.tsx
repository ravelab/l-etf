"use client";

import { useSyncExternalStore, type ReactNode } from "react";

const subscribe = () => () => {};

/**
 * Renders its children only in the browser, after hydration.
 *
 * The tool pages restore their form from localStorage, and default the end date
 * to the visitor's own today, in their very first render, so server HTML for them
 * can never match what the client hydrates with. Production never server-renders
 * them (`useSearchParams` bails the static page out to its Suspense fallback), but
 * `next dev` renders on demand and did, which raised hydration errors. This makes
 * every environment do what production does. A client-side navigation renders the
 * children at once; only a hydration pass waits one render.
 */
export function ClientOnly({ children }: { children: ReactNode }) {
  const hydrated = useSyncExternalStore(subscribe, () => true, () => false);
  return hydrated ? children : null;
}
