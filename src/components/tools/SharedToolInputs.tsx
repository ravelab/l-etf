"use client";

import { useRef, type ReactNode } from "react";
import { Input } from "@/components/ui/Input";
import { BufferPairInput } from "@/components/ui/BufferPairInput";
import { Select } from "@/components/ui/Select";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { CalendarShortcutIcon } from "@/components/ui/CalendarShortcutIcon";
import {
  CONSTANT_NASDAQ100_SHORTCUT_DATE,
  CONSTANT_NASDAQ100_START_DATE,
  CONSTANT_SP500_PROXY_START_DATE,
  CONSTANT_SP500_SHORTCUT_DATE,
  CONSTANT_SP500_START_DATE,
  RISK_OFF_ASSET_OPTIONS,
} from "@/lib/constants";
import { getIsoDate } from "@/lib/date";
import { parseNumberOrKeep } from "@/lib/utils";
import type { EtfConfig } from "@/lib/simulation/types";

type PresetOption = { value: string; label: string };

type DatePresetOption = {
  value: string;
  label: string;
  title: string;
};

const HISTORICAL_DATE_PRESETS: readonly DatePresetOption[] = [
  {
    value: CONSTANT_SP500_START_DATE,
    label: "SPX proto",
    title: "Earliest S&P row (Cowles-era reconstruction)",
  },
  {
    value: CONSTANT_SP500_PROXY_START_DATE,
    label: "SPX proxy",
    title: "Start of the rules-based proxy: the market's biggest 30% by size",
  },
  {
    value: CONSTANT_SP500_SHORTCUT_DATE,
    label: "SPX start",
    title: "SPX start used by the app",
  },
  {
    value: CONSTANT_NASDAQ100_START_DATE,
    label: "NDX proto",
    title: "Earliest Nasdaq row (Composite scaled to meet NDX)",
  },
  {
    value: CONSTANT_NASDAQ100_SHORTCUT_DATE,
    label: "NDX start",
    title: "Start of the app's actual Nasdaq-100 series",
  },
];

function CompactDatePresetSelect({
  ariaLabel,
  currentDate,
  dateRange,
  options,
  onSelect,
}: {
  ariaLabel: string;
  currentDate: string;
  dateRange: { min: string; max: string };
  options: readonly DatePresetOption[];
  onSelect: (value: string) => void;
}) {
  const selectedOption = options.find((option) => option.value === currentDate);
  const selectedValue = selectedOption?.value ?? "__custom";

  return (
    <span
      className="relative inline-flex h-5 w-[4.25rem] min-w-0 shrink-0 items-center rounded border border-card-border bg-input-bg text-muted transition-colors hover:border-accent/40 focus-within:border-accent/60"
      title={selectedOption?.title ?? `Custom date (${currentDate.replace(/-/g, "/")})`}
    >
      <span className="pointer-events-none absolute left-0 inline-flex scale-[0.68] items-center">
        <CalendarShortcutIcon />
      </span>
      <select
        aria-label={ariaLabel}
        value={selectedValue}
        onChange={(event) => onSelect(event.currentTarget.value)}
        className="h-full w-full cursor-pointer appearance-none bg-transparent pl-[13px] pr-[7px] text-[8.5px] font-medium leading-none text-foreground outline-none"
      >
        {!selectedOption && (
          <option value="__custom" disabled>
            Custom
          </option>
        )}
        {options.map((option) => (
          <option
            key={option.value}
            value={option.value}
            disabled={option.value < dateRange.min || option.value > dateRange.max}
          >
            {option.label}
          </option>
        ))}
      </select>
      <svg
        aria-hidden="true"
        viewBox="0 0 8 5"
        className="pointer-events-none absolute right-0.5 h-1.5 w-1.5 text-muted/70"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
      >
        <path d="m1 1 3 3 3-3" />
      </svg>
    </span>
  );
}

