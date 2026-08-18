import { useState, useCallback, useMemo } from "react";
import { getSharedInputs, SHARED_KEYS } from "@/lib/hooks/use-shared-inputs";
import { usePageCache } from "@/lib/hooks/use-page-cache";
import { applySharedFieldChange } from "@/lib/tool-page-helpers";
import {
  getValidPresetKey,
  resolvePresetContext,
  DEFAULT_COMBO_PRESET,
  ETF_PRESETS
} from "@/lib/simulation/presets";
import type { IndexKey, EtfConfig } from "@/lib/simulation/types";
import type { SharedFieldValues } from "@/components/tools/SharedToolInputs";
import { appendSmaBufferUrlParams } from "@/lib/sma-buffer-url-params";
import {
  normalizeDateString,
  normalizeIndexKey,
  normalizeNumberValue,
  normalizePresetKey,
  normalizeObjectByDefaults,
  normalizeRiskOffAsset,
} from "@/lib/input-normalization";

export function useToolForm<T extends Record<string, unknown>>(
  pageKey: string,
  extraDefaults: T,
  options?: { persistKeys?: Array<keyof T | string> }
) {
  const { inputs: shared, persist: persistShared } = getSharedInputs();

  const sharedDefaults = {
    letf: shared.letf,
    index: "sp500" as IndexKey,
    startDate: shared.startDate,
    endDate: shared.endDate,
    windowLength: shared.windowLength,
    smaSpPeriod: shared.smaSpPeriod,
    smaNqPeriod: shared.smaNqPeriod,
    smaSpUpperBuffer: shared.smaSpUpperBuffer,
    smaSpLowerBuffer: shared.smaSpLowerBuffer,
    smaNqUpperBuffer: shared.smaNqUpperBuffer,
    smaNqLowerBuffer: shared.smaNqLowerBuffer,
    riskOffAsset: shared.riskOffAsset,
  };

  const defaultState = {
    ...sharedDefaults,
    ...extraDefaults,
  };

  const combinedPersistKeys = Array.from(new Set([
    ...Array.from(SHARED_KEYS),
    ...(options?.persistKeys ?? []) as string[]
  ])).filter(key => key in defaultState);

  const { initial, save, restoredFromCache } = usePageCache(pageKey, defaultState, {
    persistKeys: combinedPersistKeys as (keyof typeof defaultState)[],
  });

  const sanitizedInitial = (() => {
    const next = normalizeObjectByDefaults(initial as Record<string, unknown>, defaultState, {
      windowLength: { integer: true, min: 1 },
      smaSpPeriod: { integer: true, min: 1 },
      smaNqPeriod: { integer: true, min: 1 },
      smaSpUpperBuffer: { min: 0 },
      smaSpLowerBuffer: { min: 0 },
      smaNqUpperBuffer: { min: 0 },
      smaNqLowerBuffer: { min: 0 },
      minSmaPeriod: { integer: true, min: 1 },
      maxSmaPeriod: { integer: true, min: 1 },
      stepSize: { integer: true, min: 1 },
      smaMode: { integer: true, min: 0, max: 1 },
    });
    next.letf = normalizePresetKey(next.letf, DEFAULT_COMBO_PRESET);
    next.index = normalizeIndexKey(next.index, "sp500");
    next.startDate = normalizeDateString(next.startDate, shared.startDate);
    next.endDate = normalizeDateString(next.endDate, shared.endDate);
    next.windowLength = normalizeNumberValue(next.windowLength, shared.windowLength, { integer: true, min: 1 });
    next.smaSpPeriod = normalizeNumberValue(next.smaSpPeriod, shared.smaSpPeriod, { integer: true, min: 1 });
    next.smaNqPeriod = normalizeNumberValue(next.smaNqPeriod, shared.smaNqPeriod, { integer: true, min: 1 });
    next.smaSpUpperBuffer = normalizeNumberValue(next.smaSpUpperBuffer, shared.smaSpUpperBuffer, { min: 0 });
    next.smaSpLowerBuffer = normalizeNumberValue(next.smaSpLowerBuffer, shared.smaSpLowerBuffer, { min: 0 });
    next.smaNqUpperBuffer = normalizeNumberValue(next.smaNqUpperBuffer, shared.smaNqUpperBuffer, { min: 0 });
    next.smaNqLowerBuffer = normalizeNumberValue(next.smaNqLowerBuffer, shared.smaNqLowerBuffer, { min: 0 });
    next.riskOffAsset = normalizeRiskOffAsset(next.riskOffAsset, shared.riskOffAsset);
    return next;
  })();

  const [letf, setLetf] = useState<string>(sanitizedInitial.letf);
  const [index, setIndex] = useState<IndexKey>(sanitizedInitial.index);
  const [startDate, setStartDate] = useState(sanitizedInitial.startDate);
  const [endDate, setEndDate] = useState(sanitizedInitial.endDate);
  const [windowLength, setWindowLength] = useState(() => sanitizedInitial.windowLength);
  const [smaSpPeriod, setSmaSpPeriod] = useState(sanitizedInitial.smaSpPeriod);
  const [smaNqPeriod, setSmaNqPeriod] = useState(sanitizedInitial.smaNqPeriod);
  const [smaSpUpperBuffer, setSmaSpUpperBuffer] = useState(sanitizedInitial.smaSpUpperBuffer);
  const [smaSpLowerBuffer, setSmaSpLowerBuffer] = useState(sanitizedInitial.smaSpLowerBuffer);
  const [smaNqUpperBuffer, setSmaNqUpperBuffer] = useState(sanitizedInitial.smaNqUpperBuffer);
  const [smaNqLowerBuffer, setSmaNqLowerBuffer] = useState(sanitizedInitial.smaNqLowerBuffer);
  const [riskOffAsset, setRiskOffAsset] = useState<EtfConfig["riskOffAsset"]>(sanitizedInitial.riskOffAsset as EtfConfig["riskOffAsset"]);

  const { isCombo, selectedPreset, comboSubs, comboLabels } = useMemo(
    () => resolvePresetContext(letf),
    [letf]
  );

  const handleFieldChange = useCallback(
    <K extends keyof SharedFieldValues>(field: K, value: NonNullable<SharedFieldValues[K]>) => {
      applySharedFieldChange(field, value, {
        setters: {
          startDate: setStartDate,
          endDate: setEndDate,
          windowLength: setWindowLength,
          smaSpPeriod: setSmaSpPeriod,
          smaNqPeriod: setSmaNqPeriod,
          smaSpUpperBuffer: setSmaSpUpperBuffer,
          smaSpLowerBuffer: setSmaSpLowerBuffer,
          smaNqUpperBuffer: setSmaNqUpperBuffer,
          smaNqLowerBuffer: setSmaNqLowerBuffer,
          riskOffAsset: setRiskOffAsset,
        } as unknown as Parameters<typeof applySharedFieldChange>[2]["setters"],
        onLetf: (nextValue) => {
          const nextPreset = getValidPresetKey(nextValue as string, DEFAULT_COMBO_PRESET) as keyof typeof ETF_PRESETS;
          setLetf(nextPreset);
        },
      });
      persistShared({ [field]: value });
    },
    [persistShared]
  );

  const getUrlParams = useCallback(() => {
    const urlParams = new URLSearchParams();
    urlParams.set("letf", letf);
    urlParams.set("sd", startDate);
    urlParams.set("ed", endDate);
    urlParams.set("py", String(windowLength));
    urlParams.set("smaPsp", String(smaSpPeriod));
    urlParams.set("smaPnq", String(smaNqPeriod));
    appendSmaBufferUrlParams(urlParams, {
      smaSpUpperBuffer,
      smaSpLowerBuffer,
      smaNqUpperBuffer,
      smaNqLowerBuffer,
    });
    urlParams.set("ro", riskOffAsset);
    return urlParams;
  }, [
    letf, startDate, endDate, windowLength,
    smaSpPeriod, smaNqPeriod,
    smaSpUpperBuffer, smaSpLowerBuffer, smaNqUpperBuffer, smaNqLowerBuffer,
    riskOffAsset
  ]);

  return {
    letf, setLetf,
    index, setIndex,
    startDate, setStartDate,
    endDate, setEndDate,
    windowLength, setWindowLength,
    smaSpPeriod, setSmaSpPeriod,
    smaNqPeriod, setSmaNqPeriod,
    smaSpUpperBuffer, setSmaSpUpperBuffer,
    smaSpLowerBuffer, setSmaSpLowerBuffer,
    smaNqUpperBuffer, setSmaNqUpperBuffer,
    smaNqLowerBuffer, setSmaNqLowerBuffer,
    riskOffAsset, setRiskOffAsset,
    isCombo, selectedPreset, comboSubs, comboLabels,
    handleFieldChange,
    getUrlParams,
    initial,
    save,
    restoredFromCache,
  };
}
