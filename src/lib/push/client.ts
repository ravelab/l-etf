"use client";

import type { PushSmaConfig } from "./types";
import { getOrCreatePushInstallId } from "./install-id";

const PUSH_PUBLIC_KEY_URL = "/api/push/public-key";
const PUSH_SUBSCRIBE_URL = "/api/push/subscribe";
const PUSH_UNSUBSCRIBE_URL = "/api/push/unsubscribe";
const PUSH_SERVICE_WORKER_URL = "/sw.js";
const PUSH_ALERTS_CONFIG_KEY = "push-alerts-sma-config";

export function isPushSupported(): boolean {
  if (typeof window === "undefined") return false;
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export function isStandaloneApp(): boolean {
  if (typeof window === "undefined") return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return window.matchMedia("(display-mode: standalone)").matches || Boolean(nav.standalone);
}

export function isIosDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

export async function fetchPushPublicKey(): Promise<string | null> {
  const response = await fetch(PUSH_PUBLIC_KEY_URL, { cache: "no-store" });
  if (!response.ok) return null;
  const data = (await response.json()) as { publicKey?: string };
  return typeof data.publicKey === "string" && data.publicKey.trim() !== "" ? data.publicKey : null;
}

export function getStoredPushAlertConfig(): PushSmaConfig | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(PUSH_ALERTS_CONFIG_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PushSmaConfig;
  } catch {
    return null;
  }
}

export function setStoredPushAlertConfig(config: PushSmaConfig): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PUSH_ALERTS_CONFIG_KEY, JSON.stringify(config));
  } catch {
    // ignore quota errors
  }
}

export function clearStoredPushAlertConfig(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(PUSH_ALERTS_CONFIG_KEY);
  } catch {
    // ignore storage errors
  }
}

async function ensurePushServiceWorker(): Promise<ServiceWorkerRegistration> {
  if (!("serviceWorker" in navigator)) {
    throw new Error("Service workers are not supported in this browser.");
  }
  return navigator.serviceWorker.register(PUSH_SERVICE_WORKER_URL, { scope: "/" });
}

export async function getCurrentPushSubscription(): Promise<PushSubscription | null> {
  const registration = await ensurePushServiceWorker();
  return registration.pushManager.getSubscription();
}

export async function subscribeToPushAlerts(
  publicKey: string,
  smaConfig: PushSmaConfig
): Promise<PushSubscription> {
  if (!isPushSupported()) {
    throw new Error("Push notifications are not supported in this browser.");
  }

  if (Notification.permission === "denied") {
    throw new Error("Notification permission is blocked. Re-enable it in browser settings.");
  }

  if (isIosDevice() && !isStandaloneApp()) {
    throw new Error("Open the site from your Home Screen first on iPhone.");
  }

  const permission =
    Notification.permission === "granted"
      ? "granted"
      : await Notification.requestPermission();

  if (permission !== "granted") {
    throw new Error("Notification permission was not granted.");
  }

  const registration = await ensurePushServiceWorker();
  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
    }));

  const response = await fetch(PUSH_SUBSCRIBE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      subscription,
      smaConfig,
      installId: getOrCreatePushInstallId(),
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to save push subscription (${response.status})`);
  }

  return subscription;
}

export async function unsubscribeFromPushAlerts(): Promise<void> {
  const registration = await ensurePushServiceWorker();
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;

  const endpoint = subscription.endpoint;
  const installId = getOrCreatePushInstallId();
  await subscription.unsubscribe();

  await fetch(PUSH_UNSUBSCRIBE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ endpoint, installId }),
  });
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }

  return outputArray;
}
