// Unit checks for the CSV inspection logic (no browser needed).
// Usage: node scripts/test-csv.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectCsv, parseCsv } from '../src/csv.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
const check = (name, fn) => {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
};

check('parses quoted fields with commas and escaped quotes', () => {
  const rows = parseCsv('a,b\n"x, y","he said ""hi"""\n');
  assert.deepEqual(rows, [
    ['a', 'b'],
    ['x, y', 'he said "hi"'],
  ]);
});

check('sample dataset self-check', () => {
  const text = readFileSync(join(root, 'data', 'sample-dose-response.csv'), 'utf8');
  const info = inspectCsv(text);
  assert.equal(info.ok, true);
  assert.equal(info.totalRows, 182);
  assert.equal(info.validRows, 180);
  assert.equal(info.skipped.length, 2);
  assert.deepEqual(info.compounds.map((compound) => compound.name), [
    'Imatinib',
    'Dasatinib',
    'Nilotinib',
    'Bosutinib',
    'Ponatinib',
    'Gefitinib',
  ]);
  const first = info.compounds[0];
  assert.equal(first.n, 30);
  assert.equal(first.levels, 10);
  assert.equal(first.replicates, '3');
  assert.equal(info.range.min, 0.1);
  assert.equal(info.range.max, 3000);
  assert.equal(info.skipped[0].line, 182);
});

check('rejects wrong column names', () => {
  const info = inspectCsv('compound,conc,response_pct,replicate\nA,1,2,1\n');
  assert.equal(info.ok, false);
  assert.match(info.details.join(' '), /conc_nM/);
  assert.match(info.details.join(' '), /conc/);
});

check('rejects extra columns', () => {
  const info = inspectCsv('compound,conc_nM,response_pct,replicate,note\nA,1,2,1,x\n');
  assert.equal(info.ok, false);
  assert.match(info.details.join(' '), /note/);
});

check('rejects rows with more fields than the header', () => {
  const info = inspectCsv('compound,conc_nM,response_pct,replicate\nA,1,2,1,extra\n');
  assert.equal(info.ok, false);
  assert.match(info.error, /read\.csv/);
  assert.match(info.details[0], /第 2 行/);
});

check('skips missing, non-numeric and non-positive concentrations', () => {
  const info = inspectCsv(
    [
      'compound,conc_nM,response_pct,replicate',
      'A,0.1,3,1',
      'A,1,,1',
      'A,10,NA,1',
      'A,abc,50,1',
      'A,0,50,1',
      'A,100,90,1',
      'A,1000,97,1',
    ].join('\r\n'),
  );
  assert.equal(info.ok, true);
  assert.equal(info.validRows, 3);
  assert.equal(info.skipped.length, 4);
  assert.deepEqual(
    info.skipped.map((row) => row.line),
    [3, 4, 5, 6],
  );
});

check('strips a UTF-8 BOM and keeps quoted compound names', () => {
  const info = inspectCsv(
    '\uFEFFcompound,conc_nM,response_pct,replicate\n"Compound A, sodium",1,2,1\n',
  );
  assert.equal(info.ok, true);
  assert.equal(info.compounds[0].name, 'Compound A, sodium');
});

check('short rows are reported as missing, not dropped silently', () => {
  const info = inspectCsv(
    'compound,conc_nM,response_pct,replicate\nA,1,2\nA,10,50,1\nA,100,90,1\nA,1000,97,1\n',
  );
  assert.equal(info.ok, true);
  assert.equal(info.skipped.length, 1);
  assert.match(info.skipped[0].reason, /缺失值/);
});

check('flags compounds with fewer than four concentrations', () => {
  const info = inspectCsv(
    'compound,conc_nM,response_pct,replicate\nFew,1,5,1\nFew,10,50,1\nFew,100,95,1\n',
  );
  assert.equal(info.ok, true);
  assert.equal(info.compounds[0].tooFewLevels, true);
});

check('rejects an empty file', () => {
  assert.equal(inspectCsv('').ok, false);
  assert.equal(inspectCsv('   \n\n').ok, false);
});

check('rejects a file with no usable rows', () => {
  const info = inspectCsv(
    'compound,conc_nM,response_pct,replicate\nA,,,\nA,NA,NA,NA\n',
  );
  assert.equal(info.ok, false);
  assert.match(info.error, /没有可用的数据行/);
});

console.log(`\n${passed} checks passed.`);