export type SharedFieldValues = {
  letf?: string;
  startDate: string;
  endDate: string;
  windowLength: number;
  smaSpPeriod?: number;
  smaNqPeriod?: number;
  smaSpUpperBuffer?: number;
  smaSpLowerBuffer?: number;
  smaNqUpperBuffer?: number;
  smaNqLowerBuffer?: number;
  riskOffAsset?: EtfConfig["riskOffAsset"];
};

type SharedToolInputsProps = {
  /** Current field values. Omit optional fields to hide them. */
  values: SharedFieldValues;
  /** Called when any field changes. */
  onChange: <K extends keyof SharedFieldValues>(field: K, value: NonNullable<SharedFieldValues[K]>) => void;
  /** Date picker min/max bounds. */
  dateRange: { min: string; max: string };
  /** If provided, renders a preset selector as the first field. */
  presetOptions?: readonly PresetOption[];
  /** Custom end date onChange handler (e.g. for clamping start date). */
  onEndDateChange?: (value: string) => void;
  /** Custom end date "today" click handler. */
  onEndDateToday?: () => void;
  /** Run button config. */
  onRun: () => void;
  onCancel?: () => void;
  loading: boolean;
  runLabel: string;
  /** Progress bar state. */
  progress?: { pct: number; label: string } | null;
  /** Error message. */
  error?: string | null;
  /** Show duration/step inputs. Default true. */
  showRollingFields?: boolean;
  /** Reserve the duration/step grid slots even when those fields are hidden. */
  reserveRollingSlotsWhenHidden?: boolean;
  /** Page-specific fields rendered in the grid after duration/step. */
  children?: ReactNode;
  /** Footer content rendered below the button. */
  footer?: ReactNode;
};

