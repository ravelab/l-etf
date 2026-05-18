import storage, { type DailyPrice } from "@/lib/data/storage";

export async function getPrices(index: string, startDate: string, endDate: string): Promise<DailyPrice[]> {
  return storage.getPrices(index, startDate, endDate);
}

export async function getBorrowRate(startDate: string, endDate: string): Promise<Array<{ date: string; value: number }>> {
  return storage.getBorrowRate(startDate, endDate);
}

export async function getInflation(startDate: string, endDate: string): Promise<Array<{ date: string; value: number }>> {
  return storage.getInflation(startDate, endDate);
}

export async function getPriceDateBounds(index: string): Promise<{ minDate: string; maxDate: string } | null> {
  return storage.getPriceDateBounds(index);
}
