"use client";

import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { describeSmaRiskOffGates } from "@/lib/simulation/risk-off-gates";
import { formatSmaSummary } from "@/lib/buffer-format";
import type nominalPresets from "@/lib/tool-snapshots/sma-cagr-presets.json";

/** One artifact set's presets: the nominal file's shape, shared by the inflation-adjusted one. */
export type SmaPresetSet = Pick<typeof nominalPresets, "presets" | "alternateGates">;
export type SmaPreset = (SmaPresetSet["presets"][number] | SmaPresetSet["alternateGates"]) & {
  useDefaultBand?: boolean;
  alternateGates?: boolean;
};

/**
 * The calibrated default and three alternatives of one artifact set, each button
 * applying its own index only. SPX left and NDX right on desktop.
 */
export function SmaPresetsCard({
  title,
  description,
  set,
  ariaSuffix = "",
  showAllAlternatives = true,
  testId,
  onSet,
}: {
  title: string;
  description: string;
  set: SmaPresetSet;
  /** Appended to each button's accessible name, to tell the two cards' buttons apart. */
  ariaSuffix?: string;
  showAllAlternatives?: boolean;
  testId: string;
  onSet: (indexKey: "sp500" | "nasdaq100", preset: SmaPreset) => void;
}) {
  const ranked = showAllAlternatives ? set.presets : set.presets.slice(0, 2);
  const presets: SmaPreset[] = ranked.map((preset) => ({ ...preset, useDefaultBand: preset.isCalibratedDefault }));
  if (showAllAlternatives) presets.push({ ...set.alternateGates, alternateGates: true });
  return (
    <Card>
      <div data-testid={testId}>
        <h2 className="text-lg font-semibold mb-4">{title}</h2>
        <p className="text-sm text-muted mb-4">{description}</p>
        <div className="flex flex-col items-start gap-2 text-[11px] md:text-sm text-muted">
          <div className="flex w-full min-w-0 flex-col gap-2">
            {presets.map((preset, index) => {
              const label = index === 0 ? "Set default" : `Set alternative ${index}`;
              return (
                <div key={`cagr-preset-${index}`} data-sma-preset={index} className="grid min-w-0 grid-cols-1 items-start gap-1.5 border-b border-card-border pb-2 last:border-0 tabular-nums md:grid-cols-2 md:gap-6">
                  {(["sp500", "nasdaq100"] as const).map((indexKey) => {
                    const rule = preset[indexKey];
                    return (
                      <div key={indexKey} className="w-full min-w-0 leading-7">
                        <Button
                          variant="secondary"
                          size="sm"
                          aria-label={`${indexKey === "sp500" ? "SPX" : "NDX"} ${label}${ariaSuffix}`}
                          onClick={() => onSet(indexKey, preset)}
                          className="mr-2 inline-flex px-2 py-0.5 align-middle text-[11px] md:px-2.5 md:py-1"
                        >
                          {label}
                        </Button>
                        <span data-index-cagrs={indexKey} className="align-middle text-[11px] leading-5">
                          <span className="font-medium text-foreground">
                            {formatSmaSummary(indexKey === "sp500" ? "SPX" : "NDX", rule.smaPeriod, rule.smaLowerBuffer, rule.smaUpperBuffer)}
                          </span>
                          {preset.alternateGates && <span> · {describeSmaRiskOffGates(indexKey, true)}</span>}
                          <span title={`${rule.realCagrStartDate}–${rule.realCagrEndDate}`}> · Real CAGR: {rule.realCagr.toFixed(2)}%</span>
                          {Object.entries(rule.eraCagrs).sort(([a], [b]) => b.localeCompare(a)).map(([eraKey, era]) => (
                            <span key={eraKey} title={`${era.startDate}–${era.endDate}`}>
                              {" · "}{eraKey === "proto" ? "Proto" : "Proxy"}: {era.realCagr.toFixed(2)}%
                            </span>
                          ))}
                          <span title={`${rule.realCagrStartDate}–${rule.realCagrEndDate}`}>
                            {" · "}{rule.trades} switches
                          </span>
                        </span>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </Card>
  );
}
