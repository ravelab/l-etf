import { createHash } from "node:crypto";
import { Redis } from "@upstash/redis";
import webpush from "web-push";
import {
  buildSmaSignalConfigFingerprint,
  buildSmaSignalFingerprint,
  describeSmaSignalChange,
  describeSmaSignalConfig,
  describeSmaSignalStatus,
  fetchSmaMarketData,
  getCurrentSmaSignalSnapshot,
  getDefaultSmaSignalConfig,
  type SmaSignalConfig,
  type SmaSignalSnapshot,
} from "@/lib/sma-status";
import type {
  PushSendPayload,
  PushSubscriptionKeys,
  PushSubscriptionRecord,
  StoredSmaPushState,
} from "./types";
import {
  pushInstallIdSchema,
  pushSmaConfigSchema,
  pushSubscriptionSchema,
  type PushSubscriptionInput,
} from "./schema";

const PUSH_SUBSCRIPTIONS_KEY = "push:subscriptions";
const PUSH_SUBSCRIPTION_PREFIX = "push:subscription:";
const PUSH_INSTALL_PREFIX = "push:install:";
const PUSH_SUBSCRIBE_RATE_LIMIT_PREFIX = "push:subscribe-rate:";
const PUSH_LAST_SMA_STATE_PREFIX = "push:last-sma-state:";
const PUSH_SUBSCRIBE_IP_WINDOW_SECONDS = 60 * 60;
const PUSH_SUBSCRIBE_IP_MAX = 20;
const DEFAULT_PUSH_URL = "/signals";
const DEFAULT_PUSH_TAG = "l-etf-sma-status";
const PUSH_SUBSCRIBE_RATE_LIMIT_SECONDS = 1;

const DEFAULT_SMA_CONFIG = getDefaultSmaSignalConfig();

type SmaPushDeliveryItemResult = {
  subscriptionId: string;
  configFingerprint: string;
  fingerprint: string;
  previousFingerprint: string | null;
  changed: boolean;
  sent: boolean;
  removed: boolean;
  skippedReason?: string;
};

type SmaPushDeliveryResult = {
  changed: boolean;
  forced: boolean;
  evaluated: number;
  sent: number;
  removed: number;
  skippedReason?: string;
};

type SendSmaPushNotificationsOptions = {
  force?: boolean;
};

type NormalizedPushSubscriptionRecord = Omit<PushSubscriptionRecord, "smaConfig"> & {
  smaConfig: SmaSignalConfig;
};

let webPushConfigured = false;
let redisClient: Redis | null = null;

function hasPushStorageConfig(): boolean {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

function getPushRedis(): Redis {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error("Push storage is not configured");
  }
  redisClient ??= new Redis({ url, token });
  return redisClient;
}

function hasVapidConfig(): boolean {
  return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

export function getVapidPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY?.trim() || null;
}

function configureWebPush(): boolean {
  if (webPushConfigured) return true;
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  const subject = process.env.VAPID_SUBJECT?.trim();
  if (!publicKey || !privateKey) return false;
  if (!subject) {
    console.error(
      "[push] VAPID_SUBJECT is required when VAPID keys are configured. " +
        "Set it to a mailto: URL (e.g. mailto:you@example.com) or an https URL. Skipping push setup.",
    );
    return false;
  }

  webpush.setVapidDetails(subject, publicKey, privateKey);
  webPushConfigured = true;
  return true;
}

export function isPushInfrastructureReady(): boolean {
  return hasPushStorageConfig() && hasVapidConfig();
}

export function isPushStorageReady(): boolean {
  return hasPushStorageConfig();
}

function normalizePushSubscription(input: unknown): PushSubscriptionInput {
  return pushSubscriptionSchema.parse(input);
}

function normalizePushSmaConfig(input: unknown): SmaSignalConfig {
  return pushSmaConfigSchema.parse(input);
}

function getPushSubscriptionId(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("hex");
}

function getSubscriptionKey(id: string): string {
  return `${PUSH_SUBSCRIPTION_PREFIX}${id}`;
}

function getInstallKey(installId: string): string {
  return `${PUSH_INSTALL_PREFIX}${installId}`;
}

function getSubscribeRateLimitKey(ipHash: string): string {
  return `${PUSH_SUBSCRIBE_RATE_LIMIT_PREFIX}${ipHash}`;
}

