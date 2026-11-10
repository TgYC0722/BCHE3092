/** Small number formatting helpers shared by the table and the charts. */

/**
 * Significant-digit formatting that keeps very small / very large values
 * readable without printing 15 decimals.
 */
export function formatNumber(value, digits = 3) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (value === 0) return '0';
  const abs = Math.abs(value);
  if (abs >= 1e6 || abs < 1e-4) {
    return value.toExponential(Math.max(0, digits - 1)).replace('e+', 'e');
  }
  return String(Number(value.toPrecision(digits)));
}

/** Fixed-decimals formatting, used for top/bottom (% response). */
export function formatFixed(value, digits = 1) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toFixed(digits);
}

export function formatInt(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return String(Math.round(value));
}

/** 0.3 → "0.3", 1000 → "1000", 0.0012 → "1.2e-3" */
export function formatConc(value) {
  if (!Number.isFinite(value)) return '—';
  if (value >= 1000) return String(Number(value.toPrecision(6)));
  if (value >= 1) return String(Number(value.toPrecision(4)));
  if (value >= 0.001) return String(Number(value.toPrecision(3)));
  return value.toExponential(1).replace('e+', 'e');
}

export function formatRange(min, max) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return '—';
  return `${formatConc(min)} – ${formatConc(max)} nM`;
}
