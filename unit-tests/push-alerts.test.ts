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
    smaSpPeriod: 185, smaSpUpperBuffer: 3.6, smaSpLowerBuffer: 3.6, smaSpEnabled: true,
    smaNqPeriod: 150, smaNqUpperBuffer: 12, smaNqLowerBuffer: 12, smaNqEnabled: false,
    notifyEveryClose: false,
    useCalibratedDefaults: false,
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
    startDate: "2020-01-01",
    endDate: "2026-07-06",
    windowLength: 252,
    sp500: { smaPeriod: 185, smaUpperBuffer: 3.6, smaLowerBuffer: 3.6, score: 1, avgReturn: 1, worstReturn: 1, avgMaxDrawdown: 1, avgTrades: 1 },
    nasdaq100: { smaPeriod: 90, smaUpperBuffer: 8, smaLowerBuffer: 8, score: 1, avgReturn: 1, worstReturn: 1, avgMaxDrawdown: 1, avgTrades: 1 },
  };

  const next = applyCalibratedSmaDefaults(config, calibration);

  assert.deepEqual(next, {
    smaSpPeriod: 185, smaSpUpperBuffer: 3.6, smaSpLowerBuffer: 3.6, smaSpEnabled: false,
    smaNqPeriod: 90, smaNqUpperBuffer: 8, smaNqLowerBuffer: 8, smaNqEnabled: true,
    notifyEveryClose: true, useCalibratedDefaults: true,
  });
});