function getSmaStateKey(subscriptionId: string, config: SmaSignalConfig): string {
  return `${PUSH_LAST_SMA_STATE_PREFIX}${subscriptionId}:${buildSmaSignalConfigFingerprint(config)}`;
}

function normalizePushSubscriptionRecord(record: PushSubscriptionRecord): NormalizedPushSubscriptionRecord {
  return {
    ...record,
    smaConfig: normalizePushSmaConfig(record.smaConfig ?? DEFAULT_SMA_CONFIG),
  };
}

function normalizeStoredSmaPushState(record: StoredSmaPushState | null): StoredSmaPushState | null {
  if (!record) return null;
  return {
    ...record,
    pendingInitialNotification: Boolean(record.pendingInitialNotification),
  };
}

export function shouldSeedInitialSmaPushNotification(params: {
  hasExistingSubscription: boolean;
  configChanged: boolean;
  carryForwardPendingInitialNotification: boolean;
}): boolean {
  return (
    !params.hasExistingSubscription ||
    params.configChanged ||
    params.carryForwardPendingInitialNotification
  );
}

function hashInstallRateLimitKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function getRequestIp(request: Request): string | null {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const first = forwardedFor.split(",")[0]?.trim();
    if (first) return first;
  }
  const realIp = request.headers.get("x-real-ip")?.trim();
  return realIp || null;
}

function assertSameOrigin(request: Request): void {
  const requestOrigin = new URL(request.url).origin;
  const origin = request.headers.get("origin")?.trim();
  const referer = request.headers.get("referer")?.trim();
  const refererOrigin = referer ? (() => {
    try {
      return new URL(referer).origin;
    } catch {
      return null;
    }
  })() : null;

  if (origin && origin !== requestOrigin) {
    throw new Error("Invalid origin");
  }
  if (!origin && refererOrigin && refererOrigin !== requestOrigin) {
    throw new Error("Invalid origin");
  }
  if (!origin && !refererOrigin) {
    throw new Error("Missing origin");
  }
}

async function applySubscribeRateLimit(installId: string, ip: string | null): Promise<void> {
  const now = Date.now();
  const installKey = getSubscribeRateLimitKey(`install:${installId}`);
  const ipHash = hashInstallRateLimitKey(ip ?? "unknown");
  const ipKey = getSubscribeRateLimitKey(`ip:${ipHash}`);
  const redis = getPushRedis();
  const installLast = await redis.get<number>(installKey);
  if (typeof installLast === "number" && now - installLast < PUSH_SUBSCRIBE_RATE_LIMIT_SECONDS * 1000) {
    throw new Error("Please wait a moment before updating alerts again.");
  }
  const ipCount = (await redis.incr(ipKey)) as number;
  if (ipCount === 1) {
    await redis.expire(ipKey, PUSH_SUBSCRIBE_IP_WINDOW_SECONDS);
  }
  if (ipCount > PUSH_SUBSCRIBE_IP_MAX) {
    throw new Error("Too many alert signups from this network. Please wait a moment and try again.");
  }
  await redis.setex(installKey, PUSH_SUBSCRIBE_RATE_LIMIT_SECONDS, now);
}

