"use client";

import { useEffect, useState, useCallback } from "react";
import { Input } from "@/components/ui/Input";
import { Card } from "@/components/ui/Card";
import { SignalCard } from "@/components/home/SignalCard";
import { SmaPushAlertsCard } from "@/components/home/SmaPushAlertsCard";
import { getSharedInputs } from "@/lib/hooks/use-shared-inputs";
import { getStoredPushAlertConfig } from "@/lib/push/client";
import type { PushSmaConfig } from "@/lib/push/types";
import type { SmaSignalResult } from "@/lib/sma-signals";

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

export default function SignalsPage() {
  const { inputs, persist } = getSharedInputs();

  const [smaSpPeriod, setSmaSpPeriod] = useState(inputs.smaSpPeriod ?? 160);
  const [smaSpBuffer, setSmaSpBuffer] = useState(inputs.smaSpBuffer ?? 4);
  const [smaSpEnabled, setSmaSpEnabled] = useState(inputs.smaSpEnabled ?? true);
  const [smaNqPeriod, setSmaNqPeriod] = useState(inputs.smaNqPeriod ?? 70);
  const [smaNqBuffer, setSmaNqBuffer] = useState(inputs.smaNqBuffer ?? 12);
  const [smaNqEnabled, setSmaNqEnabled] = useState(inputs.smaNqEnabled ?? true);
  // notifyEveryClose is push-only, persisted under the push alert config blob,
  // so it survives reloads even though it isn't part of the shared input set.
  const [notifyEveryClose, setNotifyEveryClose] = useState(false);

  useEffect(() => {
    const stored = getStoredPushAlertConfig();
    if (stored && typeof stored.notifyEveryClose === "boolean") {
      Promise.resolve().then(() => setNotifyEveryClose(stored.notifyEveryClose));
    }
  }, []);

  const pushSmaConfig: PushSmaConfig = {
    smaSpPeriod,
    smaSpBuffer,
    smaSpEnabled,
    smaNqPeriod,
    smaNqBuffer,
    smaNqEnabled,
    notifyEveryClose,
  };

  const [signals, setSignals] = useState<SmaSignalsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    persist({
      smaSpPeriod,
      smaSpBuffer,
      smaSpEnabled,
      smaNqPeriod,
      smaNqBuffer,
      smaNqEnabled,
    });
  }, [smaSpPeriod, smaSpBuffer, smaSpEnabled, smaNqPeriod, smaNqBuffer, smaNqEnabled, persist]);

  const fetchSignals = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({
        smaSpPeriod: String(smaSpPeriod),
        smaSpBuffer: String(smaSpBuffer),
        smaNqPeriod: String(smaNqPeriod),
        smaNqBuffer: String(smaNqBuffer),
      });

      const res = await fetch(`/api/sma-signals?${params}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      const data = await res.json();
      setSignals(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch signals");
    } finally {
      setLoading(false);
    }
  }, [smaSpPeriod, smaSpBuffer, smaNqPeriod, smaNqBuffer]);

  useEffect(() => {
    const timer = setTimeout(() => {
      fetchSignals();
    }, 500);

    return () => clearTimeout(timer);
  }, [fetchSignals]);

  const handleConfigChange = useCallback((field: keyof PushSmaConfig, value: boolean) => {
    if (field === "smaSpEnabled") setSmaSpEnabled(value);
    if (field === "smaNqEnabled") setSmaNqEnabled(value);
    if (field === "notifyEveryClose") setNotifyEveryClose(value);
  }, []);

  return (
    <div className="min-h-screen bg-background text-foreground p-3 md:p-6">
      <div className="max-w-7xl mx-auto space-y-4 md:space-y-6">
        <h1 className="text-3xl md:text-4xl font-bold">Signals</h1>

        <Card>
            <h2 className="text-lg font-semibold mb-4">SMA Parameters</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
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
              <Input
                label="SPX SMA Buffer"
                info="A cushion around the SPX moving-average line. Price has to rise this far above the line to switch into the leveraged ETF, or fall this far below to switch out. A small buffer prevents flipping back and forth on tiny moves."
                type="number"
                step={0.1}
                min={0}
                max={30}
                suffix="%"
                value={smaSpBuffer}
                onChange={(e) => setSmaSpBuffer(Number(e.target.value))}
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
              <Input
                label="NDX SMA Buffer"
                info="A cushion around the NDX moving-average line. Price has to rise this far above the line to switch into the leveraged ETF, or fall this far below to switch out. A small buffer prevents flipping back and forth on tiny moves."
                type="number"
                step={0.1}
                min={0}
                max={30}
                suffix="%"
                value={smaNqBuffer}
                onChange={(e) => setSmaNqBuffer(Number(e.target.value))}
              />
            </div>
            <div className="mt-4 min-h-[20px] text-sm text-muted">
              {"\u00A0"}
            </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-6">
            <SignalCard
              indexName="SPX"
              smaPeriod={smaSpPeriod}
              result={signals?.sp500 ?? null}
              loading={loading}
            />
            <SignalCard
              indexName="NDX"
              smaPeriod={smaNqPeriod}
              result={signals?.nasdaq100 ?? null}
              loading={loading}
            />
          </div>
        </Card>

        <SmaPushAlertsCard 
          smaConfig={pushSmaConfig} 
          onConfigChange={handleConfigChange}
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
      </div>
    </div>
  );
}
