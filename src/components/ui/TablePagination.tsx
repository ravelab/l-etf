"use client";

import { useId, useState, type FormEvent } from "react";
import { useMaxPageButtons } from "@/lib/hooks/use-max-page-buttons";

type TablePaginationProps = {
  page: number;
  pageSize: number;
  totalItems: number;
  onPageChange: (page: number) => void;
};

export function TablePagination({
  page,
  pageSize,
  totalItems,
  onPageChange,
}: TablePaginationProps) {
  const maxButtons = useMaxPageButtons();
  const inputId = useId();
  const [pageInput, setPageInput] = useState("");
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const pageSafe = Math.min(Math.max(page, 0), totalPages - 1);

  if (totalPages <= 1) return null;

  const goToPage = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const requested = Number.parseInt(pageInput, 10);
    if (!Number.isFinite(requested)) return;
    onPageChange(Math.min(Math.max(requested, 1), totalPages) - 1);
    setPageInput("");
  };

  const pages: React.ReactNode[] = [];
  if (totalPages <= maxButtons) {
    for (let i = 0; i < totalPages; i++) {
      pages.push(
        <button
          key={i}
          type="button"
          onClick={() => onPageChange(i)}
          className={`rounded px-2 py-1 ${pageSafe === i ? "bg-accent text-accent-contrast" : "hover:bg-card-border/30"}`}
        >
          {i + 1}
        </button>
      );
    }
  } else {
    const range = 2;
    const start = Math.max(0, pageSafe - range);
    const end = Math.min(totalPages - 1, pageSafe + range);
    if (start > 0) {
      pages.push(
        <button key={0} type="button" onClick={() => onPageChange(0)} className="rounded px-2 py-1 hover:bg-card-border/30">
          1
        </button>
      );
      if (start > 1) pages.push(<span key="start-dots" className="px-1">...</span>);
    }
    for (let i = start; i <= end; i++) {
      pages.push(
        <button
          key={i}
          type="button"
          onClick={() => onPageChange(i)}
          className={`rounded px-2 py-1 ${pageSafe === i ? "bg-accent text-accent-contrast" : "hover:bg-card-border/30"}`}
        >
          {i + 1}
        </button>
      );
    }
    if (end < totalPages - 1) {
      if (end < totalPages - 2) pages.push(<span key="end-dots" className="px-1">...</span>);
      pages.push(
        <button key={totalPages - 1} type="button" onClick={() => onPageChange(totalPages - 1)} className="rounded px-2 py-1 hover:bg-card-border/30">
          {totalPages}
        </button>
      );
    }
  }

  return (
    <div className="mb-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 text-xs text-muted">
      <span>
        {pageSafe * pageSize + 1}&ndash;{Math.min((pageSafe + 1) * pageSize, totalItems)} of {totalItems}
      </span>
      <div className="flex flex-wrap items-center justify-end gap-1">
        <button
          type="button"
          disabled={pageSafe === 0}
          onClick={() => onPageChange(pageSafe - 1)}
          className="rounded px-2 py-1 hover:bg-card-border/30 disabled:opacity-30 disabled:cursor-not-allowed"
        >
          Prev
        </button>
        {pages}
        <button
          type="button"
          disabled={pageSafe === totalPages - 1}
          onClick={() => onPageChange(pageSafe + 1)}
          className="rounded px-2 py-1 hover:bg-card-border/30 disabled:opacity-30 disabled:cursor-not-allowed"
        >
          Next
        </button>
        <form onSubmit={goToPage} className="ml-2 flex items-center gap-1">
          <label htmlFor={inputId} className="sr-only">Go to page</label>
          <input
            id={inputId}
            type="number"
            min={1}
            max={totalPages}
            value={pageInput}
            onChange={(event) => setPageInput(event.target.value)}
            placeholder={`Page 1-${totalPages}`}
            className="w-24 rounded border border-card-border bg-card-bg px-2 py-1 text-foreground"
          />
          <button type="submit" className="rounded bg-card-border/40 px-2 py-1 hover:bg-card-border/60">
            Go
          </button>
        </form>
      </div>
    </div>
  );
}