export async function savePushSubscription(
  input: unknown,
  options?: { smaConfig?: unknown; userAgent?: string; installId?: unknown; request?: Request }
): Promise<PushSubscriptionRecord> {
  if (!hasPushStorageConfig()) {
    throw new Error("Push storage is not configured");
  }

  const subscription = normalizePushSubscription(input);
  const smaConfig = normalizePushSmaConfig(options?.smaConfig ?? DEFAULT_SMA_CONFIG);
  const installId = pushInstallIdSchema.parse(options?.installId);
  if (options?.request) {
    assertSameOrigin(options.request);
  }
  const requestIp = options?.request ? getRequestIp(options.request) : null;
  await applySubscribeRateLimit(installId, requestIp);
  const id = getPushSubscriptionId(subscription.endpoint);
  const key = getSubscriptionKey(id);
  const redis = getPushRedis();
  const existing = await redis.get<PushSubscriptionRecord>(key);
  const normalizedExisting = existing ? normalizePushSubscriptionRecord(existing) : null;
  const existingInstallSubscriptionId = await redis.get<string>(getInstallKey(installId));
  const existingInstallRecord =
    existingInstallSubscriptionId && existingInstallSubscriptionId !== id
      ? await redis.get<PushSubscriptionRecord>(getSubscriptionKey(existingInstallSubscriptionId))
      : null;
  const normalizedExistingInstallRecord = existingInstallRecord
    ? normalizePushSubscriptionRecord(existingInstallRecord)
    : null;
  const existingInstallState =
    existingInstallSubscriptionId && normalizedExistingInstallRecord
      ? await getStoredSmaPushState(existingInstallSubscriptionId, normalizedExistingInstallRecord.smaConfig)
      : null;
  const previousConfigFingerprint =
    normalizedExisting?.smaConfig
      ? buildSmaSignalConfigFingerprint(normalizedExisting.smaConfig)
      : normalizedExistingInstallRecord
        ? buildSmaSignalConfigFingerprint(normalizedExistingInstallRecord.smaConfig)
        : null;
  const currentConfigFingerprint = buildSmaSignalConfigFingerprint(smaConfig);
  const configChanged =
    previousConfigFingerprint !== null && previousConfigFingerprint !== currentConfigFingerprint;
  const carryForwardPendingInitialNotification = Boolean(existingInstallState?.pendingInitialNotification);
  const now = new Date().toISOString();

  if (
    normalizedExisting &&
    buildSmaSignalConfigFingerprint(normalizedExisting.smaConfig) !== currentConfigFingerprint
  ) {
    await redis.del(getSmaStateKey(id, normalizedExisting.smaConfig));
  }

  const record: PushSubscriptionRecord = {
    id,
    installId,
    endpoint: subscription.endpoint,
    expirationTime: subscription.expirationTime ?? null,
    keys: subscription.keys,
    smaConfig,
    createdAt: normalizedExisting?.createdAt ?? now,
    updatedAt: now,
    userAgent: options?.userAgent,
  };

  if (existingInstallSubscriptionId && existingInstallSubscriptionId !== id) {
    if (normalizedExistingInstallRecord) {
      await redis.del(getSmaStateKey(existingInstallSubscriptionId, normalizedExistingInstallRecord.smaConfig));
    }
    await redis.del(getSubscriptionKey(existingInstallSubscriptionId));
    await redis.srem(PUSH_SUBSCRIPTIONS_KEY, existingInstallSubscriptionId);
  }

  await redis.set(key, record);
  await redis.sadd(PUSH_SUBSCRIPTIONS_KEY, id);
  await redis.set(getInstallKey(installId), id);

  try {
    const marketData = await fetchSmaMarketData();
    const current = await getCurrentSmaSignalSnapshot(smaConfig, marketData);
    if (
      shouldSeedInitialSmaPushNotification({
        hasExistingSubscription: Boolean(normalizedExisting),
        configChanged,
        carryForwardPendingInitialNotification,
      })
    ) {
      await setStoredSmaPushState(id, smaConfig, current, {
        pendingInitialNotification: true,
      });
    } else {
      const stored = await getStoredSmaPushState(id, smaConfig);
      if (!stored) {
        await setStoredSmaPushState(id, smaConfig, current);
      }
    }
  } catch (error) {
    console.warn("[push] Failed to prime SMA alert state for subscription:", error);
  }

  return record;
}

export async function removePushSubscription(
  endpoint: string,
  options?: { installId?: unknown; request?: Request }
): Promise<boolean> {
  if (!hasPushStorageConfig()) {
    throw new Error("Push storage is not configured");
  }

  if (options?.request) {
    assertSameOrigin(options.request);
  }

  const id = getPushSubscriptionId(endpoint);
  const redis = getPushRedis();
  const existing = await redis.get<PushSubscriptionRecord>(getSubscriptionKey(id));
  if (existing) {
    const normalized = normalizePushSubscriptionRecord(existing);
    if (options?.installId && options.installId !== normalized.installId) {
      throw new Error("Push subscription install mismatch");
    }
  }

  const removed = await redis.del(getSubscriptionKey(id));
  await redis.srem(PUSH_SUBSCRIPTIONS_KEY, id);

  if (existing) {
    const normalized = normalizePushSubscriptionRecord(existing);
    await redis.del(getSmaStateKey(id, normalized.smaConfig));
    await redis.del(getInstallKey(normalized.installId));
  }

  return removed > 0;
}

