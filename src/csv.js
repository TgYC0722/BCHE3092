/**
 * CSV parsing and dataset inspection.
 *
 * The uploaded file is parsed in the browser for the self-check panel, but the
 * *original* CSV text is what gets handed to R (read.csv(text = ...)), so R and
 * the UI always agree on the records. Nothing is dropped silently: every row
 * that cannot be used is counted and reported with its line number.
 */

export const REQUIRED_COLUMNS = ['compound', 'conc_nM', 'response_pct', 'replicate'];
export const MISSING_TOKENS = new Set(['', 'na', 'n/a', 'nan', 'null', 'none']);

/**
 * Minimal RFC-4180-ish CSV parser: comma separated, double-quote quoting,
 * doubled quotes as an escape, CRLF or LF line endings.
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsv(text) {
  const src = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

const isBlankRow = (cells) => cells.every((cell) => cell.trim() === '');

function numericOrNull(raw) {
  const value = raw.trim();
  if (MISSING_TOKENS.has(value.toLowerCase())) return null;
  // Reject things like "3abc" that Number() would happily parse as NaN only.
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value)) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/**
 * Inspect the raw CSV text.
 * @param {string} rawText
 * @returns {{
 *   ok: boolean,
 *   error?: string,
 *   details?: string[],
 *   header?: string[],
 *   csvText?: string,
 *   records?: Array<{compound: string, conc: number, response: number, replicate: number, line: number}>,
 *   compounds?: Array<object>,
 *   totalRows?: number,
 *   validRows?: number,
 *   skipped?: Array<{line: number, reason: string}>,
 *   range?: {min: number, max: number} | null
 * }}
 */
export function inspectCsv(rawText) {
  const csvText = rawText.replace(/^\uFEFF/, '');
  const rows = parseCsv(csvText);

  let headerIndex = -1;
  for (let i = 0; i < rows.length; i += 1) {
    if (!isBlankRow(rows[i])) {
      headerIndex = i;
      break;
    }
  }

  if (headerIndex === -1) {
    return { ok: false, error: '文件为空，或者没有任何内容。' };
  }

  const header = rows[headerIndex].map((cell) => cell.trim());
  const missing = REQUIRED_COLUMNS.filter((col) => !header.includes(col));
  const extra = header.filter((col) => !REQUIRED_COLUMNS.includes(col) && col !== '');
  const duplicated = REQUIRED_COLUMNS.filter(
    (col) => header.filter((h) => h === col).length > 1,
  );

  if (missing.length || extra.length || duplicated.length) {
    const details = [];
    if (missing.length) details.push(`缺少列：${missing.join(', ')}`);
    if (extra.length) details.push(`多余列：${extra.join(', ')}`);
    if (duplicated.length) details.push(`重复列：${duplicated.join(', ')}`);
    return {
      ok: false,
      header,
      error: '列名必须正好是 compound, conc_nM, response_pct, replicate（顺序可变）。',
      details,
    };
  }

  const columnIndex = Object.fromEntries(REQUIRED_COLUMNS.map((col) => [col, header.indexOf(col)]));

  const records = [];
  const skipped = [];
  const malformed = [];

  for (let i = headerIndex + 1; i < rows.length; i += 1) {
    const cells = rows[i];
    if (isBlankRow(cells)) continue;

    const line = i + 1;

    // read.csv() would abort on a row with more fields than the header, so
    // refuse the whole file instead of sending R something it cannot parse.
    if (cells.length > header.length) {
      malformed.push(`第 ${line} 行有 ${cells.length} 个字段，表头只有 ${header.length} 个`);
      continue;
    }

    const cell = (name) => (cells[columnIndex[name]] ?? '').trim();

    const compoundRaw = cell('compound');
    const concRaw = cell('conc_nM');
    const responseRaw = cell('response_pct');
    const replicateRaw = cell('replicate');

    const rawValues = [compoundRaw, concRaw, responseRaw, replicateRaw];
    if (rawValues.some((value) => MISSING_TOKENS.has(value.toLowerCase()))) {
      skipped.push({ line, reason: '存在缺失值' });
      continue;
    }

    const conc = numericOrNull(concRaw);
    const response = numericOrNull(responseRaw);
    const replicate = numericOrNull(replicateRaw);

    if (conc === null || response === null || replicate === null) {
      skipped.push({ line, reason: '有单元格不是数值' });
      continue;
    }

    if (conc <= 0) {
      skipped.push({ line, reason: '浓度 ≤ 0，无法取 log10' });
      continue;
    }

    records.push({
      compound: compoundRaw,
      conc,
      response,
      replicate,
      line,
    });
  }

  if (malformed.length) {
    return {
      ok: false,
      header,
      totalRows: records.length + skipped.length + malformed.length,
      skipped,
      error: '有数据行的字段数多于表头，R 的 read.csv(text = ...) 无法解析，因此没有开始拟合。',
      details: malformed.slice(0, 20),
    };
  }

  const totalRows = records.length + skipped.length;

  if (records.length === 0) {
    return {
      ok: false,
      header,
      totalRows,
      skipped,
      error: '没有可用的数据行：所有行都缺失、非数值或浓度 ≤ 0。',
    };
  }

  // Group by compound, preserving first-appearance order.
  const byCompound = new Map();
  for (const record of records) {
    if (!byCompound.has(record.compound)) byCompound.set(record.compound, []);
    byCompound.get(record.compound).push(record);
  }

  const compounds = [...byCompound.entries()].map(([name, recs]) => {
    const perConc = new Map();
    for (const rec of recs) {
      const key = rec.conc;
      perConc.set(key, (perConc.get(key) ?? 0) + 1);
    }
    const concentrations = [...perConc.keys()].sort((a, b) => a - b);
    const repCounts = [...perConc.values()];
    const repMin = Math.min(...repCounts);
    const repMax = Math.max(...repCounts);
    return {
      name,
      n: recs.length,
      levels: concentrations.length,
      replicates: repMin === repMax ? `${repMax}` : `${repMin}–${repMax}`,
      repMin,
      repMax,
      concentrations,
      concMin: concentrations[0],
      concMax: concentrations[concentrations.length - 1],
      tooFewLevels: concentrations.length < 4,
    };
  });

  const allConc = records.map((record) => record.conc);

  return {
    ok: true,
    header,
    csvText,
    records,
    compounds,
    totalRows,
    validRows: records.length,
    skipped,
    range: { min: Math.min(...allConc), max: Math.max(...allConc) },
  };
}

/** Serialise rows back to CSV text (used by the "export results" button). */
export function toCsv(headers, rows) {
  const escapeCell = (value) => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [headers.map(escapeCell).join(',')];
  for (const row of rows) lines.push(row.map(escapeCell).join(','));
  return `${lines.join('\r\n')}\r\n`;
}
