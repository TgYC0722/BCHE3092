/**
 * Cross-checks the row bookkeeping.
 *
 * The page parses the CSV itself (for the self-check panel) and R re-reads the
 * same CSV text. If R silently used fewer rows than the page considered valid —
 * or returned different compounds — that must be reported, not hidden.
 */

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));

/**
 * @param {object} inspection result of inspectCsv()
 * @param {Array<{compound: string, n: number}>} rows parsed R output
 */
export function checkRowConsistency(inspection, rows) {
  const fileRows = inspection.totalRows;
  const validRows = inspection.validRows;
  const skippedRows = inspection.skipped.length;
  const rRows = rows.reduce(
    (sum, row) => sum + (Number.isFinite(row.n) ? row.n : 0),
    0,
  );

  const jsCompounds = inspection.compounds.map((compound) => compound.name);
  const rCompounds = rows.map((row) => row.compound);
  const missingCompounds = jsCompounds.filter((name) => !rCompounds.includes(name));
  const extraCompounds = rCompounds.filter((name) => !jsCompounds.includes(name));

  const rowsMatch = rRows === validRows && validRows + skippedRows === fileRows;
  const compoundsMatch = missingCompounds.length === 0 && extraCompounds.length === 0;

  return {
    ok: rowsMatch && compoundsMatch,
    fileRows,
    validRows,
    skippedRows,
    rRows,
    rCompounds: rCompounds.length,
    rowsMatch,
    compoundsMatch,
    missingCompounds,
    extraCompounds,
  };
}

/** HTML notice for the results panel (green when everything adds up). */
export function formatRowCheck(consistency, compoundCount) {
  if (consistency.ok) {
    return `<div class="row-check is-ok">
      <span class="row-check-icon" aria-hidden="true">✓</span>
      <span>行数核对：文件 <strong>${consistency.fileRows}</strong> 行数据（有效 ${consistency.validRows} · 跳过 ${consistency.skippedRows}），R 实际使用 <strong>${consistency.rRows}</strong> 行；${compoundCount} 个化合物与文件完全一致。</span>
    </div>`;
  }

  const reasons = [];
  if (!consistency.rowsMatch) {
    reasons.push(
      `文件 ${consistency.fileRows} 行数据（有效 ${consistency.validRows} · 跳过 ${consistency.skippedRows}），但 R 实际只使用了 ${consistency.rRows} 行`,
    );
  }
  if (consistency.missingCompounds.length) {
    reasons.push(`R 结果中缺少化合物：${consistency.missingCompounds.map(esc).join('、')}`);
  }
  if (consistency.extraCompounds.length) {
    reasons.push(`R 结果中多出化合物：${consistency.extraCompounds.map(esc).join('、')}`);
  }

  return `<div class="row-check is-warn" role="alert">
    <span class="row-check-icon" aria-hidden="true">⚠</span>
    <span><strong>行数核对不一致：</strong>${reasons.join('；')}。结果可能不完整，请检查原始文件后重新运行。</span>
  </div>`;
}
