"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import {
  AddToHomeIcon,
  BellIcon,
  CheckIcon,
  ChevronRightIcon,
  KebabMenuIcon,
  ShareIcon,
} from "@/components/ui/InstallIcons";
import { detectInstallPlatform, isStandaloneApp, type InstallPlatform } from "@/lib/push/client";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const TABS: Array<{ id: InstallPlatform; label: string }> = [
  { id: "ios", label: "iPhone" },
  { id: "android", label: "Android" },
  { id: "desktop", label: "Desktop" },
];

/**
 * The tap-path a person follows in Safari. Rendered as chips so the sequence
 * reads at a glance instead of as a sentence they have to parse mid-install.
 */
const IOS_PATH: Array<{ icon: ReactNode; label: string }> = [
  { icon: <ShareIcon />, label: "Share" },
  { icon: <AddToHomeIcon />, label: "Add to Home Screen" },
  { icon: <CheckIcon />, label: "Add" },
];

const ANDROID_STEPS: Array<{ icon: ReactNode; title: string; detail: string }> = [
  { icon: <KebabMenuIcon />, title: "Open Chrome's menu", detail: "Tap the ⋮ button in the top-right corner." },
  { icon: <AddToHomeIcon />, title: "Tap \"Install app\"", detail: "Some phones label it \"Add to Home screen\" instead." },
  { icon: <BellIcon />, title: "Open it from your Home Screen", detail: "Then tap Enable alerts below and allow notifications." },
];

const DESKTOP_STEPS: Array<{ icon: ReactNode; title: string; detail: string }> = [
  { icon: <CheckIcon />, title: "Use Chrome or Edge", detail: "Safari on macOS does not deliver web push from a browser tab." },
  { icon: <BellIcon />, title: "Enable alerts and allow notifications", detail: "Tap a button below, then accept the browser's permission prompt." },
];

function StepList({ steps }: { steps: Array<{ icon: ReactNode; title: string; detail: string }> }) {
  return (
    <ol className="space-y-2.5">
      {steps.map((step, index) => (
        <li key={step.title} className="flex items-start gap-3">
          <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-card-border bg-card-bg text-accent">
            {step.icon}
            <span className="absolute -left-1.5 -top-1.5 flex h-4.5 w-4.5 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold leading-none text-accent-contrast">
              {index + 1}
            </span>
          </span>
          <span className="min-w-0 pt-0.5">
            <span className="block text-sm font-semibold text-foreground">{step.title}</span>
            <span className="block text-xs text-muted">{step.detail}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

export function InstallGuide() {
  // Server render is platform-blind, so start neutral and pick the real tab on
  // mount — otherwise the markup would not match and hydration would warn.
  const [platform, setPlatform] = useState<InstallPlatform>("ios");
  const [installed, setInstalled] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    // Deferred rather than set synchronously: reading the platform is a
    // render-time-invisible browser probe, and setting state in the effect body
    // cascades a second render. Same pattern SmaPushAlertsCard uses.
    const timer = window.setTimeout(() => {
      setPlatform(detectInstallPlatform());
      setInstalled(isStandaloneApp());
    }, 0);

    const media = window.matchMedia("(display-mode: standalone)");
    const onDisplayModeChange = () => setInstalled(media.matches);
    const onInstallPrompt = (event: Event) => {
      // Suppress Chrome's mini-infobar so the install lives on our own button.
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setInstallPrompt(null);
    };

    media.addEventListener?.("change", onDisplayModeChange);
    window.addEventListener("beforeinstallprompt", onInstallPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.clearTimeout(timer);
      media.removeEventListener?.("change", onDisplayModeChange);
      window.removeEventListener("beforeinstallprompt", onInstallPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  // Already running as an installed app: the walkthrough is just noise.
  if (installed) return null;

  const handleInstallClick = async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    const choice = await installPrompt.userChoice;
    if (choice.outcome === "accepted") setInstalled(true);
    setInstallPrompt(null);
  };

  return (
    <div id="install-guide" className="rounded-lg border border-card-border bg-background/40 p-3 md:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs uppercase tracking-[0.16em] text-accent/80 font-semibold">
          One-time setup
        </p>
        <div role="tablist" aria-label="Choose your device" className="flex gap-1 rounded-lg border border-card-border p-0.5">
          {TABS.map((tab) => {
            const active = tab.id === platform;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setPlatform(tab.id)}
                className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${
                  active
                    ? "bg-accent text-accent-contrast"
                    : "text-muted hover:text-foreground"
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-3">
        {platform === "ios" && (
          <div className="space-y-2.5">
            <p className="text-sm text-muted">
              Open this page in <strong className="text-foreground">Safari</strong>, then tap:
            </p>
            <ol className="flex flex-wrap items-center gap-1.5">
              {IOS_PATH.map((step, index) => (
                <li key={step.label} className="flex items-center gap-1.5">
                  <span className="inline-flex items-center gap-1.5 rounded-lg border border-card-border bg-card-bg px-2.5 py-1.5 text-sm font-semibold text-foreground">
                    <span className="text-accent">{step.icon}</span>
                    {step.label}
                  </span>
                  {/* Trailing, so a wrap never starts a line with a lone chevron. */}
                  {index < IOS_PATH.length - 1 && <ChevronRightIcon className="text-muted" />}
                </li>
              ))}
            </ol>
            <p className="text-xs text-muted">
              Then open L-ETF from its new Home Screen icon and tap Enable alerts below.
              iPhone only delivers notifications to the installed app, not to a Safari tab.
            </p>
          </div>
        )}

        {platform === "android" && (
          <div className="space-y-3">
            {installPrompt && (
              <Button variant="primary" onClick={handleInstallClick} className="w-full sm:w-auto">
                Install L-ETF
              </Button>
            )}
            <StepList steps={ANDROID_STEPS} />
          </div>
        )}

        {platform === "desktop" && <StepList steps={DESKTOP_STEPS} />}
      </div>
    </div>
  );
}
