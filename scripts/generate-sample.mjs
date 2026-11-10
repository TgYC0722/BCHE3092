// Generates the demo dataset (data/sample-dose-response.csv and src/sample.js).
// Run with: node scripts/generate-sample.mjs
// The data is synthetic: a 4PL curve per compound plus Gaussian noise, with two
// rows deliberately left incomplete so the "skipped rows" self-check has
// something real to report.

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const compounds = [
  { name: 'Imatinib', ic50: 1.2, hill: 1.15, bottom: 2.6, top: 98.1, sd: 2.1 },
  { name: 'Dasatinib', ic50: 4.5, hill: 1.45, bottom: 3.8, top: 96.6, sd: 2.6 },
  { name: 'Nilotinib', ic50: 16, hill: 0.95, bottom: 3.1, top: 99.0, sd: 2.0 },
  { name: 'Bosutinib', ic50: 55, hill: 1.65, bottom: 4.9, top: 95.3, sd: 8.6 },
  { name: 'Ponatinib', ic50: 180, hill: 1.2, bottom: 2.2, top: 97.4, sd: 2.9 },
  { name: 'Gefitinib', ic50: 320, hill: 1.05, bottom: 6.3, top: 94.7, sd: 2.3 },
];

const concentrations = [0.1, 0.3, 1, 3, 10, 30, 100, 300, 1000, 3000];
const replicates = [1, 2, 3];

// Deterministic PRNG so the sample file is stable.
let seed = 20240607;
const random = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const gaussian = () => {
  const u = Math.max(random(), 1e-9);
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

const responseAt = (compound, conc) => {
  const exponent = (Math.log10(compound.ic50) - Math.log10(conc)) * compound.hill;
  return compound.bottom + (compound.top - compound.bottom) / (1 + 10 ** exponent);
};

const lines = ['compound,conc_nM,response_pct,replicate'];

for (const compound of compounds) {
  for (const conc of concentrations) {
    for (const replicate of replicates) {
      const noise = gaussian() * compound.sd;
      const response = Math.min(100.5, Math.max(-0.5, responseAt(compound, conc) + noise));
      lines.push(`${compound.name},${conc},${response.toFixed(1)},${replicate}`);
    }
  }
}

// Two incomplete rows: the page counts them and lists them by line number.
lines.push('Imatinib,30,,2');
lines.push('Nilotinib,10,NA,3');

const csv = `${lines.join('\n')}\n`;

mkdirSync(join(root, 'data'), { recursive: true });
writeFileSync(join(root, 'data', 'sample-dose-response.csv'), csv, 'utf8');
writeFileSync(
  join(root, 'src', 'sample.js'),
  `// Synthetic demo dataset (see scripts/generate-sample.mjs).\n// Two rows are intentionally incomplete so the data self-check reports them.\nexport const SAMPLE_CSV = \`${csv.replace(/`/g, '\\`')}\`;\n`,
  'utf8',
);

console.log(`Wrote ${lines.length - 1} data rows for ${compounds.length} compounds.`);
