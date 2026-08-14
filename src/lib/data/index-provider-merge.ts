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
}): { rows: DailyPrice[]; missingRawDates: string[] } {
  const rawByDate = new Map(params.rawBars.map((row) => [row.date, row]));
  const rows: DailyPrice[] = [];
  const missingRawDates: string[] = [];

  for (const adjusted of params.adjustedRows) {
    const raw = rawByDate.get(adjusted.date);
    if (!raw) {
      missingRawDates.push(adjusted.date);
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
