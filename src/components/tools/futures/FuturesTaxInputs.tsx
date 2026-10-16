"use client";

import { Fragment, useId, useState } from "react";
import { InfoPopoverButton } from "@/components/ui/InfoPopoverButton";
import type { FuturesTaxRates } from "@/lib/simulation/futures-tax";

export function FuturesTaxInputs({ rates, onChange }: {
  rates: FuturesTaxRates;
  onChange: (key: keyof FuturesTaxRates, value: number) => void;
}) {
  const labelId = useId();
  return (
    <>
      {([
        ["LTCG / STCG Tax", ["ltcg", "LTCG Tax"], ["stcg", "STCG Tax"],
          "Enter your federal long-term and short-term capital gains rates, respectively. The futures estimate uses 60% of the LTCG rate plus 40% of the STCG rate, regardless of holding period. Taxes reduce invested capital each year; losses carry forward. Actual asset sales and their costs are not simulated."],
        ["State Tax / Medicare Surcharge", ["state", "State Tax"], ["medicare", "Medicare Surcharge"],
          "Enter your state marginal tax rate and net investment income tax (Medicare surcharge) rate, respectively. Both are added to the blended federal futures rate. Enter 0 for a tax that does not apply. The estimate assumes these rates apply to all modeled gains; income thresholds and state deductions are not modeled. Collateral and risk-off taxes are approximated using the same combined rate."],
      ] as const).map(([label, first, second, info], groupIndex) => (
        <div key={label} className="min-w-0 flex flex-col gap-1" role="group" aria-labelledby={`${labelId}-${groupIndex}`}>
          <div className="text-xs text-muted font-medium flex items-center gap-1.5">
            <label id={`${labelId}-${groupIndex}`} htmlFor={`${labelId}-${first[0]}`}>{label}</label>
            <span className="ml-auto inline-flex items-center">
              <InfoPopoverButton label={label}>{info}</InfoPopoverButton>
            </span>
          </div>
          <div className="relative flex items-center gap-1 bg-input-bg border border-card-border rounded-lg px-3 py-1.5 text-sm text-foreground focus-within:border-accent/50 transition-colors">
            {[first, second].map(([key, name], index) => (
              <Fragment key={key}>
                {index === 1 && <span aria-hidden="true" className="text-muted select-none">,</span>}
                <TaxRateCell
                  id={`${labelId}-${key}`}
                  label={name}
                  value={rates[key]}
                  onChange={(value) => onChange(key, value)}
                />
                <span aria-hidden="true" className="text-xs text-muted select-none">%</span>
              </Fragment>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

function TaxRateCell({ id, label, value, onChange }: {
  id: string;
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      id={id}
      aria-label={label}
      type="text"
      inputMode="decimal"
      className="w-12 bg-transparent border-0 px-1 py-0 text-sm text-foreground focus:outline-none text-center"
      value={draft ?? String(value)}
      onFocus={() => setDraft(String(value))}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={() => {
        const parsed = Number(draft);
        if (draft !== null && draft.trim() !== "" && Number.isFinite(parsed)) {
          onChange(Math.max(0, Math.min(100, parsed)));
        }
        setDraft(null);
      }}
    />
  );
}
