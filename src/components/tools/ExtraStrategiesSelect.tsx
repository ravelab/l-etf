"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { InfoPopoverButton } from "@/components/ui/InfoPopoverButton";
import type { SignalRule } from "@/lib/simulation/signal-rules";

type RuleOption = Pick<SignalRule, "id" | "title" | "description" | "sourceUrl">;

function SourceLink({ rule, children }: { rule: RuleOption; children: ReactNode }) {
  if (!rule.sourceUrl) return null;
  return (
    <a
      href={rule.sourceUrl}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${rule.title} source`}
      className="text-accent underline-offset-2 hover:underline"
    >
      {children}
    </a>
  );
}

/**
 * Multi-select of plug-in timing rules (`signal-rules.ts`) to run beside the SMA
 * lines. A field-height button opens a checkbox list the width of its grid cell;
 * the rules' descriptions live in the info popover, which has room for them.
 */
export function ExtraStrategiesSelect({
  rules,
  selected,
  onChange,
}: {
  rules: readonly RuleOption[];
  selected: readonly string[];
  onChange: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const chosen = rules.filter((rule) => selected.includes(rule.id));
  const summary = chosen.length === 0 ? "None" : chosen.map((rule) => rule.title).join(", ");
  // Rebuilt in the rules' own order, so the selection never depends on click order.
  const toggle = (id: string, on: boolean) =>
    onChange(rules.map((rule) => rule.id).filter((ruleId) => (ruleId === id ? on : selected.includes(ruleId))));

  return (
    <div ref={rootRef} className="relative flex min-w-0 flex-col gap-1">
      <div className="text-xs text-muted font-medium flex items-center gap-1.5">
        <span>Extra Strategies</span>
        <span className="ml-auto inline-flex items-center">
          <InfoPopoverButton label="Extra Strategies">
            Other timing rules to run beside the SMA lines, on the same LETF and risk-off asset, so each pair
            differs only in when it is invested. None run by default.
            {rules.map((rule) => (
              <span key={rule.id} className="mt-2 block">
                <span className="text-foreground">{rule.title}:</span> {rule.description}{" "}
                <SourceLink rule={rule}>Source</SourceLink>
              </span>
            ))}
          </InfoPopoverButton>
        </span>
      </div>
      <button
        type="button"
        data-testid="extra-strategies"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className="flex h-[34px] w-full min-w-0 cursor-pointer items-center justify-between gap-2 rounded-lg border border-card-border bg-input-bg px-3 text-left text-sm text-foreground transition-colors hover:border-accent/40"
      >
        <span className="min-w-0 truncate">{summary}</span>
        <svg aria-hidden="true" viewBox="0 0 8 5" className="h-2 w-2 shrink-0 text-muted" fill="none" stroke="currentColor" strokeWidth="1.25">
          <path d="m1 1 3 3 3-3" />
        </svg>
      </button>
      {open && (
        <div
          id={panelId}
          role="group"
          aria-label="Extra strategies"
          className="absolute left-0 right-0 top-full z-20 mt-1 rounded-lg border border-card-border bg-card-bg p-1 shadow-lg"
        >
          {rules.map((rule) => (
            <div key={rule.id} className="flex items-center gap-1 rounded hover:bg-white/5">
              <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-2 py-1.5 text-sm text-foreground">
                <input
                  type="checkbox"
                  className="h-4 w-4 shrink-0 cursor-pointer accent-[var(--accent)]"
                  checked={selected.includes(rule.id)}
                  onChange={(event) => toggle(rule.id, event.currentTarget.checked)}
                />
                <span className="min-w-0 break-words">{rule.title}</span>
              </label>
              {/* Outside the label, so following the link never toggles the box. */}
              <span className="shrink-0 pr-2 text-xs">
                <SourceLink rule={rule}>↗</SourceLink>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
