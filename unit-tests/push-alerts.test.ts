import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSmaSignalConfigFingerprint,
  describeSmaSignalConfig,
  type SmaSignalConfig,
  type SmaSignalSnapshot,
} from "@/lib/sma-status";
import {
  buildSmaPushPayload,
  shouldSeedInitialSmaPushNotification,
  shouldDeliverSmaPushNotification,
  SMA_PUSH_DELIVERY_OPTIONS,
} from "@/lib/push/server";
import { pushSmaConfigSchema, pushSubscribePayloadSchema } from "@/lib/push/schema";
import { applyCalibratedSmaDefaults, type SmaCalibrationResult } from "@/lib/sma-calibration";

test("formats SMA push parameters compactly", () => {
  assert.equal(
    describeSmaSignalConfig({
      smaSpPeriod: 185,
      smaSpUpperBuffer: 3.6,
      smaSpLowerBuffer: 3.6,
      smaSpEnabled: true,
      smaNqPeriod: 150,
      smaNqUpperBuffer: 12,
      smaNqLowerBuffer: 12,
      smaNqEnabled: true,
      notifyEveryClose: false,
      useCalibratedDefaults: false,
    }),
    "SPX 185 SMA, −3.6%/3.6%; NDX 150 SMA, −12%/12%"
  );
});

test("does not include SMA parameters in the notification body", () => {
  const current: SmaSignalSnapshot = {
    sp500: {
      signal: "buy",
      indexValue: 100,
      indexDate: "2026-04-21",
      smaValue: 95,
      percentDiff: 5.26,
      signalLabel: "Buy",
      signalEmoji: "🟢",
    },
    nasdaq100: {
      signal: "sell",
      indexValue: 100,
      indexDate: "2026-04-21",
      smaValue: 105,
      percentDiff: -4.76,
      signalLabel: "Sell",
      signalEmoji: "🔴",
    },
    timestamp: "2026-04-22T00:00:00.000Z",
  };
  const config = {
    smaSpPeriod: 185,
    smaSpUpperBuffer: 3.6,
    smaSpLowerBuffer: 3.6,
    smaSpEnabled: true,
    smaNqPeriod: 150,
    smaNqUpperBuffer: 12,
    smaNqLowerBuffer: 12,
    smaNqEnabled: true,
    notifyEveryClose: false,
    useCalibratedDefaults: false,
  };

  const payload = buildSmaPushPayload(current, null, config);
  const body = payload.notification.body;
  assert.equal(body, "SPX: Buy L-ETFs (+5.26%); NDX: Sell L-ETFs (-4.76%)");
  assert.equal(payload.body, body, "legacy service workers receive the same body");
  assert.doesNotMatch(body, /Parameters:/);
  assert.doesNotMatch(body, /185 SMA|150 SMA|3\.6%|12%/);
});

test("does not leak disabled SMA parameters into notification", () => {
  const current: SmaSignalSnapshot = {
    sp500: { signal: "buy", indexValue: 100, indexDate: "2026-04-21", smaValue: 95, percentDiff: 5.26, signalLabel: "Buy", signalEmoji: "🟢" },
    nasdaq100: { signal: "sell", indexValue: 100, indexDate: "2026-04-21", smaValue: 105, percentDiff: -4.76, signalLabel: "Sell", signalEmoji: "🔴" },
    timestamp: "2026-04-22T00:00:00.000Z",
  };
  const config = {
    smaSpPeriod: 185, smaSpUpperBuffer: 3.6, smaSpLowerBuffer: 3.6, smaSpEnabled: true,
    smaNqPeriod: 150, smaNqUpperBuffer: 12, smaNqLowerBuffer: 12, smaNqEnabled: false,
    notifyEveryClose: false,
    useCalibratedDefaults: false,
  };

  const payload = buildSmaPushPayload(current, null, config);
  assert.equal(payload.notification.body, "SPX: Buy L-ETFs (+5.26%)");
  assert.doesNotMatch(payload.notification.body, /Parameters:|185 SMA|3\.6%|150 SMA|12%/);
});

test("uses a backwards-compatible declarative Web Push envelope", () => {
  const current: SmaSignalSnapshot = {
    sp500: { signal: "buy", indexValue: 100, indexDate: "2026-04-21", smaValue: 95, percentDiff: 5.26, signalLabel: "Buy", signalEmoji: "🟢" },
    nasdaq100: { signal: "sell", indexValue: 100, indexDate: "2026-04-21", smaValue: 105, percentDiff: -4.76, signalLabel: "Sell", signalEmoji: "🔴" },
    timestamp: "2026-04-22T00:00:00.000Z",
  };

  const payload = buildSmaPushPayload(current);

  assert.equal(payload.web_push, 8030);
  assert.equal(payload.notification.title, payload.title);
  assert.equal(payload.notification.body, payload.body);
  assert.equal(payload.notification.navigate, "https://l-etf.com/signals");
  assert.equal(payload.notification.data.url, "/signals");
  assert.equal(payload.notification.timestamp, Date.parse(current.timestamp));
});

