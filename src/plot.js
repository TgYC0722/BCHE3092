/**
 * Hand-rolled SVG dose-response chart (no chart library: the only dependencies
 * of this project are vite and webr).
 *
 * x axis is log10 concentration labelled in nM, y axis is raw % response.
 * The axis limits always contain every raw replicate, the whole fitted curve,
 * 0% and 100% — the y axis is never truncated.
 */

import { formatNumber } from './format.js';

const W = 440;
const H = 330;
const M = { top: 20, right: 18, bottom: 52, left: 58 };
const PLOT_W = W - M.left - M.right;
const PLOT_H = H - M.top - M.bottom;

const REPLICATE_COLORS = ['#0284c7', '#f59e0b', '#7c3aed', '#059669', '#e11d48', '#64748b'];

const esc = (value) =>
  String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

function axisTickLabel(value) {
  if (!Number.isFinite(value)) return '';
  if (value >= 1000) return String(Math.round(value));
  if (value >= 1) return String(Number(value.toPrecision(4)));
  return String(Number(value.toPrecision(3)));
}

/** Distinct tested concentrations are the natural log-scale ticks. */
function xTickValues(logMin, logMax, concentrations) {
  const unique = [...new Set(concentrations)].sort((a, b) => a - b);
  if (unique.length > 0 && unique.length <= 8) return unique;

  const ticks = [];
  for (let k = Math.ceil(logMin); k <= Math.floor(logMax); k += 1) ticks.push(10 ** k);
  if (ticks.length < 4) {
    for (let k = Math.floor(logMin); k <= Math.ceil(logMax); k += 1) {
      for (const mult of [1, 2, 5]) {
        const value = mult * 10 ** k;
        const log = Math.log10(value);
        if (log >= logMin && log <= logMax) ticks.push(value);
      }
    }
  }
  return [...new Set(ticks)].sort((a, b) => a - b);
}

/** Rough text width for the monospace tick font. */
const textWidth = (text, size = 11) => text.length * size * 0.62;

/**
 * @param {object} chart
 * @param {string} chart.compound
 * @param {Array<{conc:number,response:number,replicate:number}>} chart.points
 * @param {Array<[number, number]>} chart.curve  [log10 conc, response]
 * @param {number|null} chart.ic50
 * @param {boolean} chart.ok
 * @returns {string} SVG markup
 */
