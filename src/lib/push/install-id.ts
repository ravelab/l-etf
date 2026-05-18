"use client";

const PUSH_INSTALL_ID_KEY = "push-install-id";

function randomInstallId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isValidInstallId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function getOrCreatePushInstallId(): string {
  if (typeof window === "undefined") {
    return randomInstallId();
  }

  try {
    const stored = window.localStorage.getItem(PUSH_INSTALL_ID_KEY);
    if (stored && isValidInstallId(stored)) {
      return stored;
    }
    const next = randomInstallId();
    window.localStorage.setItem(PUSH_INSTALL_ID_KEY, next);
    return next;
  } catch {
    return randomInstallId();
  }
}

