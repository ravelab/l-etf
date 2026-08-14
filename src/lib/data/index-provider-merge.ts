import type { DailyPrice } from "./storage/types";

type AdjustedPriceRow = {
  date: string;
  adjClose: number;
};

type RawIndexBar = {
  date: string;
  open: number;
  close: number;
};

export function mergeAdjustedPricesWithRawIndexBars(params: {
  adjustedRows: AdjustedPriceRow[];
  rawBars: RawIndexBar[];
  name: string;
  source: string;
  adjustedOnlySource: string;
}): { rows: DailyPrice[]; missingRawDates: string[] } {
  const rawByDate = new Map(params.rawBars.map((row) => [row.date, row]));
  const rows: DailyPrice[] = [];
  const missingRawDates: string[] = [];

  for (const adjusted of params.adjustedRows) {
    const raw = rawByDate.get(adjusted.date);
    if (!raw) {
      missingRawDates.push(adjusted.date);
      rows.push({
        date: adjusted.date,
        adj_close: adjusted.adjClose,
        name: params.name,
        source: params.adjustedOnlySource,
      });
      continue;
    }

    rows.push({
      date: adjusted.date,
      adj_close: adjusted.adjClose,
      close: raw.close,
      open: raw.open,
      name: params.name,
      source: params.source,
    });
  }

  return { rows, missingRawDates };
}

function mergeAdjustedSource(storedSource: string, freshSource: string): string {
  if (!freshSource.endsWith("(adj_close)")) return freshSource;
  const adjustedSourceSuffix = /[^+]+\(adj_close\)$/;
  return adjustedSourceSuffix.test(storedSource)
    ? storedSource.replace(adjustedSourceSuffix, freshSource)
    : storedSource;
}

export function mergeIncrementalIndexRows(params: {
  storedRows: DailyPrice[];
  freshRows: DailyPrice[];
  rebaseRatio: number | null;
}): { rows: DailyPrice[]; changed: boolean; appendedCount: number } {
  const freshByDate = new Map(params.freshRows.map((row) => [row.date, row]));
  let changed = false;

  const rows = params.storedRows.map((stored) => {
    const fresh = freshByDate.get(stored.date);
    if (!fresh) {
      if (params.rebaseRatio == null || stored.adj_close == null) return stored;
      changed = true;
      return { ...stored, adj_close: stored.adj_close * params.rebaseRatio };
    }

    changed = true;
    const preservesStoredRaw = fresh.open == null && fresh.close == null;
    return {
      ...stored,
      adj_close: fresh.adj_close,
      open: fresh.open ?? stored.open,
      close: fresh.close ?? stored.close,
      name: fresh.name,
      source: preservesStoredRaw
        ? mergeAdjustedSource(stored.source, fresh.source)
        : fresh.source,
    };
  });

  const storedDates = new Set(rows.map((row) => row.date));
  const appendedRows = params.freshRows
    .filter((row) => !storedDates.has(row.date))
    .map((row) => ({ ...row }));

  if (appendedRows.length > 0) {
    rows.push(...appendedRows);
    changed = true;
  }

  return { rows, changed, appendedCount: appendedRows.length };
}
