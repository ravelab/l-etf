"use client";

import { type ButtonHTMLAttributes, type ReactNode } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md" | "lg";
  children: ReactNode;
}

const VARIANT_CLASSES = {
  primary:
    "bg-accent text-accent-contrast hover:bg-accent-dim font-semibold",
  secondary:
    "bg-card-bg border border-card-border text-foreground hover:bg-white/5",
  ghost: "text-muted hover:text-foreground hover:bg-white/5",
} as const;

const SIZE_CLASSES = {
  sm: "px-2.5 py-1 text-xs rounded-md",
  md: "px-4 py-2 text-sm rounded-lg",
  lg: "px-6 py-2.5 text-base rounded-lg",
} as const;

export function Button({
  variant = "primary",
  size = "md",
  children,
  className = "",
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      className={`inline-flex items-center justify-center transition-colors cursor-pointer
        ${VARIANT_CLASSES[variant]} ${SIZE_CLASSES[size]}
        ${disabled ? "opacity-50 cursor-not-allowed" : ""}
        ${className}`}
      disabled={disabled}
      {...props}
    >
      {children}
    </button>
  );
}
