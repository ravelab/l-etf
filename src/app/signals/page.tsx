"use client";

import { useCallback, useEffect, useState } from "react";
import { Input } from "@/components/ui/Input";
import { BufferPairInput } from "@/components/ui/BufferPairInput";
import { Card } from "@/components/ui/Card";
import { ClientOnly } from "@/components/tools/ClientOnly";
import { SignalCard } from "@/components/home/SignalCard";
import { SmaPushAlertsCard } from "@/components/home/SmaPushAlertsCard";
import { VolGateCheckbox } from "@/components/tools/VolGateCheckbox";
import { InflationAdjustedCheckbox } from "@/components/tools/InflationAdjustedCheckbox";
import { getSharedInputs } from "@/lib/hooks/use-shared-inputs";
import { DEFAULT_SMA_INFLATION_ADJUSTED, getDefaultSmaLowerBuffer, getDefaultSmaPeriod, getDefaultSmaUpperBuffer, getInflationAdjustedDefaultSmaBand } from "@/lib/simulation/defaults";
import { getStoredPushAlertConfig } from "@/lib/push/client";
import type { PushSmaConfig } from "@/lib/push/types";
import type { SmaSignalResult } from "@/lib/sma-signals";
import type { SmaCalibrationResult } from "@/lib/sma-calibration";
import cagrPresets from "@/lib/tool-snapshots/sma-cagr-presets.json";
import inflationCagrPresets from "@/lib/tool-snapshots/sma-cagr-presets-inflation.json";
import { SmaPresetsCard, type SmaPreset } from "@/components/home/SmaPresetsCard";
import type { SmaCalibrationVariant } from "@/lib/sma-calibration-variant";

const HIGHER_TURNOVER_KEY = "signals-higher-turnover";
const USE_CALIBRATED_DEFAULTS_KEY = "signals-use-calibrated-defaults";
interface SmaSignalsResponse {
  sp500: SmaSignalResult;
  nasdaq100: SmaSignalResult;
  timestamp: string;
  error?: {
    details?: {
      requestedRange?: { startDate: string; endDate: string };
      sp500Rows?: number;
      nasdaq100Rows?: number;
    };
    troubleshooting?: string[];
  };
}

/**
 * The form restores the visitor's saved inputs from localStorage in its first
 * render, so it cannot be server-rendered: a saved band that differs from the
 * calibrated default failed hydration. Only the heading is in the server HTML.
 */
export default function SignalsPage() {
  return (
    <div className="min-h-screen bg-background text-foreground p-3 md:p-6">
      <div className="max-w-7xl mx-auto space-y-4 md:space-y-6">
        <h1 className="text-3xl md:text-4xl font-bold">Signals</h1>
        <ClientOnly>
          <SignalsPageContent />
        </ClientOnly>
      </div>
    </div>
  );
}

