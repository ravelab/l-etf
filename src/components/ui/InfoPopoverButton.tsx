"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

interface InfoPopoverButtonProps {
  label: string;
  children: ReactNode;
}

const POPOVER_MAX_WIDTH = 352;
const VIEWPORT_MARGIN = 12;

/**
 * Detects coarse-pointer (touch) devices. Hover behavior is suppressed there so
 * a tap remains the only way to open/close the popover, matching mobile patterns.
 */
function useIsCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !("matchMedia" in window)) return;
    const mql = window.matchMedia("(pointer: coarse)");
    const update = () => setCoarse(mql.matches);
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, []);
  return coarse;
}

export function InfoPopoverButton({ label, children }: InfoPopoverButtonProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const isCoarsePointer = useIsCoarsePointer();

  const computePosition = useCallback(() => {
    const btn = buttonRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const width = Math.min(POPOVER_MAX_WIDTH, viewportWidth - VIEWPORT_MARGIN * 2);
    const maxLeft = viewportWidth - width - VIEWPORT_MARGIN;
    const left = Math.max(VIEWPORT_MARGIN, Math.min(rect.left, maxLeft));
    const top = rect.bottom + 8;
    setPos({ top, left, width });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    computePosition();
  }, [open, computePosition]);

  useEffect(() => {
    if (!open) return;
    const onDocPointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onResize = () => computePosition();
    document.addEventListener("mousedown", onDocPointerDown);
    document.addEventListener("touchstart", onDocPointerDown, { passive: true });
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onResize, true);
    return () => {
      document.removeEventListener("mousedown", onDocPointerDown);
      document.removeEventListener("touchstart", onDocPointerDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onResize, true);
    };
  }, [open, computePosition]);

  // On fine-pointer (desktop) devices, hover/focus opens the popover. Touch
  // devices fall back to tap-to-toggle so iOS doesn't fire phantom hover.
  const hoverHandlers = isCoarsePointer
    ? {}
    : {
        onMouseEnter: () => setOpen(true),
        onMouseLeave: () => setOpen(false),
        onFocus: () => setOpen(true),
        onBlur: () => setOpen(false),
      };

  return (
    <span className="relative inline-flex" {...hoverHandlers}>
      <button
        ref={buttonRef}
        type="button"
        aria-label={`What is ${label}?`}
        aria-expanded={open}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          // Hover already manages open state on desktop; tap toggles for touch.
          if (isCoarsePointer) setOpen((v) => !v);
        }}
        className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-card-border text-[10px] font-semibold text-muted hover:text-foreground hover:border-foreground/50"
      >
        i
      </button>
      {open && pos && (
        <div
          ref={popoverRef}
          role="tooltip"
          style={{ top: pos.top, left: pos.left, width: pos.width, position: "fixed" }}
          className="z-50 rounded-lg border border-card-border bg-card-bg p-3 text-sm leading-relaxed text-muted shadow-lg font-normal normal-case"
        >
          {children}
        </div>
      )}
    </span>
  );
}
