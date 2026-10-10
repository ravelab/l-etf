"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isStandaloneApp } from "@/lib/push/client";
import { AppUpdatingOverlay } from "@/components/ui/AppUpdatingOverlay";
import {
  BUILD_DEPLOY_VERSION,
  DEPLOY_FIRST_CHECK_MS,
  DEPLOY_ID_STORAGE_KEY,
  DEPLOY_POLL_MS,
  DEPLOY_UPDATE_NOTICE_MS,
  DEPLOY_UPDATE_NOTICE_RESUME_MS,
  decideDeployAction,
  deployUpdateNoticeMs,
  isDeployStorageUpdate,
  parseDeployVersion,
} from "@/lib/deploy-version";

/**
 * Compares the loaded build's deployment id with GET /api/deploy-version.
 * After a new Vercel deploy, the next poll (or visibility / focus / bfcache restore)
 * shows the "Updating app" popup and reloads, so cached JS/HTML don't stick around in
 * standalone / Add-to-Home-Screen mode.
 *
 * A home-screen launch can resume a suspended web view instead of fetching a
 * fresh page. Resume checks still move that old build onto the latest release;
 * a fresh load already running it must ignore any previous visit's stored id.
 */
export function DeployVersionWatcher({ runningVersion = BUILD_DEPLOY_VERSION }: { runningVersion?: string }) {
  /** Non-null once an update is committed to; carries the notice that path earned. */
  const [update, setUpdate] = useState<{ noticeMs: number } | null>(null);
  /** Set the instant an update is detected — `update` state lands a render too late
   *  to stop a poll and a `storage` event from each scheduling their own reload. */
  const updatingRef = useRef(false);

  const startUpdate = useCallback((noticeMs: number) => {
    if (updatingRef.current) return;
    updatingRef.current = true;
    if (noticeMs === DEPLOY_UPDATE_NOTICE_RESUME_MS) {
      // Reload directly: rendering the overlay even with a zero-delay timer can
      // flash "Updating app" while the browser waits for the new document.
      window.location.reload();
      return;
    }
    setUpdate({ noticeMs });
  }, []);

  useEffect(() => {
    if (!update) return;
    const timer = window.setTimeout(() => window.location.reload(), update.noticeMs);
    return () => window.clearTimeout(timer);
  }, [update]);

  useEffect(() => {
    const writeStoredId = (id: string) => {
      try {
        localStorage.setItem(DEPLOY_ID_STORAGE_KEY, id);
      } catch {
        // Non-fatal: this tab still checks its build id without cross-tab hints.
      }
    };

    /** When the page went hidden, or null if it is mid-session and never left. */
    let hiddenSince: number | null = null;
    const hiddenFor = (): number | null => (hiddenSince === null ? null : Date.now() - hiddenSince);
    /** Reads the hidden span and clears it, so one resume feeds exactly one check. */
    const consumeHiddenFor = (): number | null => {
      const ms = hiddenFor();
      hiddenSince = null;
      return ms;
    };

    let cancelled = false;
    /** One resume can fire visibilitychange, focus and pageshow together; without this
     *  they race three identical fetches and whichever lands first picks the notice. */
    let inFlight = false;

    const check = async (noticeMs: number) => {
      if (cancelled || updatingRef.current || inFlight) return;
      inFlight = true;
      try {
        const res = await fetch("/api/deploy-version", { cache: "no-store" });
        if (!res.ok) return;
        const incoming = parseDeployVersion(await res.json());
        if (cancelled || updatingRef.current || incoming === null) return;

        const action = decideDeployAction(runningVersion, incoming);
        writeStoredId(incoming);
        if (action === "update") startUpdate(noticeMs);
      } catch {
        // offline or transient — skip until next poll / visibility / focus
      } finally {
        inFlight = false;
      }
    };

    const onStorage = (e: StorageEvent) => {
      // Storage is only a hint. Confirm with the server against this tab's build:
      // another tab may write our current id, or an older deployment's id.
      if (isDeployStorageUpdate(e)) void check(deployUpdateNoticeMs(hiddenFor(), isStandaloneApp()));
    };

    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenSince = Date.now();
        return;
      }
      void check(deployUpdateNoticeMs(consumeHiddenFor(), isStandaloneApp()));
    };

    const onFocus = () => {
      void check(deployUpdateNoticeMs(consumeHiddenFor(), isStandaloneApp()));
    };

    const onPageShow = (e: PageTransitionEvent) => {
      // A non-persisted pageshow is the initial load, already covered by the mount
      // timer. A persisted one is a bfcache / page-cache restore, which is a relaunch
      // by definition — iOS fires it on resume without always firing visibilitychange
      // first, so it must not depend on a hidden span having been recorded.
      if (!e.persisted) return;
      consumeHiddenFor();
      void check(DEPLOY_UPDATE_NOTICE_RESUME_MS);
    };

    const t0 = window.setTimeout(() => void check(DEPLOY_UPDATE_NOTICE_MS), DEPLOY_FIRST_CHECK_MS);
    const interval = window.setInterval(
      () => void check(deployUpdateNoticeMs(hiddenFor(), isStandaloneApp())),
      DEPLOY_POLL_MS
    );

    window.addEventListener("storage", onStorage);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    window.addEventListener("pageshow", onPageShow);

    return () => {
      cancelled = true;
      window.clearTimeout(t0);
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("storage", onStorage);
    };
  }, [runningVersion, startUpdate]);

  return <AppUpdatingOverlay active={update !== null} />;
}