export function renderDoseResponseSvg({ compound, points, curve, ic50, ok }) {
  const logs = points.map((point) => Math.log10(point.conc));
  const curveXs = (curve ?? []).map((pair) => pair[0]);
  const allLogs = [...logs, ...curveXs];

  let xMin = Math.min(...allLogs);
  let xMax = Math.max(...allLogs);
  if (!Number.isFinite(xMin) || !Number.isFinite(xMax)) {
    xMin = -1;
    xMax = 1;
  }
  if (xMax - xMin < 0.4) {
    const mid = (xMin + xMax) / 2;
    xMin = mid - 0.2;
    xMax = mid + 0.2;
  }

  const logIC50 = ic50 !== null && Number.isFinite(ic50) && ic50 > 0 ? Math.log10(ic50) : null;
  let ic50Outside = false;
  if (logIC50 !== null) {
    if (logIC50 >= xMin && logIC50 <= xMax) {
      // inside the fitted concentration window: already covered
    } else if (logIC50 > xMax && logIC50 <= xMax + 0.75) {
      xMax = logIC50;
    } else if (logIC50 < xMin && logIC50 >= xMin - 0.75) {
      xMin = logIC50;
    } else {
      ic50Outside = true;
    }
  }

  const xPad = Math.max(0.06, (xMax - xMin) * 0.04);
  xMin -= xPad;
  xMax += xPad;

  const ys = [
    ...points.map((point) => point.response),
    ...(curve ?? []).map((pair) => pair[1]),
    0,
    100,
  ].filter((value) => Number.isFinite(value));

  let yMin = Math.min(...ys);
  let yMax = Math.max(...ys);
  const yPad = Math.max(2, (yMax - yMin) * 0.02);
  yMin -= yPad;
  yMax += yPad;

  const sx = (log) => M.left + ((log - xMin) / (xMax - xMin)) * PLOT_W;
  const sy = (value) => M.top + (1 - (value - yMin) / (yMax - yMin)) * PLOT_H;

  const concentrations = points.map((point) => point.conc);
  const xTicks = xTickValues(xMin, xMax, concentrations);
  const yTicks = [];
  for (let value = Math.floor(yMin / 25) * 25; value <= yMax + 1e-9; value += 25) {
    yTicks.push(value);
  }

  const parts = [];
  parts.push(
    `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(
      compound,
    )} 的剂量–反应拟合图">`,
  );

  // Horizontal grid + y labels
  parts.push('<g aria-hidden="true">');
  for (const tick of yTicks) {
    const y = sy(tick);
    parts.push(
      `<line class="grid-line" x1="${M.left}" y1="${y.toFixed(2)}" x2="${(M.left + PLOT_W).toFixed(
        2,
      )}" y2="${y.toFixed(2)}" />`,
    );
    parts.push(
      `<text class="tick-text" x="${M.left - 10}" y="${(y + 3.5).toFixed(2)}" text-anchor="end">${tick}</text>`,
    );
  }

  // Vertical grid + x labels (drawn above the x axis only)
  for (const value of xTicks) {
    const x = sx(Math.log10(value));
    parts.push(
      `<line class="grid-line" x1="${x.toFixed(2)}" y1="${M.top}" x2="${x.toFixed(2)}" y2="${(
        M.top + PLOT_H
      ).toFixed(2)}" />`,
    );
    parts.push(
      `<text class="tick-text" x="${x.toFixed(2)}" y="${(M.top + PLOT_H + 17).toFixed(
        2,
      )}" text-anchor="middle">${axisTickLabel(value)}</text>`,
    );
  }
  parts.push('</g>');

  // Axis lines
  parts.push(
    `<line class="axis-line" x1="${M.left}" y1="${M.top}" x2="${M.left}" y2="${M.top + PLOT_H}" />`,
  );
  parts.push(
    `<line class="axis-line" x1="${M.left}" y1="${M.top + PLOT_H}" x2="${M.left + PLOT_W}" y2="${
      M.top + PLOT_H
    }" />`,
  );

  // Axis titles
  parts.push(
    `<text class="axis-title" x="${M.left + PLOT_W / 2}" y="${H - 12}" text-anchor="middle">浓度 (nM，log10 刻度)</text>`,
  );
  parts.push(
    `<text class="axis-title" transform="translate(15 ${M.top + PLOT_H / 2}) rotate(-90)" text-anchor="middle">响应 (%)</text>`,
  );

  // IC50 reference line
  if (logIC50 !== null && ok) {
    const clamped = Math.min(Math.max(logIC50, xMin), xMax);
    const x = sx(clamped);
    parts.push(
      `<line class="ic50-line" x1="${x.toFixed(2)}" y1="${M.top}" x2="${x.toFixed(2)}" y2="${(
        M.top + PLOT_H
      ).toFixed(2)}" />`,
    );
    const label = `IC50 ${formatNumber(ic50)} nM`;
    const labelW = Math.max(textWidth(label, 10.5) + 12, 70);
    const labelX = Math.min(
      Math.max(x, M.left + labelW / 2 + 2),
      M.left + PLOT_W - labelW / 2 - 2,
    );
    const labelY = M.top + 2;
    parts.push(
      `<rect class="ic50-chip-bg" x="${(labelX - labelW / 2).toFixed(2)}" y="${labelY}" width="${labelW.toFixed(
        2,
      )}" height="17" rx="5" />`,
    );
    parts.push(
      `<text class="ic50-label" x="${labelX.toFixed(2)}" y="${labelY + 12.2}" text-anchor="middle">${esc(
        label,
      )}</text>`,
    );
  }

  // Fitted curve
  if (ok && curve && curve.length > 1) {
    const d = curve
      .map((pair, index) => `${index === 0 ? 'M' : 'L'}${sx(pair[0]).toFixed(2)},${sy(pair[1]).toFixed(2)}`)
      .join(' ');
    parts.push(`<path class="fit-line" d="${d}" />`);
  }

  // Raw replicates
  const reps = [...new Set(points.map((point) => point.replicate))].sort((a, b) => a - b);
  const colorFor = (rep) => REPLICATE_COLORS[Math.max(0, reps.indexOf(rep)) % REPLICATE_COLORS.length];
  for (const point of points) {
    const x = sx(Math.log10(point.conc));
    const y = sy(point.response);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const color = colorFor(point.replicate);
    parts.push(
      `<circle class="point" cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="3.4" fill="${color}">` +
        `<title>${esc(compound)} · 浓度 ${axisTickLabel(point.conc)} nM · 响应 ${formatNumber(
          point.response,
          4,
        )}% · 重复 #${esc(point.replicate)}</title></circle>`,
    );
  }

  // Failure overlay: keep the raw data visible, explain in the HTML below.
  if (!ok) {
    const cx = M.left + PLOT_W / 2;
    const cy = M.top + PLOT_H / 2;
    parts.push(
      `<rect x="${(cx - 52).toFixed(2)}" y="${(cy - 15).toFixed(2)}" width="104" height="30" rx="8" fill="#fff1f2" stroke="#fecdd3" />`,
    );
    parts.push(
      `<text class="fail-overlay-text" x="${cx.toFixed(2)}" y="${(cy + 4).toFixed(
        2,
      )}" text-anchor="middle">拟合失败</text>`,
    );
  }

  if (ic50Outside) {
    parts.push(
      `<text class="tick-text" x="${M.left + PLOT_W}" y="${M.top + 12}" text-anchor="end">IC50 超出实测浓度范围</text>`,
    );
  }

  parts.push('</svg>');
  return parts.join('');
}
