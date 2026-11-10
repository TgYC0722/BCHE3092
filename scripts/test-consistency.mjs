// Unit checks for the row bookkeeping between the page parser and R.
// Usage: node scripts/test-consistency.mjs

import assert from 'node:assert/strict';
import { checkRowConsistency, formatRowCheck } from '../src/consistency.js';

let passed = 0;
const check = (name, fn) => {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
};

const inspection = {
  totalRows: 10,
  validRows: 8,
  skipped: [{ line: 9 }, { line: 10 }],
  compounds: [{ name: 'A' }, { name: 'B' }],
};

check('matching rows and compounds pass', () => {
  const result = checkRowConsistency(inspection, [
    { compound: 'A', n: 4 },
    { compound: 'B', n: 4 },
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.rRows, 8);
  assert.equal(result.rowsMatch, true);
  assert.equal(result.compoundsMatch, true);
});

check('R using fewer rows is a mismatch', () => {
  const result = checkRowConsistency(inspection, [
    { compound: 'A', n: 4 },
    { compound: 'B', n: 3 },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.rowsMatch, false);
  assert.equal(result.rRows, 7);
});

check('a compound missing from the R output is reported', () => {
  const result = checkRowConsistency(inspection, [{ compound: 'A', n: 8 }]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missingCompounds, ['B']);
});

check('an unexpected compound from R is reported', () => {
  const result = checkRowConsistency(inspection, [
    { compound: 'A', n: 4 },
    { compound: 'B', n: 4 },
    { compound: 'C', n: 1 },
  ]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.extraCompounds, ['C']);
});

check('a broken file total is a mismatch even when R rows add up', () => {
  const result = checkRowConsistency(
    { ...inspection, totalRows: 11 },
    [{ compound: 'A', n: 4 }, { compound: 'B', n: 4 }],
  );
  assert.equal(result.ok, false);
  assert.equal(result.rowsMatch, false);
});

check('the ok notice states the exact counts', () => {
  const result = checkRowConsistency(inspection, [
    { compound: 'A', n: 4 },
    { compound: 'B', n: 4 },
  ]);
  const html = formatRowCheck(result, 2);
  assert.match(html, /row-check is-ok/);
  assert.match(html, /行数核对/);
  assert.match(html, /R 实际使用 <strong>8<\/strong> 行/);
  assert.match(html, /2 个化合物与文件完全一致/);
});

check('a mismatch renders an explicit warning', () => {
  const result = checkRowConsistency(inspection, [
    { compound: 'A', n: 4 },
    { compound: 'B', n: 3 },
  ]);
  const html = formatRowCheck(result, 2);
  assert.match(html, /row-check is-warn/);
  assert.match(html, /role="alert"/);
  assert.match(html, /行数核对不一致/);
  assert.match(html, /R 实际只使用了 7 行/);
});

check('the warning names compounds that are missing from R', () => {
  const result = checkRowConsistency(inspection, [{ compound: 'A', n: 8 }]);
  const html = formatRowCheck(result, 1);
  assert.match(html, /R 结果中缺少化合物：B/);
  assert.match(html, /行数核对不一致/);
});

console.log(`\n${passed} checks passed.`);
