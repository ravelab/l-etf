import test from "node:test";
import assert from "node:assert/strict";
import {
  describeSmaSignalConfig,
  type SmaSignalSnapshot,
} from "@/lib/sma-status";
import {
  buildSmaPushPayload,
  shouldSeedInitialSmaPushNotification,
  shouldDeliverSmaPushNotification,
} from "@/lib/push/server";
import { pushSubscribePayloadSchema } from "@/lib/push/schema";

test("formats SMA push parameters compactly", () => {
  assert.equal(
    describeSmaSignalConfig({
      smaSpPeriod: 185,
      smaSpBuffer: 3.6,
      smaSpEnabled: true,
      smaNqPeriod: 150,
      smaNqBuffer: 12,
      smaNqEnabled: true,
      notifyEveryClose: false,
    }),
    "SPX 185 SMA, 3.6%; NDX 150 SMA, 12%"
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
    smaSpBuffer: 3.6,
    smaSpEnabled: true,
    smaNqPeriod: 150,
    smaNqBuffer: 12,
    smaNqEnabled: true,
    notifyEveryClose: false,
  };

  const body = buildSmaPushPayload(current, null, config).body;
  assert.equal(body, "SPX: Buy L-ETFs (+5.26%); NDX: Sell L-ETFs (-4.76%)");
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
    smaSpPeriod: 185, smaSpBuffer: 3.6, smaSpEnabled: true,
    smaNqPeriod: 150, smaNqBuffer: 12, smaNqEnabled: false,
    notifyEveryClose: false,
  };

  const payload = buildSmaPushPayload(current, null, config);
  assert.equal(payload.body, "SPX: Buy L-ETFs (+5.26%)");
  assert.doesNotMatch(payload.body, /Parameters:|185 SMA|3\.6%|150 SMA|12%/);
});

test("subscribe payload preserves alert flags", () => {
  const parsed = pushSubscribePayloadSchema.parse({
    subscription: {
      endpoint: "https://push.example/subscription",
      expirationTime: null,
      keys: {
        p256dh: "p256dh",
        auth: "auth",
      },
    },
    installId: "00000000-0000-4000-8000-000000000000",
    smaConfig: {
      smaSpPeriod: 185,
      smaSpBuffer: 3.6,
      smaSpEnabled: false,
      smaNqPeriod: 150,
      smaNqBuffer: 12,
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
