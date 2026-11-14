const percentFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const costPercentFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const numberFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});

const multipleFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function getAdaptiveMultipleFractionDigits(value: number): number {
  const abs = Math.abs(value);
  if (!Number.isFinite(value) || abs === 0) return 2;
  if (abs >= 1) return 2;
  // Two significant digits below 1x
  const power = Math.floor(Math.log10(abs));
  return Math.abs(power) + 1;
}

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

export function formatPercent(value: number): string {
  return `${percentFormatter.format(value)}%`;
}

export function formatCostPercent(value: number): string {
  return `${costPercentFormatter.format(value)}%`;
}

export function formatNumber(value: number): string {
  return numberFormatter.format(value);
}

export function formatMultiple(value: number): string {
  return `${multipleFormatter.format(value)}x`;
}

export function formatAdaptiveMultiple(value: number): string {
  if (!Number.isFinite(value)) return "0x";
  const formatter = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: getAdaptiveMultipleFractionDigits(value),
  });
  return `${formatter.format(value)}x`;
}

export function formatCurrency(value: number): string {
  return currencyFormatter.format(value);
}

/** USD with enough decimals that nonzero amounts show at least `sigFigs` significant digits (e.g. $1.30 not $1). */
export function formatCurrencySigFigs(value: number, sigFigs = 2): string {
  if (!Number.isFinite(value)) {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(0);
  }
  const abs = Math.abs(value);
  if (abs === 0) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(0);
  }
  const exp = Math.floor(Math.log10(abs));
  const fractionDigits = Math.max(0, sigFigs - 1 - exp);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value);
}

const compactCurrencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumSignificantDigits: 3,
});

/** USD to three significant figures with a K/M/B suffix ($1.23M), for cramped cells. */
export function formatCompactCurrency(value: number): string {
  return compactCurrencyFormatter.format(Number.isFinite(value) ? value : 0);
}

const compactNumberFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumSignificantDigits: 3,
});

/** A plain number to three significant figures with a K/M/B suffix (17.6M), for cramped cells. */
export function formatCompactNumber(value: number): string {
  return compactNumberFormatter.format(Number.isFinite(value) ? value : 0);
}

const compactMultipleFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumSignificantDigits: 3,
});

/** A multiple to three significant figures with a K/M/B suffix (1.2Kx), for charts. */
export function formatCompactMultiple(value: number): string {
  return `${compactMultipleFormatter.format(Number.isFinite(value) ? value : 0)}x`;
}

export function formatDate(dateStr: string): string {
  return dateStr.replaceAll("-", "/");
}
