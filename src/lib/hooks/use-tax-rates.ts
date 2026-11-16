"use client";

// The tax rates every tool page shares, kept in one store so each page, each
// mounted tab and each run read the same values. Pages must take the rates for a
// run from `getTaxRates()` when the run starts, never from a value a callback
// captured: that is how runs once kept taxing at 0% after rates were picked.

import { useSyncExternalStore } from "react";
import { DEFAULT_FUTURES_TAX_RATES, normalizeTaxRates, type FuturesTaxRates } from "@/lib/simulation/futures-tax";

const STORAGE_KEY = "l-etf-tax-rates-v1";

const listeners = new Set<() => void>();
let current: FuturesTaxRates | null = null;

function loadStored(): FuturesTaxRates {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored ? normalizeTaxRates(JSON.parse(stored)) : DEFAULT_FUTURES_TAX_RATES;
  } catch {
    // Storage unavailable or malformed: the defaults stand.
    return DEFAULT_FUTURES_TAX_RATES;
  }
}

/** The rates the next run is taxed at. Read when the run starts. */
export function getTaxRates(): FuturesTaxRates {
  if (typeof window === "undefined") return DEFAULT_FUTURES_TAX_RATES;
  current ??= loadStored();
  return current;
}

function setTaxRate(key: keyof FuturesTaxRates, value: number): void {
  current = normalizeTaxRates({ ...getTaxRates(), [key]: value });
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    // The rates still apply for this session when storage is unavailable.
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another browser tab changed them.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    current = loadStored();
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** The shared rates for display and the tax inputs. */
export function useTaxRates(): {
  taxRates: FuturesTaxRates;
  changeTaxRate: (key: keyof FuturesTaxRates, value: number) => void;
} {
  const taxRates = useSyncExternalStore(subscribe, getTaxRates, () => DEFAULT_FUTURES_TAX_RATES);
  return { taxRates, changeTaxRate: setTaxRate };
}
