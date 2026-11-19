"use client";

import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { formatSmaSummary } from "@/lib/buffer-format";
import type nominalPresets from "@/lib/tool-snapshots/sma-cagr-presets.json";

/** One artifact set's presets: the nominal file's shape, shared by the inflation-adjusted one. */
export type SmaPresetSet = Pick<typeof nominalPresets, "presets" | "startDate" | "endDate">;
export type SmaPreset = SmaPresetSet["presets"][number];

/** "Set default", then "Set alternative 1".."3" in the file's (score) order. */
function presetLabel(set: SmaPresetSet, index: number): string {
  const preset = set.presets[index];
  return preset.isCalibratedDefault ? "Set default"
    : `Set alternative ${set.presets.slice(0, index + 1).filter((row) => !row.isCalibratedDefault).length}`;
}

/**
 * The calibrated default and three alternatives of one artifact set, each button
 * applying its own index only. SPX left and NDX right on desktop.
 */
export function SmaPresetsCard({
  title,
  description,
  set,
  ariaSuffix = "",
  testId,
  onSet,
}: {
  title: string;
  description: string;
  set: SmaPresetSet;
  /** Appended to each button's accessible name, to tell the two cards' buttons apart. */
  ariaSuffix?: string;
  testId: string;
  onSet: (indexKey: "sp500" | "nasdaq100", preset: SmaPreset) => void;
}) {
  return (
    <Card>
      <div data-testid={testId}>
        <h2 className="text-lg font-semibold mb-4">{title}</h2>
        <p className="text-sm text-muted mb-4">{description}</p>
        <div className="flex flex-col items-start gap-2 text-[11px] md:text-sm text-muted">
          <div className="flex w-full min-w-0 flex-col gap-2">
            {set.presets.map((preset, index) => {
              const label = presetLabel(set, index);
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
                          <span title={`${rule.realCagrStartDate}–${rule.realCagrEndDate}`}> · Real CAGR: {rule.realCagr.toFixed(2)}%</span>
                          {Object.entries(rule.eraCagrs).sort(([a], [b]) => b.localeCompare(a)).map(([eraKey, era]) => (
                            <span key={eraKey} title={`${era.startDate}–${era.endDate}`}>
                              {" · "}{eraKey === "proto" ? "Proto" : "Proxy"}: {era.realCagr.toFixed(2)}%
                            </span>
                          ))}
                          <span title={`${indexKey === "nasdaq100" ? preset.nasdaq100.switchHistory.startDate : set.startDate}–${set.endDate}`}>
                            {" · "}{indexKey === "nasdaq100" ? preset.nasdaq100.switchHistory.count : rule.trades} switches
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
