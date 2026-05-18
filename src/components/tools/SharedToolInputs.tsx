"use client";

import { useRef, type ReactNode } from "react";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { TodayIcon } from "@/components/ui/TodayIcon";
import { CalendarShortcutIcon } from "@/components/ui/CalendarShortcutIcon";
import { CONSTANT_NASDAQ100_SHORTCUT_DATE, CONSTANT_SP500_SHORTCUT_DATE, RISK_OFF_ASSET_OPTIONS } from "@/lib/constants";
import { getIsoDate } from "@/lib/date";
import { parseNumberOrKeep } from "@/lib/utils";
import type { EtfConfig } from "@/lib/simulation/types";

type PresetOption = { value: string; label: string };

export type SharedFieldValues = {
  letf?: string;
  startDate: string;
  endDate: string;
  windowLength: number;
  smaSpPeriod?: number;
  smaNqPeriod?: number;
  smaSpBuffer?: number;
  smaNqBuffer?: number;
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
  const getEndDateMinusYears = (years: number): string => {
    const endDate = new Date(values.endDate);
    endDate.setFullYear(endDate.getFullYear() - years);
    return clampDateToRange(endDate);
  };
  const setSp500ShortcutDate = () => onChange("startDate", CONSTANT_SP500_SHORTCUT_DATE);
  const setNasdaq100ShortcutDate = () => onChange("startDate", CONSTANT_NASDAQ100_SHORTCUT_DATE);

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
          type="date"
          value={values.startDate}
          min={dateRange.min}
          max={dateRange.max}
          onChange={(e) => onChange("startDate", e.currentTarget.value)}
          labelActions={[
            {
              icon: <CalendarShortcutIcon letter="S" />,
              title: `Set to ${CONSTANT_SP500_SHORTCUT_DATE.replace(/-/g, "/")} (SPX)`,
              onClick: setSp500ShortcutDate,
              className: "ml-1",
            },
            {
              icon: <CalendarShortcutIcon letter="N" />,
              title: `Set to ${CONSTANT_NASDAQ100_SHORTCUT_DATE.replace(/-/g, "/")} (NDX)`,
              onClick: setNasdaq100ShortcutDate,
              className: "ml-1",
            },
            {
              icon: <span className="text-xs font-medium">-20Y</span>,
              title: "Set start date 20 years earlier; first click uses end date",
              onClick: () => onChange("startDate", getSteppedStartDateForYears(20)),
              className: "ml-1",
            },
          ]}
        />
        <Input
          data-testid="shared-tool-end-date"
          label="End Date"
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
              icon: <TodayIcon />,
              title: "Set to today",
              onClick: onEndDateToday ?? defaultEndDateToday,
              className: "ml-1",
            },
            {
              icon: <span className="text-xs font-medium">-20Y</span>,
              title: "Set end date 20 years earlier",
              onClick: () => setEndDate(getEndDateMinusYears(20)),
              className: "ml-1",
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
        {values.smaSpBuffer !== undefined && (
          <Input
            label="SPX SMA Buffer"
            info="A cushion around the SPX moving-average line. Price has to rise this far above the line to switch into the leveraged ETF, or fall this far below to switch out. A small buffer prevents flipping back and forth on tiny moves."
            type="number"
            step={0.1}
            min={0}
            max={30}
            suffix="%"
            value={values.smaSpBuffer}
            onChange={num("smaSpBuffer", values.smaSpBuffer)}
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
        {values.smaNqBuffer !== undefined && (
          <Input
            label="NDX SMA Buffer"
            info="A cushion around the NDX moving-average line. Price has to rise this far above the line to switch into the leveraged ETF, or fall this far below to switch out. A small buffer prevents flipping back and forth on tiny moves."
            type="number"
            step={0.1}
            min={0}
            max={30}
            suffix="%"
            value={values.smaNqBuffer}
            onChange={num("smaNqBuffer", values.smaNqBuffer)}
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
