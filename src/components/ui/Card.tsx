import type { HTMLAttributes, ReactNode } from "react";

type CardProps = HTMLAttributes<HTMLDivElement> & {
  children: ReactNode;
};

export function Card({ children, className = "", ...props }: CardProps) {
  return (
    <div
      className={`bg-card-bg border border-card-border rounded-xl p-3 md:p-5 ${className}`}
      {...props}
    >
      {children}
    </div>
  );
}
