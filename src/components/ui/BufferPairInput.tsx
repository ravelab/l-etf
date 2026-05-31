"use client";

import { useId, useState, type ChangeEvent, type ReactNode } from "react";
import { InfoPopoverButton } from "./InfoPopoverButton";

interface BufferPairInputProps {
  label: string;
  /** Lower (below-SMA) buffer % — the sell-side threshold. Rendered first, prefixed with `−`. */
  lowerValue: number;
  /** Upper (above-SMA) buffer % — the buy-side threshold. */
  upperValue: number;
  onLowerChange: (value: number) => void;
  onUpperChange: (value: number) => void;
  info?: ReactNode;
  step?: number;
  min?: number;
  max?: number;
}

/**
 * Dual-number input rendered as `− [lower] %, [upper] %` (e.g. `−3.3%, 3%`). The leading
 * minus sign is a visual cue that the first box is the below-SMA threshold
 * (`price < SMA × (1 − lower/100)`). Fits the same horizontal slot as a single `Input`
 * with a `%` suffix.
 */
export function BufferPairInput({
  label,
  lowerValue,
  upperValue,
  onLowerChange,
  onUpperChange,
  info,
  step = 0.1,
  min = 0,
  max = 30,
}: BufferPairInputProps) {
  const labelId = useId();
  return (
    <div className="flex flex-col gap-1">
      <div className="text-xs text-muted font-medium flex items-center gap-1.5">
        <label htmlFor={labelId}>{label}</label>
        {info && (
          <span className="ml-auto inline-flex items-center">
            <InfoPopoverButton label={label}>{info}</InfoPopoverButton>
          </span>
        )}
      </div>
      <div
        className="relative flex items-center gap-1 bg-input-bg border border-card-border rounded-lg px-2 py-1
          text-sm text-foreground focus-within:border-accent/50 transition-colors"
        id={labelId}
      >
        <span className="text-muted select-none px-0.5" aria-hidden="true">
          −
        </span>
        <NumberCell
          ariaLabel={`${label} lower`}
          value={lowerValue}
          onChange={onLowerChange}
          step={step}
          min={min}
          max={max}
        />
        <span className="text-xs text-muted select-none" aria-hidden="true">
          %
        </span>
        <span className="text-muted select-none" aria-hidden="true">
          ,
        </span>
        <NumberCell
          ariaLabel={`${label} upper`}
          value={upperValue}
          onChange={onUpperChange}
          step={step}
          min={min}
          max={max}
        />
        <span className="text-xs text-muted pr-1 select-none" aria-hidden="true">
          %
        </span>
      </div>
    </div>
  );
}

interface NumberCellProps {
  value: number;
  onChange: (value: number) => void;
  ariaLabel: string;
  step: number;
  min: number;
  max: number;
}

function NumberCell({ value, onChange, ariaLabel, step, min, max }: NumberCellProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(() => formatValue(value));

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    setDraft(e.currentTarget.value);
  };
  const handleFocus = () => {
    setIsEditing(true);
    setDraft(formatValue(value));
  };
  const handleBlur = () => {
    setIsEditing(false);
    const trimmed = draft.trim();
    if (trimmed === "") {
      setDraft(formatValue(value));
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      setDraft(formatValue(value));
      return;
    }
    const clamped = Math.max(min, Math.min(max, parsed));
    setDraft(formatValue(clamped));
    if (clamped !== value) onChange(clamped);
  };

  return (
    <input
      type="text"
      inputMode="decimal"
      aria-label={ariaLabel}
      className="w-12 bg-transparent border-0 px-1 py-0 text-sm text-foreground focus:outline-none text-center"
      value={isEditing ? draft : formatValue(value)}
      onChange={handleChange}
      onFocus={handleFocus}
      onBlur={handleBlur}
      step={step}
      min={min}
      max={max}
    />
  );
}

function formatValue(value: number): string {
  if (!Number.isFinite(value)) return "0";
  // Trim trailing zeros after decimal; keep at most 2 fractional digits visually.
  const rounded = Math.round(value * 100) / 100;
  return String(rounded);
}
