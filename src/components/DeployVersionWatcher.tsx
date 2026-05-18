"use client";

import { useEffect } from "react";

const STORAGE_KEY = "l-etf-deploy-id";
const POLL_MS = 5 * 60 * 1000;

/**
 * Compares the running tab’s stored deployment id with GET /api/deploy-version.
 * After a new Vercel deploy, the next poll (or visibility / window focus) triggers a reload so
 * cached JS/HTML don’t stick around in standalone / Add-to-Home-Screen mode.
 */
export function DeployVersionWatcher() {
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY && e.newValue != null && e.newValue !== e.oldValue) {
        window.location.reload();
      }
    };
    window.addEventListener("storage", onStorage);

    let cancelled = false;

    const check = async () => {
      if (cancelled) return;
      try {
        const res = await fetch("/api/deploy-version", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { v?: string };
        const incoming = data.v;
        if (!incoming) return;

        const prev = localStorage.getItem(STORAGE_KEY);
        if (prev === null) {
          localStorage.setItem(STORAGE_KEY, incoming);
          return;
        }
        if (prev !== incoming) {
          localStorage.setItem(STORAGE_KEY, incoming);
          window.location.reload();
        }
      } catch {
        // offline or transient — skip until next poll / visibility / focus
      }
    };

    const t0 = window.setTimeout(() => void check(), 3000);
    const interval = window.setInterval(() => void check(), POLL_MS);

    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    const onFocus = () => {
      void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);

    return () => {
      cancelled = true;
      window.clearTimeout(t0);
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  return null;
}
