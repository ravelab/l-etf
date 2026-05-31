"use client";

import { useId, useLayoutEffect, useRef, useState, type ChangeEvent, type FocusEvent, type InputHTMLAttributes, type ReactNode } from "react";
import { InfoPopoverButton } from "./InfoPopoverButton";
import { caretForDigit, countDigits, formatDateDraft, parseDateInput, toDisplayDate } from "@/lib/date-input";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  suffix?: string;
  info?: ReactNode;
  labelAction?: { icon: React.ReactNode; title: string; onClick: () => void; className?: string };
  labelActions?: Array<{ icon: React.ReactNode; title: string; onClick: () => void; className?: string }>;
}

export function Input({ label, suffix, info, labelAction, labelActions, className = "", ...props }: InputProps) {
  const isNumeric = props.type === "number";
  const isDate = props.type === "date";
  const {
    onChange,
    onBlur,
    onFocus,
    value,
    type,
    inputMode,
    id,
    ...rest
  } = props;
  const normalizedType = isNumeric || isDate ? "text" : type;
  const actions = labelActions ?? (labelAction ? [labelAction] : []);
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const [isEditing, setIsEditing] = useState(false);
  const [draftValue, setDraftValue] = useState(() =>
    isDate ? toDisplayDate(toText(value)) : toText(value)
  );
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Caret position to restore after a date reformat reflows the text.
  const pendingCaretRef = useRef<number | null>(null);

  // After auto-inserting "/" separators the input value changes length, which
  // would otherwise push the caret to the end. Restore it next to the digit the
  // user was actually editing.
  useLayoutEffect(() => {
    if (pendingCaretRef.current !== null && inputRef.current) {
      const pos = pendingCaretRef.current;
      inputRef.current.setSelectionRange(pos, pos);
      pendingCaretRef.current = null;
    }
  }, [draftValue]);

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (!isNumeric && !isDate) {
      onChange?.(e);
      return;
    }
    if (isDate) {
      // Auto-format toward YYYY/MM/DD as the user types so mobile keypads (which
      // have no "/") can enter a date with digits alone. We normalize/validate
      // the final value on blur.
      const rawValue = e.currentTarget.value;
      const caret = e.currentTarget.selectionStart ?? rawValue.length;
      const digitsBefore = countDigits(rawValue, caret);
      const formatted = formatDateDraft(rawValue);
      pendingCaretRef.current = caretForDigit(formatted, digitsBefore);
      setDraftValue(formatted);
      return;
    }
    setDraftValue(e.currentTarget.value);
  };

  const handleBlur = (e: FocusEvent<HTMLInputElement>) => {
    if (!isNumeric && !isDate) {
      onBlur?.(e);
      return;
    }
    setIsEditing(false);
    let nextText = toText(value);
    let nextDisplayValue = toText(value);

    if (isNumeric) {
      const trimmed = draftValue.trim();
      const parsed = Number(trimmed);
      const hasValidNumber = trimmed !== "" && Number.isFinite(parsed);
      nextText = hasValidNumber ? String(parsed) : toText(value);
      nextDisplayValue = nextText;
    }

    if (isDate) {
      const parsed = parseDateInput(draftValue);
      const minDate = typeof rest.min === "string" ? rest.min : undefined;
      const maxDate = typeof rest.max === "string" ? rest.max : undefined;
      if (parsed && (!minDate || parsed >= minDate) && (!maxDate || parsed <= maxDate)) {
        nextText = parsed;
      }
      nextDisplayValue = toDisplayDate(nextText);
    }

    setDraftValue(nextDisplayValue);

    const syntheticChangeEvent = {
      ...e,
      currentTarget: {
        ...e.currentTarget,
        value: nextText,
      },
      target: {
        ...e.target,
        value: nextText,
      },
    } as unknown as ChangeEvent<HTMLInputElement>;

    const syntheticBlurEvent = {
      ...e,
      currentTarget: {
        ...e.currentTarget,
        value: nextText,
      },
      target: {
        ...e.target,
        value: nextText,
      },
    } as FocusEvent<HTMLInputElement>;

    onChange?.(syntheticChangeEvent);
    onBlur?.(syntheticBlurEvent);
  };

  const handleFocus = (e: FocusEvent<HTMLInputElement>) => {
    if (isNumeric || isDate) {
      setIsEditing(true);
      setDraftValue(isDate ? toDisplayDate(toText(value)) : toText(value));
    }
    onFocus?.(e);
  };

  return (
    <div className="flex flex-col gap-1">
      {label && (
        <div className="text-xs text-muted font-medium flex items-center gap-1.5">
          <label htmlFor={inputId}>{label}</label>
          {actions.length > 0 && (
            <span className="ml-1 inline-flex items-center gap-1" data-label-actions="true">
              {actions.map((action, idx) => (
                <button
                  key={`${action.title}-${idx}`}
                  type="button"
                  title={action.title}
                  onMouseEnter={() => {
                    const active = document.activeElement;
                    if (
                      active instanceof HTMLButtonElement &&
                      active.closest('[data-label-actions="true"]')
                    ) {
                      active.blur();
                    }
                  }}
                  onClick={(e) => {
                    action.onClick();
                    // Prevent sticky mouse-focus visual state on icon-only controls.
                    e.currentTarget.blur();
                  }}
                  className={`inline-flex h-4 w-fit shrink-0 items-center justify-center rounded-sm border border-transparent p-0 text-muted/60 leading-none hover:border-accent/30 hover:bg-accent/10 hover:text-accent focus:outline-none focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent/50 ${action.className ?? ""}`}
                >
                  <span className="pointer-events-none inline-flex items-center justify-center text-inherit">
                    {action.icon}
                  </span>
                </button>
              ))}
            </span>
          )}
          {info && (
            <span className="ml-auto inline-flex items-center">
              <InfoPopoverButton label={label}>{info}</InfoPopoverButton>
            </span>
          )}
        </div>
      )}
      <div className="relative">
        <input
          ref={inputRef}
          id={inputId}
          className={`w-full bg-input-bg border border-card-border rounded-lg px-3 py-1.5 text-sm
            text-foreground placeholder-muted/50 focus:outline-none focus:border-accent/50
            transition-colors ${suffix ? "pr-8" : ""} ${className}`}
          {...rest}
          type={normalizedType}
          inputMode={isNumeric ? "decimal" : isDate ? "numeric" : inputMode}
          placeholder={isDate ? "YYYY/MM/DD" : rest.placeholder}
          value={isNumeric || isDate ? (isEditing ? draftValue : toDisplayValue(value, isDate)) : value}
          onChange={handleChange}
          onBlur={handleBlur}
          onFocus={handleFocus}
        />
        {suffix && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted">
            {suffix}
          </span>
        )}
      </div>
    </div>
  );
}

function toText(value: InputProps["value"]): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

function toDisplayValue(value: InputProps["value"], isDate: boolean): string {
  const text = toText(value);
  return isDate ? toDisplayDate(text) : text;
}