export function SharedToolInputs({
  values,
  onChange,
  dateRange,
  presetOptions,
  onEndDateChange,
  onEndDateToday,
  onRun,
  onCancel,
  loading,
  runLabel,
  progress,
  error,
  showRollingFields = true,
  reserveRollingSlotsWhenHidden = false,
  children,
  footer,
}: SharedToolInputsProps) {
  const num = (field: keyof SharedFieldValues, current: number) =>
    (e: React.ChangeEvent<HTMLInputElement>) =>
      onChange(field, parseNumberOrKeep(e.currentTarget.value, current) as never);

  const setEndDate = (value: string) => {
    if (onEndDateChange) {
      onEndDateChange(value);
      return;
    }
    onChange("endDate", value);
  };

  const defaultEndDateToday = () => setEndDate(getIsoDate(new Date()));
  const today = getIsoDate(new Date());
  const endDatePresets: readonly DatePresetOption[] = [
    { value: today, label: "Today", title: `Today (${today.replace(/-/g, "/")})` },
    ...HISTORICAL_DATE_PRESETS,
  ];
  const getEndDateMinusYears = (years: number): string => {
    const endDate = new Date(values.endDate);
    endDate.setFullYear(endDate.getFullYear() - years);
    return clampDateToRange(endDate);
  };
  const clampDateToRange = (date: Date): string => {
    const minDate = new Date(dateRange.min);
    const maxDate = new Date(dateRange.max);
    if (date < minDate) return dateRange.min;
    if (date > maxDate) return dateRange.max;
    return getIsoDate(date);
  };

  const getStartDateForYears = (years: number): string => {
    const endDate = new Date(values.endDate);
    endDate.setFullYear(endDate.getFullYear() - years);
    return clampDateToRange(endDate);
  };

  // Track the last date set by -20Y so repeated clicks keep subtracting
  const lastSteppedDate = useRef<string | null>(null);

  const getFullRangeWindowYears = (): number => {
    const start = new Date(values.startDate);
    const end = new Date(values.endDate);
    const ms = end.getTime() - start.getTime();
    if (!Number.isFinite(ms) || ms <= 0) return 1;
    const years = ms / (365.25 * 24 * 60 * 60 * 1000);
    return Math.max(1, Math.ceil(years));
  };

  const setMaxWindow = () => {
    onChange("windowLength", getFullRangeWindowYears());
  };

  const setWindowYears = (years: number) => {
    onChange("windowLength", years);
  };

  const getSteppedStartDateForYears = (years: number): string => {
    // First click (or user manually changed start date): jump to endDate - years
    if (lastSteppedDate.current !== values.startDate) {
      const target = getStartDateForYears(years);
      lastSteppedDate.current = target;
      return target;
    }
    // Subsequent clicks: keep subtracting from current start date
    const currentStart = new Date(values.startDate);
    currentStart.setFullYear(currentStart.getFullYear() - years);
    const result = clampDateToRange(currentStart);
    lastSteppedDate.current = result;
    return result;
  };

  return (
    <Card>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Input
          data-testid="shared-tool-start-date"
          label="Start Date"
          labelAccessory={
            <CompactDatePresetSelect
              ariaLabel="Start date preset"
              currentDate={values.startDate}
              dateRange={dateRange}
              options={HISTORICAL_DATE_PRESETS}
              onSelect={(value) => onChange("startDate", value)}
            />
          }
          type="date"
          value={values.startDate}
          min={dateRange.min}
          max={dateRange.max}
          onChange={(e) => onChange("startDate", e.currentTarget.value)}
          labelActions={[
            {
              icon: <span className="text-xs font-medium">-20Y</span>,
              title: "Set start date 20 years earlier; first click uses end date",
              onClick: () => onChange("startDate", getSteppedStartDateForYears(20)),
            },
          ]}
        />
        <Input
          data-testid="shared-tool-end-date"
          label="End Date"
          labelAccessory={
            <CompactDatePresetSelect
              ariaLabel="End date preset"
              currentDate={values.endDate}
              dateRange={dateRange}
              options={endDatePresets}
              onSelect={(value) => {
                if (value === today) {
                  (onEndDateToday ?? defaultEndDateToday)();
                  return;
                }
                setEndDate(value);
              }}
            />
          }
          type="date"
          value={values.endDate}
          min={dateRange.min}
          max={dateRange.max}
          onChange={
            onEndDateChange
              ? (e) => onEndDateChange(e.currentTarget.value)
              : (e) => onChange("endDate", e.currentTarget.value)
          }
          labelActions={[
            {
              icon: <span className="text-xs font-medium">-20Y</span>,
              title: "Set end date 20 years earlier",
              onClick: () => setEndDate(getEndDateMinusYears(20)),
            },
          ]}
        />
        {showRollingFields && (
          <Input
            label="Window"
            info="How many years each test period covers. The tool runs many overlapping tests — each one starts a month after the last — then averages the results. e.g. a 10-year window from Jan 2000 tests Jan 2000-Jan 2010, Feb 2000-Feb 2010, and so on. When a window starts late enough that it would run past the latest trade date, the tail wraps back through earlier history (never future data past the end date) so recent starting months still produce full-length windows."
            type="number"
            min={1}
            suffix="years"
            value={values.windowLength}
            onChange={num("windowLength", values.windowLength)}
            labelActions={[
              {
                icon: <span className="text-xs font-medium">5</span>,
                title: "Set duration to 5 years",
                onClick: () => setWindowYears(5),
                className: "ml-1",
              },
              {
                icon: <span className="text-xs font-medium">10</span>,
                title: "Set duration to 10 years",
                onClick: () => setWindowYears(10),
                className: "ml-1",
              },
              {
                icon: <span className="text-xs font-medium">Max</span>,
                title: "Use full date range (single window)",
                onClick: setMaxWindow,
                className: "ml-1",
              },
            ]}
          />
        )}
        {!showRollingFields && reserveRollingSlotsWhenHidden && (
          <div aria-hidden="true" className="hidden md:block" />
        )}
        {presetOptions && values.letf !== undefined && (
          <Select
            label="LETF"
            info="Which leveraged ETF to test. e.g. UPRO = 3x SPX, TQQQ = 3x NDX. Combo presets run both the SPX and NDX strategies and show the results side-by-side."
            options={presetOptions}
            value={values.letf}
            onChange={(e) => onChange("letf", e.currentTarget.value)}
          />
        )}

        {/* Page-specific fields */}
        {children}

        {values.smaSpPeriod !== undefined && (
          <Input
            label="SPX SMA Period"
            info="How many trading days the SPX moving-average line is averaged over. When the SPX price rises above this line, the strategy holds the leveraged ETF. When it falls below, the strategy switches to the safe asset."
            type="number"
            min={5}
            max={500}
            suffix="days"
            value={values.smaSpPeriod}
            onChange={num("smaSpPeriod", values.smaSpPeriod)}
          />
        )}
        {values.smaSpUpperBuffer !== undefined && values.smaSpLowerBuffer !== undefined && (
          <BufferPairInput
            label="SPX SMA Buffer"
            info="Two cushions around the SPX moving-average line. The first (with the −) is the below-SMA threshold: SPX has to fall this far below to switch out of the leveraged ETF. The second is the above-SMA threshold: SPX has to rise this far above to switch back in. Set both the same for symmetric behaviour."
            lowerValue={values.smaSpLowerBuffer}
            upperValue={values.smaSpUpperBuffer}
            onLowerChange={(v) => onChange("smaSpLowerBuffer", v as never)}
            onUpperChange={(v) => onChange("smaSpUpperBuffer", v as never)}
          />
        )}
        {values.smaNqPeriod !== undefined && (
          <Input
            label="NDX SMA Period"
            info="How many trading days the NDX moving-average line is averaged over. When the NDX price rises above this line, the strategy holds the leveraged ETF. When it falls below, the strategy switches to the safe asset."
            type="number"
            min={5}
            max={500}
            suffix="days"
            value={values.smaNqPeriod}
            onChange={num("smaNqPeriod", values.smaNqPeriod)}
          />
        )}
        {values.smaNqUpperBuffer !== undefined && values.smaNqLowerBuffer !== undefined && (
          <BufferPairInput
            label="NDX SMA Buffer"
            info="Two cushions around the NDX moving-average line. The first (with the −) is the below-SMA threshold: NDX has to fall this far below to switch out of the leveraged ETF. The second is the above-SMA threshold: NDX has to rise this far above to switch back in. Set both the same for symmetric behaviour."
            lowerValue={values.smaNqLowerBuffer}
            upperValue={values.smaNqUpperBuffer}
            onLowerChange={(v) => onChange("smaNqLowerBuffer", v as never)}
            onUpperChange={(v) => onChange("smaNqUpperBuffer", v as never)}
          />
        )}
        {values.riskOffAsset !== undefined && (
          <Select
            label="Risk-Off Asset"
            info="What you hold when the strategy is out of the leveraged ETF. Choices: SGOV or VGSH (short-term Treasuries), GLDM (gold), BRK.B, VOO, QQQ, or equal-weight blends of these (e.g. BRK.B + GLDM)."
            options={RISK_OFF_ASSET_OPTIONS}
            value={values.riskOffAsset}
            onChange={(e) => onChange("riskOffAsset", e.currentTarget.value as EtfConfig["riskOffAsset"])}
          />
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-4 min-h-[40px]">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={(e) => {
              e.preventDefault();
              if (loading && onCancel) {
                onCancel();
              } else if (!loading) {
                onRun();
              }
            }}
            variant={loading && onCancel ? "secondary" : "primary"}
            disabled={loading && !onCancel}
          >
            {loading ? (onCancel ? "Cancel" : "Running...") : runLabel}
          </Button>
        </div>

        {loading && progress && (
          <div className="flex-1 min-w-[150px] relative">
            <div className="flex items-center gap-3">
              <ProgressBar progress={progress.pct} className="flex-1" />
              <span className="text-[10px] tabular-nums font-medium text-muted uppercase tracking-wider whitespace-nowrap">
                {Math.round(progress.pct)}%
              </span>
            </div>
            <div className="absolute top-full left-0 right-0 pt-0.5">
              <div className="text-[9px] uppercase tracking-widest text-muted truncate">
                {progress.label}
              </div>
            </div>
          </div>
        )}
      </div>

      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}

      {footer && <div className="mt-4">{footer}</div>}
    </Card>
  );
}
