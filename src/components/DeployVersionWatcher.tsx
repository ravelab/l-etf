"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AppUpdatingOverlay } from "@/components/ui/AppUpdatingOverlay";
import {
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
 * Compares the running tab's stored deployment id with GET /api/deploy-version.
 * After a new Vercel deploy, the next poll (or visibility / focus / bfcache restore)
 * shows the "Updating app" popup and reloads, so cached JS/HTML don't stick around in
 * standalone / Add-to-Home-Screen mode.
 *
 * iOS never re-fetches a home-screen app on launch: tapping the icon resumes the
 * suspended web view, so the reload below is the *only* thing that moves a resumed
 * PWA onto a new build. A resume is also the one case where the popup buys nothing,
 * since the user is watching a launch rather than a page they were reading, so the
 * notice is cut to zero there and kept in full for an update found mid-session.
 */
export function DeployVersionWatcher() {
  /** Non-null once an update is committed to; carries the notice that path earned. */
  const [update, setUpdate] = useState<{ noticeMs: number } | null>(null);
  /** Set the instant an update is detected — `update` state lands a render too late
   *  to stop a poll and a `storage` event from each scheduling their own reload. */
  const updatingRef = useRef(false);

  const startUpdate = useCallback((noticeMs: number) => {
    if (updatingRef.current) return;
    updatingRef.current = true;
    setUpdate({ noticeMs });
  }, []);

  useEffect(() => {
    if (!update) return;
    const timer = window.setTimeout(() => window.location.reload(), update.noticeMs);
    return () => window.clearTimeout(timer);
  }, [update]);

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

        const action = decideDeployAction(readStoredId(), incoming);
        if (action === "ignore") return;

        writeStoredId(incoming);
        if (action === "update") startUpdate(noticeMs);
      } catch {
        // offline or transient — skip until next poll / visibility / focus
      } finally {
        inFlight = false;
      }
    };

    const onStorage = (e: StorageEvent) => {
      // Peeked, not consumed: this tab may still be hidden, and the span it is
      // building is what a later resume would read.
      if (isDeployStorageUpdate(e)) startUpdate(deployUpdateNoticeMs(hiddenFor()));
    };

    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenSince = Date.now();
        return;
      }
      void check(deployUpdateNoticeMs(consumeHiddenFor()));
    };

    const onFocus = () => {
      void check(deployUpdateNoticeMs(consumeHiddenFor()));
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
      () => void check(deployUpdateNoticeMs(hiddenFor())),
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
  }, [startUpdate]);

  return <AppUpdatingOverlay active={update !== null} />;
}
