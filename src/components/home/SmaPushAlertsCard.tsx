"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Toggle } from "@/components/ui/Toggle";
import {
  clearStoredPushAlertConfig,
  fetchPushPublicKey,
  getCurrentPushSubscription,
  getStoredPushAlertConfig,
  isIosDevice,
  isPushSupported,
  isStandaloneApp,
  setStoredPushAlertConfig,
  subscribeToPushAlerts,
  unsubscribeFromPushAlerts,
} from "@/lib/push/client";
import type { PushSmaConfig } from "@/lib/push/types";

type PushState = {
  status: "checking" | "unsupported" | "ready" | "subscribed" | "install-first" | "error";
  message: string;
};

type SmaPushAlertsCardProps = {
  smaConfig: PushSmaConfig;
  onConfigChange?: (field: keyof PushSmaConfig, value: boolean) => void;
  useCalibratedDefaults: boolean;
  onUseCalibratedDefaultsChange: (value: boolean) => void;
};

function formatConfigSuffix(config: PushSmaConfig | null): string {
  if (!config) return "";
  const parts = [];
  if (config.smaSpEnabled) {
    parts.push(`SPX: ${config.smaSpPeriod}/−${config.smaSpLowerBuffer}/${config.smaSpUpperBuffer}%`);
  }
  if (config.smaNqEnabled) {
    parts.push(`NDX: ${config.smaNqPeriod}/−${config.smaNqLowerBuffer}/${config.smaNqUpperBuffer}%`);
  }
  if (parts.length === 0) return " (Disabled)";
  return ` (${parts.join(", ")})`;
}