test("subscribe payload preserves alert flags", () => {
  const parsed = pushSubscribePayloadSchema.parse({
    subscription: {
      endpoint: "https://fcm.googleapis.com/fcm/send/subscription",
      expirationTime: null,
      keys: {
        p256dh: "p256dh",
        auth: "auth",
      },
    },
    installId: "00000000-0000-4000-8000-000000000000",
    smaConfig: {
      smaSpPeriod: 185,
      smaSpUpperBuffer: 3.6,
      smaSpLowerBuffer: 3.6,
      smaSpEnabled: false,
      smaNqPeriod: 150,
      smaNqUpperBuffer: 12,
      smaNqLowerBuffer: 12,
      smaNqEnabled: true,
      notifyEveryClose: true,
    },
  });

  assert.equal(parsed.smaConfig.smaSpEnabled, false);
  assert.equal(parsed.smaConfig.smaNqEnabled, true);
  assert.equal(parsed.smaConfig.notifyEveryClose, true);
});

test("forces one notification after a parameter update", () => {
  assert.equal(
    shouldDeliverSmaPushNotification({
      force: false,
      currentFingerprint: "risk-on|risk-off",
      previousFingerprint: "risk-on|risk-off",
      pendingInitialNotification: true,
    }),
    true
  );
});

test("seeds the first notification for new or updated subscriptions", () => {
  assert.equal(
    shouldSeedInitialSmaPushNotification({
      hasExistingSubscription: false,
      configChanged: false,
      carryForwardPendingInitialNotification: false,
    }),
    true
  );

  assert.equal(
    shouldSeedInitialSmaPushNotification({
      hasExistingSubscription: true,
      configChanged: true,
      carryForwardPendingInitialNotification: false,
    }),
    true
  );

  assert.equal(
    shouldSeedInitialSmaPushNotification({
      hasExistingSubscription: true,
      configChanged: false,
      carryForwardPendingInitialNotification: true,
    }),
    true
  );

  assert.equal(
    shouldSeedInitialSmaPushNotification({
      hasExistingSubscription: true,
      configChanged: false,
      carryForwardPendingInitialNotification: false,
    }),
    false
  );
});

test("does not deliver when unchanged and not pending", () => {
  assert.equal(
    shouldDeliverSmaPushNotification({
      force: false,
      currentFingerprint: "risk-on|risk-off",
      previousFingerprint: "risk-on|risk-off",
      pendingInitialNotification: false,
    }),
    false
  );
});

test("defaults useCalibratedDefaults to false but preserves an explicit true", () => {
  const withoutFlag = pushSmaConfigSchema.parse({
    smaSpPeriod: 185, smaSpUpperBuffer: 3.6, smaSpLowerBuffer: 3.6, smaSpEnabled: true,
    smaNqPeriod: 150, smaNqUpperBuffer: 12, smaNqLowerBuffer: 12, smaNqEnabled: true,
  });
  assert.equal(withoutFlag.useCalibratedDefaults, false);

  const withFlag = pushSmaConfigSchema.parse({
    smaSpPeriod: 185, smaSpUpperBuffer: 3.6, smaSpLowerBuffer: 3.6, smaSpEnabled: true,
    smaNqPeriod: 150, smaNqUpperBuffer: 12, smaNqLowerBuffer: 12, smaNqEnabled: true,
    useCalibratedDefaults: true,
  });
  assert.equal(withFlag.useCalibratedDefaults, true);
});

test("useCalibratedDefaults does not affect the signal config fingerprint", () => {
  const base: SmaSignalConfig = {
    smaSpPeriod: 185, smaSpUpperBuffer: 3.6, smaSpLowerBuffer: 3.6, smaSpEnabled: true,
    smaNqPeriod: 150, smaNqUpperBuffer: 12, smaNqLowerBuffer: 12, smaNqEnabled: true,
    notifyEveryClose: false, useCalibratedDefaults: false,
  };

  assert.equal(
    buildSmaSignalConfigFingerprint(base),
    buildSmaSignalConfigFingerprint({ ...base, useCalibratedDefaults: true })
  );
});

