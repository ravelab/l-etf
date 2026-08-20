"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AppUpdatingOverlay } from "@/components/ui/AppUpdatingOverlay";
import {
  DEPLOY_FIRST_CHECK_MS,
  DEPLOY_ID_STORAGE_KEY,
  DEPLOY_POLL_MS,
  DEPLOY_UPDATE_NOTICE_MS,
  decideDeployAction,
  isDeployStorageUpdate,
  parseDeployVersion,
} from "@/lib/deploy-version";

/**
 * Compares the running tab's stored deployment id with GET /api/deploy-version.
 * After a new Vercel deploy, the next poll (or visibility / window focus) shows the
 * "Updating app" popup and reloads, so cached JS/HTML don't stick around in
 * standalone / Add-to-Home-Screen mode.
 */
export function DeployVersionWatcher() {
  const [updating, setUpdating] = useState(false);
  /** Set the instant an update is detected — `updating` state lands a render too late
   *  to stop a poll and a `storage` event from each scheduling their own reload. */
  const updatingRef = useRef(false);

  const startUpdate = useCallback(() => {
    if (updatingRef.current) return;
    updatingRef.current = true;
    setUpdating(true);
  }, []);

  useEffect(() => {
    if (!updating) return;
    const timer = window.setTimeout(() => window.location.reload(), DEPLOY_UPDATE_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [updating]);

  useEffect(() => {
    const readStoredId = (): string | null => {
      try {
        return localStorage.getItem(DEPLOY_ID_STORAGE_KEY);
      } catch {
        // Safari private mode / storage disabled — treat as "nothing stored yet".
        return null;
      }
    };

    const writeStoredId = (id: string) => {
      try {
        localStorage.setItem(DEPLOY_ID_STORAGE_KEY, id);
      } catch {
        // Non-fatal: without persistence we simply re-adopt on the next load.
      }
    };

    const onStorage = (e: StorageEvent) => {
      if (isDeployStorageUpdate(e)) startUpdate();
    };
    window.addEventListener("storage", onStorage);

    let cancelled = false;

    const check = async () => {
      if (cancelled || updatingRef.current) return;
      try {
        const res = await fetch("/api/deploy-version", { cache: "no-store" });
        if (!res.ok) return;
        const incoming = parseDeployVersion(await res.json());
        if (cancelled || updatingRef.current || incoming === null) return;

        const action = decideDeployAction(readStoredId(), incoming);
        if (action === "ignore") return;

        writeStoredId(incoming);
        if (action === "update") startUpdate();
      } catch {
        // offline or transient — skip until next poll / visibility / focus
      }
    };

    const t0 = window.setTimeout(() => void check(), DEPLOY_FIRST_CHECK_MS);
    const interval = window.setInterval(() => void check(), DEPLOY_POLL_MS);

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
  }, [startUpdate]);

  return <AppUpdatingOverlay active={updating} />;
}
