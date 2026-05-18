"use client";

import { type ReactNode, type SelectHTMLAttributes } from "react";
import { InfoPopoverButton } from "./InfoPopoverButton";
import { normalizeSelectValue } from "@/lib/input-normalization";

interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  info?: ReactNode;
  options: readonly SelectOption[];
}

export function Select({
  label,
  info,
  options,
  className = "",
  ...props
}: SelectProps) {
  const selectedValue = normalizeSelectValue(
    props.value,
    options.map((opt) => opt.value),
    options[0]?.value ?? ""
  );

  return (
    <div className="flex flex-col gap-1">
      {label && (
        <label className="text-xs text-muted font-medium flex items-center gap-1.5">
          <span>{label}</span>
          {info && (
            <span className="ml-auto inline-flex items-center">
              <InfoPopoverButton label={label}>{info}</InfoPopoverButton>
            </span>
          )}
        </label>
      )}
      <select
        className={`w-full bg-input-bg border border-card-border rounded-lg px-3 py-1.5 text-sm
          text-foreground focus:outline-none focus:border-accent/50 transition-colors
          appearance-none cursor-pointer ${className}`}
        {...props}
        value={selectedValue}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}