test("applyCalibratedSmaDefaults overwrites only the period/buffer fields", () => {
  const config: SmaSignalConfig = {
    smaSpPeriod: 160, smaSpUpperBuffer: 4, smaSpLowerBuffer: 4, smaSpEnabled: false,
    smaNqPeriod: 70, smaNqUpperBuffer: 12, smaNqLowerBuffer: 12, smaNqEnabled: true,
    notifyEveryClose: true, useCalibratedDefaults: true,
  };
  const calibration: SmaCalibrationResult = {
    generatedAt: "2026-07-06T00:00:00.000Z",
    endDate: "2026-07-06",
    windowLength: 252,
    sp500: { startDate: "1988-04-06", smaPeriod: 185, smaUpperBuffer: 3.6, smaLowerBuffer: 3.6, score: 1, avgReturn: 1, worstReturn: 1, avgMaxDrawdown: 1, avgTrades: 1 },
    nasdaq100: { startDate: "1985-10-01", smaPeriod: 90, smaUpperBuffer: 8, smaLowerBuffer: 8, score: 1, avgReturn: 1, worstReturn: 1, avgMaxDrawdown: 1, avgTrades: 1 },
  };

  const next = applyCalibratedSmaDefaults(config, calibration);

  assert.deepEqual(next, {
    smaSpPeriod: 185, smaSpUpperBuffer: 3.6, smaSpLowerBuffer: 3.6, smaSpEnabled: false,
    smaNqPeriod: 90, smaNqUpperBuffer: 8, smaNqLowerBuffer: 8, smaNqEnabled: true,
    notifyEveryClose: true, useCalibratedDefaults: true,
  });
});

test("sends alerts with non-deferrable urgency", () => {
  // `web-push` defaults to "normal", which APNs/FCM may delay or drop when the
  // device is in Low Power Mode or briefly unreachable.
  assert.equal(SMA_PUSH_DELIVERY_OPTIONS.urgency, "high");
});

test("expires an undelivered alert before the next close", () => {
  // Consecutive weekday closes are 24h apart, so the TTL has to be under that:
  // a late alert must never land alongside the signal that superseded it.
  const HOURS_BETWEEN_CONSECUTIVE_CLOSES = 24 * 60 * 60;
  assert.ok(
    SMA_PUSH_DELIVERY_OPTIONS.TTL < HOURS_BETWEEN_CONSECUTIVE_CLOSES,
    `TTL ${SMA_PUSH_DELIVERY_OPTIONS.TTL}s must be shorter than the ${HOURS_BETWEEN_CONSECUTIVE_CLOSES}s between closes`
  );
  assert.ok(SMA_PUSH_DELIVERY_OPTIONS.TTL > 0);
});

test("rejects push endpoints that are not HTTPS URLs on a known push service", () => {
  const base = {
    installId: "3f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b",
    smaConfig: {
      smaSpPeriod: 185,
      smaSpUpperBuffer: 3.6,
      smaSpLowerBuffer: 3.6,
      smaNqPeriod: 150,
      smaNqUpperBuffer: 12,
      smaNqLowerBuffer: 12,
    },
  };
  const parseEndpoint = (endpoint: string) =>
    pushSubscribePayloadSchema.safeParse({
      ...base,
      subscription: { endpoint, keys: { p256dh: "x", auth: "y" } },
    }).success;

  // SSRF vectors: internal metadata, loopback, private ranges, non-HTTPS.
  assert.equal(parseEndpoint("http://169.254.169.254/latest/meta-data/"), false);
  assert.equal(parseEndpoint("https://169.254.169.254/latest/meta-data/"), false);
  assert.equal(parseEndpoint("http://localhost:3000/steal"), false);
  assert.equal(parseEndpoint("https://10.0.0.1/internal"), false);
  assert.equal(parseEndpoint("https://attacker.example.com/collect"), false);
  assert.equal(parseEndpoint("file:///etc/passwd"), false);
  assert.equal(parseEndpoint("not-a-url"), false);
  // Credentials smuggling: authority reads as FCM but resolves to evil.com.
  assert.equal(parseEndpoint("https://fcm.googleapis.com@evil.com/x"), false);
  // Suffix smuggling: not actually a subdomain of a push service.
  assert.equal(parseEndpoint("https://evil-fcm.googleapis.com.attacker.net/x"), false);

  // Real endpoints from the browsers we support must still be accepted.
  assert.equal(parseEndpoint("https://fcm.googleapis.com/fcm/send/abc123"), true);
  assert.equal(
    parseEndpoint("https://updates.push.services.mozilla.com/wpush/v2/abc123"),
    true
  );
  assert.equal(parseEndpoint("https://web.push.apple.com/AbC123"), true);
  assert.equal(parseEndpoint("https://par02p.notify.windows.com/w/?token=abc"), true);
});
