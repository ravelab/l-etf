import type { SmaSignalConfig, SmaSignalSnapshot } from "@/lib/sma-status";

export type PushSmaConfig = SmaSignalConfig;

export type PushSubscriptionKeys = {
  p256dh: string;
  auth: string;
};

export type PushSubscriptionRecord = {
  id: string;
  installId: string;
  endpoint: string;
  expirationTime: number | null;
  keys: PushSubscriptionKeys;
  smaConfig: PushSmaConfig;
  createdAt: string;
  updatedAt: string;
  userAgent?: string;
};

export type PushSendPayload = {
  web_push: 8030;
  notification: {
    title: string;
    body: string;
    navigate: string;
    tag: string;
    renotify: boolean;
    timestamp: number;
    data: {
      url: string;
    };
  };
  // Retain the legacy top-level fields until previously installed service
  // workers have updated to the declarative-aware handler.
  title: string;
  body: string;
  url: string;
  tag: string;
  timestamp: string;
  status: string;
};

export type StoredSmaPushState = {
  fingerprint: string;
  snapshot: SmaSignalSnapshot;
  updatedAt: string;
  pendingInitialNotification?: boolean;
};