async function listPushSubscriptions(): Promise<PushSubscriptionRecord[]> {
  if (!hasPushStorageConfig()) {
    throw new Error("Push storage is not configured");
  }

  const redis = getPushRedis();
  const ids = (await redis.smembers<string[]>(PUSH_SUBSCRIPTIONS_KEY)) ?? [];
  const records = await Promise.all(
    ids.map(async (id) => redis.get<PushSubscriptionRecord>(getSubscriptionKey(id)))
  );
  return records
    .filter((record): record is PushSubscriptionRecord => Boolean(record))
    .map(normalizePushSubscriptionRecord);
}

async function getStoredSmaPushState(
  subscriptionId: string,
  config: SmaSignalConfig
): Promise<StoredSmaPushState | null> {
  if (!hasPushStorageConfig()) {
    throw new Error("Push storage is not configured");
  }

  return normalizeStoredSmaPushState((await getPushRedis().get<StoredSmaPushState>(getSmaStateKey(subscriptionId, config))) ?? null);
}

async function setStoredSmaPushState(
  subscriptionId: string,
  config: SmaSignalConfig,
  snapshot: SmaSignalSnapshot,
  options?: { pendingInitialNotification?: boolean }
): Promise<StoredSmaPushState> {
  if (!hasPushStorageConfig()) {
    throw new Error("Push storage is not configured");
  }

  const state: StoredSmaPushState = {
    fingerprint: buildSmaSignalFingerprint(snapshot, config),
    snapshot,
    updatedAt: new Date().toISOString(),
    pendingInitialNotification: options?.pendingInitialNotification ?? false,
  };
  await getPushRedis().set(getSmaStateKey(subscriptionId, config), state);
  return state;
}

export function buildSmaPushPayload(
  current: SmaSignalSnapshot,
  previous?: SmaSignalSnapshot | null,
  config: SmaSignalConfig = getDefaultSmaSignalConfig()
): PushSendPayload {
  return {
    title: "L-ETF SMA alert",
    body: describeSmaSignalChange(current, previous, config),
    url: DEFAULT_PUSH_URL,
    tag: DEFAULT_PUSH_TAG,
    timestamp: current.timestamp,
    status: describeSmaSignalStatus(current, config),
  };
}

export function shouldDeliverSmaPushNotification(params: {
  force: boolean;
  currentFingerprint: string;
  previousFingerprint: string | null;
  pendingInitialNotification: boolean;
}): boolean {
  return (
    params.force ||
    params.pendingInitialNotification ||
    params.previousFingerprint !== params.currentFingerprint
  );
}