export function SmaPushAlertsCard({ smaConfig, onConfigChange, useCalibratedDefaults, onUseCalibratedDefaultsChange }: SmaPushAlertsCardProps) {
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [subscriptionActive, setSubscriptionActive] = useState(false);
  const [subscriptionConfig, setSubscriptionConfig] = useState<PushSmaConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [browserState, setBrowserState] = useState({
    ready: false,
    canUsePush: false,
    installFirst: false,
  });
  const [state, setState] = useState<PushState>({
    status: "checking",
    message: "Checking push support...",
  });

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setBrowserState({
        ready: true,
        canUsePush: isPushSupported(),
        installFirst: isIosDevice() && !isStandaloneApp(),
      });
    }, 0);

    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      if (!browserState.ready) {
        return;
      }

      if (!browserState.canUsePush) {
        if (!cancelled) {
          setState({
            status: "unsupported",
            message: "This browser does not support web push notifications.",
          });
        }
        return;
      }

      if (browserState.installFirst) {
        if (!cancelled) {
          setState({
            status: "install-first",
            message: "Install the app to your Home Screen on iPhone before enabling alerts.",
          });
        }
      }

      const [subscription, key] = await Promise.all([
        getCurrentPushSubscription().catch(() => null),
        fetchPushPublicKey().catch(() => null),
      ]);

      if (cancelled) return;

      setSubscriptionActive(Boolean(subscription));
      setPublicKey(key);
      const stored = getStoredPushAlertConfig();
      setSubscriptionConfig(stored);

      if (subscription) {
        setState({
          status: "subscribed",
          message: `Push alerts are enabled on this device${formatConfigSuffix(stored)}.`,
        });
        return;
      }

      if (!key) {
        setState({
          status: "error",
          message: "Push alerts are not configured yet.",
        });
        return;
      }

      setState({
        status: browserState.installFirst ? "install-first" : "ready",
        message: browserState.installFirst
          ? "Install the app to your Home Screen on iPhone before enabling alerts."
          : "Install the app on your phone or use a supported desktop browser, then enable alerts to get notified when the SMA signal changes.",
      });
    }

    void init();

    return () => {
      cancelled = true;
    };
  }, [browserState]);

  const calibratedDefaultsChanged = Boolean(subscriptionConfig?.useCalibratedDefaults) !== useCalibratedDefaults;

  const spActive = subscriptionActive && !!subscriptionConfig?.smaSpEnabled;
  const spNeedsUpdate = spActive && (
    subscriptionConfig.smaSpPeriod !== smaConfig.smaSpPeriod ||
    subscriptionConfig.smaSpUpperBuffer !== smaConfig.smaSpUpperBuffer ||
    subscriptionConfig.smaSpLowerBuffer !== smaConfig.smaSpLowerBuffer ||
    calibratedDefaultsChanged
  );

  const nqActive = subscriptionActive && !!subscriptionConfig?.smaNqEnabled;
  const nqNeedsUpdate = nqActive && (
    subscriptionConfig.smaNqPeriod !== smaConfig.smaNqPeriod ||
    subscriptionConfig.smaNqUpperBuffer !== smaConfig.smaNqUpperBuffer ||
    subscriptionConfig.smaNqLowerBuffer !== smaConfig.smaNqLowerBuffer ||
    calibratedDefaultsChanged
  );

  const handleUpdateSubscription = async (config: PushSmaConfig, successMessage: string) => {
    setBusy(true);
    try {
      if (!browserState.canUsePush) {
        throw new Error("This browser does not support push notifications.");
      }

      if (browserState.installFirst && !subscriptionActive) {
        throw new Error("Open the installed Home Screen app first, then enable alerts.");
      }

      const key = publicKey ?? (await fetchPushPublicKey());
      if (!key) {
        throw new Error("Push alerts are not configured yet.");
      }

      const subscription = await subscribeToPushAlerts(key, config);
      setSubscriptionActive(Boolean(subscription));
      setSubscriptionConfig(config);
      setStoredPushAlertConfig(config);
      
      setState({
        status: "subscribed",
        message: `Push alerts are enabled on this device${formatConfigSuffix(config)}.`,
      });
      toast.success(successMessage);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to update push alerts";
      setState((current) => ({
        ...current,
        status: "error",
        message,
      }));
      toast.error(message);
    } finally {
      setBusy(false);
    }
  };

  const handleSpClick = async () => {
    if (spActive && !spNeedsUpdate) {
      const nextConfig = { ...smaConfig, smaSpEnabled: false, smaNqEnabled: nqActive };
      onConfigChange?.("smaSpEnabled", false);
      onConfigChange?.("smaNqEnabled", nqActive);
      if (!nqActive) {
        await handleDisable();
      } else {
        await handleUpdateSubscription(nextConfig, "SPX SMA alerts disabled");
      }
    } else {
      const nextConfig = { ...smaConfig, smaSpEnabled: true, smaNqEnabled: nqActive };
      onConfigChange?.("smaSpEnabled", true);
      onConfigChange?.("smaNqEnabled", nqActive);
      await handleUpdateSubscription(nextConfig, spActive ? "SPX SMA alerts updated" : "SPX SMA alerts enabled");
    }
  };

  const handleNqClick = async () => {
    if (nqActive && !nqNeedsUpdate) {
      const nextConfig = { ...smaConfig, smaSpEnabled: spActive, smaNqEnabled: false };
      onConfigChange?.("smaSpEnabled", spActive);
      onConfigChange?.("smaNqEnabled", false);
      if (!spActive) {
        await handleDisable();
      } else {
        await handleUpdateSubscription(nextConfig, "NDX SMA alerts disabled");
      }
    } else {
      const nextConfig = { ...smaConfig, smaSpEnabled: spActive, smaNqEnabled: true };
      onConfigChange?.("smaSpEnabled", spActive);
      onConfigChange?.("smaNqEnabled", true);
      await handleUpdateSubscription(nextConfig, nqActive ? "NDX SMA alerts updated" : "NDX SMA alerts enabled");
    }
  };

  const handleNotifyEveryCloseChange = async (value: boolean) => {
    onConfigChange?.("notifyEveryClose", value);
    if (subscriptionActive) {
      const nextConfig: PushSmaConfig = {
        ...smaConfig,
        smaSpEnabled: spActive,
        smaNqEnabled: nqActive,
        notifyEveryClose: value,
      };
      await handleUpdateSubscription(
        nextConfig,
        value ? "Daily close notifications enabled" : "Daily close notifications disabled"
      );
    }
  };

  const handleDisable = async () => {
    setBusy(true);
    try {
      await unsubscribeFromPushAlerts();
      setSubscriptionActive(false);
      setSubscriptionConfig(null);
      clearStoredPushAlertConfig();
      setState({
        status: browserState.installFirst ? "install-first" : "ready",
        message: browserState.installFirst
          ? "Install the app to your Home Screen on iPhone before enabling alerts."
          : "Install the app on your phone or use a supported desktop browser, then enable alerts to get notified when the SMA signal changes.",
      });
      toast.success("Push alerts disabled");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to disable push alerts";
      setState((current) => ({
        ...current,
        status: "error",
        message,
      }));
      toast.error(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card id="push-alerts" className="border-accent/30 bg-card-bg/80 scroll-mt-24">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="space-y-3">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-accent/80 font-semibold">
              Alerts
            </p>
            <h2 className="text-xl md:text-2xl font-bold mt-1">Get notified when the signal changes</h2>
          </div>
          <p className="text-sm text-muted max-w-2xl">
            Install the app on your phone or use a supported desktop browser, turn on
            notifications, and we&apos;ll send you an alert when the SMA signal changes. No
            account needed.
          </p>

          <ul className="text-sm text-muted space-y-1 list-disc list-outside pl-5 md:max-w-[60%]">
            <li>iPhone: open in Safari, tap Share, then Add to Home Screen. Then open the installed app and tap Enable alerts.</li>
            <li>Android: open Chrome or another supported browser, then choose Install app or Add to Home screen. Then open the installed app and tap Enable alerts.</li>
            <li>Desktop: use Chrome, Edge, or another supported browser and allow notifications.</li>
          </ul>
        </div>

        <div className="flex w-full flex-col gap-3 md:w-[320px] md:min-w-[320px]">
          <div className="flex flex-col gap-2">
            <Button
              variant={spActive ? (spNeedsUpdate ? "primary" : "secondary") : "primary"}
              onClick={handleSpClick}
              className="w-full whitespace-nowrap"
              disabled={busy || state.status === "unsupported" || state.status === "checking" || (state.status === "install-first" && !subscriptionActive) || !browserState.ready}
            >
              {spActive ? (spNeedsUpdate ? "Update SPX SMA alerts" : "Disable SPX SMA alerts") : "Enable SPX SMA alerts"}
            </Button>

            <Button
              variant={nqActive ? (nqNeedsUpdate ? "primary" : "secondary") : "primary"}
              onClick={handleNqClick}
              className="w-full whitespace-nowrap"
              disabled={busy || state.status === "unsupported" || state.status === "checking" || (state.status === "install-first" && !subscriptionActive) || !browserState.ready}
            >
              {nqActive ? (nqNeedsUpdate ? "Update NDX SMA alerts" : "Disable NDX SMA alerts") : "Enable NDX SMA alerts"}
            </Button>
          </div>
          <div className="pt-1 flex flex-col gap-2">
            <Toggle
              label="Notify me after every market close"
              checked={Boolean(smaConfig.notifyEveryClose)}
              onChange={handleNotifyEveryCloseChange}
            />
            <Toggle
              label="Use default values which are calibrated over time"
              checked={useCalibratedDefaults}
              onChange={onUseCalibratedDefaultsChange}
            />
          </div>
          <p className="text-sm font-bold text-foreground">{state.message}</p>
        </div>
      </div>
    </Card>
  );
}