function SignalsPageContent() {
  const { inputs, persist } = getSharedInputs();

  const [smaSpPeriod, setSmaSpPeriod] = useState(inputs.smaSpPeriod ?? 160);
  const [smaSpUpperBuffer, setSmaSpUpperBuffer] = useState(inputs.smaSpUpperBuffer ?? 4);
  const [smaSpLowerBuffer, setSmaSpLowerBuffer] = useState(inputs.smaSpLowerBuffer ?? 4);
  const [smaSpEnabled, setSmaSpEnabled] = useState(inputs.smaSpEnabled ?? true);
  const [smaNqPeriod, setSmaNqPeriod] = useState(inputs.smaNqPeriod ?? 70);
  const [smaNqUpperBuffer, setSmaNqUpperBuffer] = useState(inputs.smaNqUpperBuffer ?? 12);
  const [smaNqLowerBuffer, setSmaNqLowerBuffer] = useState(inputs.smaNqLowerBuffer ?? 12);
  const [smaNqEnabled, setSmaNqEnabled] = useState(inputs.smaNqEnabled ?? true);
  const [smaVolGate, setSmaVolGate] = useState(inputs.smaVolGate ?? true);
  const [higherTurnover, setHigherTurnover] = useState(() => {
    const saved = window.localStorage.getItem(HIGHER_TURNOVER_KEY)?.split(",") ?? [];
    return { sp500: saved.includes("sp500"), nasdaq100: saved.includes("nasdaq100") };
  });
  const [smaInflationAdjusted, setSmaInflationAdjusted] = useState(inputs.smaInflationAdjusted ?? DEFAULT_SMA_INFLATION_ADJUSTED);
  // notifyEveryClose is push-only, persisted under the push alert config blob,
  // so it survives reloads even though it isn't part of the shared input set.
  const [notifyEveryClose, setNotifyEveryClose] = useState(false);

  useEffect(() => {
    const stored = getStoredPushAlertConfig();
    if (stored && typeof stored.notifyEveryClose === "boolean") {
      Promise.resolve().then(() => setNotifyEveryClose(stored.notifyEveryClose));
    }
  }, []);

  const [useCalibratedDefaults, setUseCalibratedDefaultsState] = useState(false);
  const pushSmaConfig: PushSmaConfig = {
    smaSpPeriod,
    smaSpUpperBuffer, smaSpLowerBuffer,
    smaSpEnabled,
    smaNqPeriod,
    smaNqUpperBuffer, smaNqLowerBuffer,
    smaNqEnabled,
    smaVolGate,
    smaSpHigherTurnover: higherTurnover.sp500,
    smaNqHigherTurnover: higherTurnover.nasdaq100,
    smaInflationAdjusted,
    notifyEveryClose,
    useCalibratedDefaults,
  };

  const [signalResponse, setSignalResponse] = useState<{ query: string; data: SmaSignalsResponse } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [calibration, setCalibration] = useState<SmaCalibrationResult | null>(null);

  // Push alerts that follow the calibration follow the set matching the switch.
  useEffect(() => {
    fetch(`/api/sma-calibration${smaInflationAdjusted ? "?variant=inflation" : ""}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setCalibration(data))
      .catch(() => setCalibration(null));
  }, [smaInflationAdjusted]);
  // A preset applies its own index's band and the set's inflation switch: the
  // inflation-adjusted bands were calibrated on the deflated index, the others on
  // the index as quoted, so each only means what it scored with its own setting.
  const handleSetPreset = useCallback((indexKey: "sp500" | "nasdaq100", preset: SmaPreset, variant: SmaCalibrationVariant) => {
    const rule = !preset.useDefaultBand ? preset[indexKey]
      : variant === "inflation" ? getInflationAdjustedDefaultSmaBand(indexKey)
        : {
          smaPeriod: getDefaultSmaPeriod(indexKey),
          smaUpperBuffer: getDefaultSmaUpperBuffer(indexKey),
          smaLowerBuffer: getDefaultSmaLowerBuffer(indexKey),
        };
    if (indexKey === "sp500") {
      setSmaSpPeriod(rule.smaPeriod);
      setSmaSpUpperBuffer(rule.smaUpperBuffer);
      setSmaSpLowerBuffer(rule.smaLowerBuffer);
    } else {
      setSmaNqPeriod(rule.smaPeriod);
      setSmaNqUpperBuffer(rule.smaUpperBuffer);
      setSmaNqLowerBuffer(rule.smaLowerBuffer);
    }
    setHigherTurnover((current) => ({ ...current, [indexKey]: preset.higherTurnover === true }));
    if (preset.higherTurnover) setSmaVolGate(true);
    setSmaInflationAdjusted(variant === "inflation");
  }, []);

  useEffect(() => {
    const stored = window.localStorage.getItem(USE_CALIBRATED_DEFAULTS_KEY);
    if (stored === "true") Promise.resolve().then(() => setUseCalibratedDefaultsState(true));
  }, []);

  const handleUseCalibratedDefaultsChange = useCallback((value: boolean) => {
    setUseCalibratedDefaultsState(value);
    window.localStorage.setItem(USE_CALIBRATED_DEFAULTS_KEY, String(value));
  }, []);

  useEffect(() => {
    persist({
      smaSpPeriod,
      smaSpUpperBuffer, smaSpLowerBuffer,
      smaSpEnabled,
      smaNqPeriod,
      smaNqUpperBuffer, smaNqLowerBuffer,
      smaNqEnabled,
      smaVolGate,
      smaInflationAdjusted,
    });
  }, [smaSpPeriod, smaSpUpperBuffer, smaSpLowerBuffer, smaSpEnabled, smaNqPeriod, smaNqUpperBuffer, smaNqLowerBuffer, smaNqEnabled, smaVolGate, smaInflationAdjusted, persist]);

  useEffect(() => {
    window.localStorage.setItem(HIGHER_TURNOVER_KEY,
      (["sp500", "nasdaq100"] as const).filter((index) => higherTurnover[index]).join(","));
  }, [higherTurnover]);

  const params = new URLSearchParams({
    smaSpPeriod: String(smaSpPeriod),
    smaSpUpperBuffer: String(smaSpUpperBuffer),
    smaSpLowerBuffer: String(smaSpLowerBuffer),
    smaNqPeriod: String(smaNqPeriod),
    smaNqUpperBuffer: String(smaNqUpperBuffer),
    smaNqLowerBuffer: String(smaNqLowerBuffer),
    smaVolGate: smaVolGate ? "1" : "0",
    smaInflationAdjusted: smaInflationAdjusted ? "1" : "0",
  });
  if (higherTurnover.sp500) params.set("smaSpHigherTurnover", "1");
  if (higherTurnover.nasdaq100) params.set("smaNqHigherTurnover", "1");
  const query = params.toString();
  const signals = signalResponse?.query === query ? signalResponse.data : null;

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    const timer = setTimeout(async () => {
      setLoading(true);
      setError(null);

      try {
        const res = await fetch(`/api/sma-signals?${query}`, { signal });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `HTTP ${res.status}`);
        }

        const data = await res.json();
        if (!signal.aborted) setSignalResponse({ query, data });
      } catch (err) {
        if (!signal.aborted) setError(err instanceof Error ? err.message : "Failed to fetch signals");
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    }, 500);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  const handleConfigChange = useCallback((field: keyof PushSmaConfig, value: boolean) => {
    if (field === "smaSpEnabled") setSmaSpEnabled(value);
    if (field === "smaNqEnabled") setSmaNqEnabled(value);
    if (field === "notifyEveryClose") setNotifyEveryClose(value);
  }, []);

  return (
    <>
      <Card>
          <h2 className="text-lg font-semibold mb-4">SMA Parameters</h2>
          <fieldset className="grid grid-cols-2 md:grid-cols-4 gap-4 border-0 m-0 p-0">
            <Input
              label="SPX SMA Period"
              info="How many trading days the SPX moving-average line is averaged over. When the SPX price rises above this line, the strategy holds the leveraged ETF. When it falls below, the strategy switches to the safe asset."
              type="number"
              min={5}
              max={500}
              suffix="days"
              value={smaSpPeriod}
              onChange={(e) => setSmaSpPeriod(Number(e.target.value))}
            />
            <BufferPairInput
              label="SPX SMA Buffer"
              info="Two cushions around the SPX moving-average line. The first (with the −) is the below-SMA threshold: SPX has to fall this far below to switch out of the leveraged ETF. The second is the above-SMA threshold: SPX has to rise this far above to switch back in. Set both the same for symmetric behaviour."
              lowerValue={smaSpLowerBuffer}
              upperValue={smaSpUpperBuffer}
              onLowerChange={setSmaSpLowerBuffer}
              onUpperChange={setSmaSpUpperBuffer}
            />
            <Input
              label="NDX SMA Period"
              info="How many trading days the NDX moving-average line is averaged over. When the NDX price rises above this line, the strategy holds the leveraged ETF. When it falls below, the strategy switches to the safe asset."
              type="number"
              min={5}
              max={500}
              suffix="days"
              value={smaNqPeriod}
              onChange={(e) => setSmaNqPeriod(Number(e.target.value))}
            />
            <BufferPairInput
              label="NDX SMA Buffer"
              info="Two cushions around the NDX moving-average line. The first (with the −) is the below-SMA threshold: NDX has to fall this far below to switch out of the leveraged ETF. The second is the above-SMA threshold: NDX has to rise this far above to switch back in. Set both the same for symmetric behaviour."
              lowerValue={smaNqLowerBuffer}
              upperValue={smaNqUpperBuffer}
              onLowerChange={setSmaNqLowerBuffer}
              onUpperChange={setSmaNqUpperBuffer}
            />
            <InflationAdjustedCheckbox checked={smaInflationAdjusted} onChange={setSmaInflationAdjusted} />
            <VolGateCheckbox checked={smaVolGate} onChange={setSmaVolGate} higherTurnover={higherTurnover} />
          </fieldset>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-6">
          <SignalCard
            indexName="SPX"
            indexKey="sp500"
            smaPeriod={smaSpPeriod}
            higherTurnover={higherTurnover.sp500}
            result={signals?.sp500 ?? null}
            loading={loading}
          />
          <SignalCard
            indexName="NDX"
            indexKey="nasdaq100"
            smaPeriod={smaNqPeriod}
            higherTurnover={higherTurnover.nasdaq100}
            result={signals?.nasdaq100 ?? null}
            loading={loading}
          />
        </div>
      </Card>

      <SmaPushAlertsCard
        smaConfig={pushSmaConfig}
        calibration={calibration}
        onConfigChange={handleConfigChange}
        useCalibratedDefaults={useCalibratedDefaults}
        onUseCalibratedDefaultsChange={handleUseCalibratedDefaultsChange}
      />

      {error && (
        <div className="mt-6 p-4 bg-red-500/10 border border-red-500/50 rounded-lg">
          <p className="text-red-400 font-semibold mb-2">{error}</p>
          {signals?.error && typeof signals.error === "object" && (
            <div className="text-sm text-red-300 mt-2">
              {signals.error.details && (
                <>
                  <p className="mb-1">Requested range: {signals.error.details.requestedRange?.startDate} to {signals.error.details.requestedRange?.endDate}</p>
                  <p className="mb-1">SPX rows: {signals.error.details.sp500Rows}, NDX rows: {signals.error.details.nasdaq100Rows}</p>
                </>
              )}
              {signals.error.troubleshooting && (
                <div className="mt-2 space-y-1">
                  <p className="font-semibold">Troubleshooting:</p>
                  {signals.error.troubleshooting.map((step: string, i: number) => (
                    <p key={i} className="ml-4">• {step}</p>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <SmaPresetsCard
        title="Inflation-adjusted SMA defaults and alternatives"
        description="The site default. These bands measure the index in today's dollars, so only a gain after inflation keeps the strategy in. Pick the calibrated default or an alternative for each index; picking one turns on “SMA buffer inflation adjusted”."
        set={inflationCagrPresets}
        ariaSuffix=" (inflation adjusted)"
        testId="sma-presets-inflation"
        onSet={(indexKey, preset) => handleSetPreset(indexKey, preset, "inflation")}
      />
      <SmaPresetsCard
        title="Nominal SMA defaults and alternatives"
        description="Calibrated with each band run on the index as quoted; choosing one clears “SMA buffer inflation adjusted”."
        set={cagrPresets}
        testId="sma-presets-nominal"
        onSet={(indexKey, preset) => handleSetPreset(indexKey, preset, "nominal")}
      />
    </>
  );
}
