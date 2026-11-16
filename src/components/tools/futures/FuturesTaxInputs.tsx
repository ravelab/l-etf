"use client";

import { Fragment, useId } from "react";
import { InfoPopoverButton } from "@/components/ui/InfoPopoverButton";
import type { FuturesTaxRates } from "@/lib/simulation/futures-tax";

export function FuturesTaxInputs({ rates, onChange }: {
  rates: FuturesTaxRates;
  onChange: (key: keyof FuturesTaxRates, value: number) => void;
}) {
  const labelId = useId();
  const options: Record<keyof FuturesTaxRates, number[]> = {
    ltcg: [0, 15, 20],
    stcg: [0, 10, 12, 22, 24, 32, 35, 37],
    state: Array.from({ length: 14 }, (_, rate) => rate),
    medicare: [0, 2, 3.8],
  };
  return (
    <>
      {([
        ["LT Cap Gain, Income Tax", ["ltcg", "LT Cap Gain"], ["stcg", "Income Tax"],
          "Enter your federal long-term and short-term capital gains rates, respectively. The futures estimate uses 60% of the LTCG rate plus 40% of the STCG rate, regardless of holding period. Leveraged ETFs pay the LTCG rate on shares sold after more than a year and the STCG rate otherwise, only when they sell. Taxes leave the account as safe-harbor estimated payments (110% of the prior year's tax, quarterly) with an April true-up; losses carry forward."],
        ["State Tax, NIIT", ["state", "State Tax"], ["medicare", "NIIT"],
          "Choose your state marginal tax rate and net investment income tax (NIIT) rate, respectively. Both are added to each federal rate. Choose 0 for a tax that does not apply. The estimate assumes these rates apply to all modeled gains; income thresholds and state deductions are not modeled. Futures collateral and risk-off taxes are approximated using the futures rate; leveraged ETF strategies' risk-off baskets are taxed as capital gains when sold."],
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
                <TaxRateSelect
                  id={`${labelId}-${key}`}
                  label={name}
                  value={rates[key]}
                  options={options[key]}
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

function TaxRateSelect({ id, label, value, options, onChange }: {
  id: string;
  label: string;
  value: number;
  options: number[];
  onChange: (value: number) => void;
}) {
  return (
    <select
      id={id}
      aria-label={label}
      className="bg-transparent border-0 px-1 py-0 text-sm text-foreground focus:outline-none text-center"
      value={value}
      onChange={(event) => onChange(Number(event.currentTarget.value))}
    >
      {options.map((rate) => <option key={rate} value={rate}>{rate}</option>)}
    </select>
  );
}
