"use client";

import { memo, useMemo, useCallback } from "react";
import type { EtfConfig } from "@/lib/simulation/types";
import { ETF_PRESETS, applyPreset, CARD_PRESET_SELECT_OPTIONS } from "@/lib/simulation/presets";
import { Card } from "@/components/ui/Card";
import { Select } from "@/components/ui/Select";

interface EtfConfigCardProps {
  config: EtfConfig;
  index: number;
  onChange: (config: EtfConfig) => void;
  onRemove: () => void;
  canRemove: boolean;
}

// Single presets only (no combos) — sorted the same way as other pages
const PRESET_OPTIONS = CARD_PRESET_SELECT_OPTIONS.filter(
  (opt) => opt.value in ETF_PRESETS
);

// Pre-compute preset lookup map for O(1) access
const PRESET_LOOKUP = new Map(
  Object.entries(ETF_PRESETS).map(([key, p]) => [
    `${p.name}-${p.leverage}-${p.simulated}`,
    key,
  ])
);

export const EtfConfigCard = memo(function EtfConfigCard({
  config,
  index,
  onChange,
  onRemove,
  canRemove,
}: EtfConfigCardProps) {
  const handlePreset = useCallback(
    (presetKey: string) => {
      onChange(applyPreset(config, presetKey));
    },
    [config, onChange]
  );

  // O(1) lookup instead of Object.entries().find()
  const presetValue = useMemo(() => {
    const lookupKey = `${config.name}-${config.leverage}-${config.simulated}`;
    return PRESET_LOOKUP.get(lookupKey) ?? PRESET_OPTIONS[0].value;
  }, [config.name, config.leverage, config.simulated]);

  const color = useMemo(
    () => ["#16f3ce", "#ef4444", "#eab308", "#3b82f6"][index] || "#16f3ce",
    [index]
  );

  return (
    <Card className="relative">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div
            className="w-3 h-3 rounded-full"
            style={{ backgroundColor: color }}
          />
          <span className="text-sm font-medium">ETF {index + 1}</span>
        </div>
        {canRemove && (
          <button
            onClick={onRemove}
            className="text-muted hover:text-red-400 text-xs cursor-pointer"
          >
            Remove
          </button>
        )}
      </div>

      <Select
        options={PRESET_OPTIONS}
        value={presetValue}
        onChange={(e) => handlePreset(e.currentTarget.value)}
      />
    </Card>
  );
});
