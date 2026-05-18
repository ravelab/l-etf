// Price data format for CSV files (index/ETF/risk-off).
// Index files may also include an adjusted open price.
export interface DailyPrice {
  date: string;
  adj_open?: number;  // Optional adjusted open price (TR scale, matches adj_close)
  adj_close?: number; // Adjusted close price; may be temporarily missing for freshest index rows
  open?: number;      // Optional raw open price (matches `close` scale; for futures sims)
  close?: number;     // Raw price close for index SMA calculations
  name: string;       // Ticker/symbol (e.g., "tqqq", "spy", "gldm")
  source: string;     // Full source name (e.g., "tiingo", "fred", "github-csv")
}

export interface YahooQuote {
  date: string;
  close: number;
}

export interface IStorage {
  // Prices
  getPrices(index: string, startDate: string, endDate: string): Promise<DailyPrice[]>;
  getPriceDateBounds(index: string): Promise<{ minDate: string; maxDate: string } | null>;

  // Inflation
  getInflation(startDate: string, endDate: string): Promise<Array<{ date: string; value: number }>>;

  // Borrowing rate (for LETF simulation)
  getBorrowRate(startDate: string, endDate: string): Promise<Array<{ date: string; value: number }>>;
}