async function sendPushNotification(
  subscription: PushSubscriptionRecord,
  payload: PushSendPayload
): Promise<void> {
  if (!configureWebPush()) {
    throw new Error("VAPID push keys are not configured");
  }

  const pushSubscription = {
    endpoint: subscription.endpoint,
    expirationTime: subscription.expirationTime ?? undefined,
    keys: subscription.keys as PushSubscriptionKeys,
  };

  await webpush.sendNotification(pushSubscription, JSON.stringify(payload));
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function shortFp(fp: string | null): string {
  if (!fp) return "none";
  return fp.slice(0, 10);
}

export async function sendSmaPushNotifications(
  options: SendSmaPushNotificationsOptions = {}
): Promise<SmaPushDeliveryResult> {
  const force = options.force ?? false;

  if (!hasPushStorageConfig()) {
    console.log("[push] Skipping send: push storage not configured (UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN missing)");
    return {
      changed: false,
      forced: force,
      evaluated: 0,
      sent: 0,
      removed: 0,
      skippedReason: "Push storage is not configured",
    };
  }

  const subscriptions = await listPushSubscriptions();
  console.log(`[push] Loaded ${subscriptions.length} subscription(s); force=${force}`);
  if (subscriptions.length === 0) {
    console.log("[push] Skipping send: no push subscribers");
    return {
      changed: false,
      forced: force,
      evaluated: 0,
      sent: 0,
      removed: 0,
      skippedReason: "No push subscribers",
    };
  }

  const marketData = await fetchSmaMarketData();
  const snapshotCache = new Map<string, Promise<SmaSignalSnapshot>>();
  let sent = 0;
  let removed = 0;
  let changedAny = false;
  let evaluated = 0;
  let transientFailures = 0;

  const results = await Promise.allSettled(
    subscriptions.map(async (subscription): Promise<SmaPushDeliveryItemResult> => {
      evaluated += 1;
      const subTag = `[push] sub=${shortId(subscription.id)}`;
      const configFingerprint = buildSmaSignalConfigFingerprint(subscription.smaConfig);

      let currentPromise = snapshotCache.get(configFingerprint);
      if (!currentPromise) {
        currentPromise = getCurrentSmaSignalSnapshot(subscription.smaConfig, marketData);
        snapshotCache.set(configFingerprint, currentPromise);
      }

      const current = await currentPromise;
      console.log(
        `${subTag} config=${describeSmaSignalConfig(subscription.smaConfig)} configFp=${shortFp(configFingerprint)}`
      );

      const previous = await getStoredSmaPushState(subscription.id, subscription.smaConfig);
      const fingerprint = buildSmaSignalFingerprint(current, subscription.smaConfig);
      const previousFingerprint = previous?.fingerprint ?? null;
      const pendingInitialNotification = previous?.pendingInitialNotification ?? false;
      const changed = previousFingerprint !== fingerprint;
      const subscriptionForce = force || Boolean(subscription.smaConfig.notifyEveryClose);
      const shouldSend = shouldDeliverSmaPushNotification({
        force: subscriptionForce,
        currentFingerprint: fingerprint,
        previousFingerprint,
        pendingInitialNotification,
      });

      console.log(
        `${subTag} prevFp=${shortFp(previousFingerprint)} currFp=${shortFp(fingerprint)} changed=${changed} pendingInitial=${pendingInitialNotification} force=${force} notifyEveryClose=${subscription.smaConfig.notifyEveryClose} → shouldSend=${shouldSend}`
      );

      if (!shouldSend) {
        if (!previous) {
          await setStoredSmaPushState(subscription.id, subscription.smaConfig, current);
          console.log(`${subTag} skip: no prior state — initialized alert state`);
          return {
            subscriptionId: subscription.id,
            configFingerprint,
            fingerprint,
            previousFingerprint,
            changed: false,
            sent: false,
            removed: false,
            skippedReason: "Initialized alert state",
          };
        }

        console.log(`${subTag} skip: SMA status unchanged (no force, no pending initial)`);
        return {
          subscriptionId: subscription.id,
          configFingerprint,
          fingerprint,
          previousFingerprint,
          changed: false,
          sent: false,
          removed: false,
          skippedReason: "SMA status unchanged",
        };
      }

      const reason = force
        ? "force"
        : pendingInitialNotification
          ? "pendingInitial"
          : changed
            ? "fingerprintChanged"
            : subscription.smaConfig.notifyEveryClose
              ? "notifyEveryClose"
              : "force";
      const payload = buildSmaPushPayload(current, previous?.snapshot ?? null, subscription.smaConfig);
      console.log(`${subTag} sending: reason=${reason} title="${payload.title}" body="${payload.body}"`);
      await sendPushNotification(subscription, payload);
      await setStoredSmaPushState(subscription.id, subscription.smaConfig, current);
      console.log(`${subTag} sent OK`);

      return {
        subscriptionId: subscription.id,
        configFingerprint,
        fingerprint,
        previousFingerprint,
        changed: changed || pendingInitialNotification || force,
        sent: true,
        removed: false,
      };
    })
  );

  for (let i = 0; i < results.length; i += 1) {
    const result = results[i];
    const subscription = subscriptions[i];
    if (result.status === "fulfilled") {
      changedAny ||= result.value.changed;
      if (result.value.sent) sent += 1;
      continue;
    }

    if (isGonePushError(result.reason)) {
      console.log(`[push] sub=${shortId(subscription.id)} gone (404/410) — pruning`);
      try {
        await removePushSubscription(subscription.endpoint);
        removed += 1;
      } catch (error) {
        console.warn(`[push] sub=${shortId(subscription.id)} failed to prune expired subscription:`, error);
      }
    } else {
      transientFailures += 1;
      console.error(`[push] sub=${shortId(subscription.id)} failed to deliver:`, result.reason);
    }
  }

  console.log(
    `[push] Summary: evaluated=${evaluated} sent=${sent} removed=${removed} transientFailures=${transientFailures} forced=${force}`
  );

  if (sent === 0 && transientFailures > 0) {
    throw new Error("Failed to deliver SMA push notifications");
  }

  return {
    changed: changedAny,
    forced: force,
    evaluated,
    sent,
    removed,
  };
}

function isGonePushError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const maybe = error as { statusCode?: number; status?: number };
  return maybe.statusCode === 404 || maybe.statusCode === 410 || maybe.status === 404 || maybe.status === 410;
}
