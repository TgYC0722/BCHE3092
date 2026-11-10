// Copies the webR runtime (worker script, wasm payload and R virtual
// filesystem) from node_modules/webr/dist into public/webr, so the page can
// self-host the R engine instead of downloading it from a CDN.
//
// Called from vite.config.js when the dev server / build starts, and can also
// be run directly with `npm run setup:webr`. The copy is skipped when the
// installed webr version has not changed.
//
// Note: this intentionally does not run as an npm lifecycle script. npm runs
// install scripts with piped stdio, which some sandboxes reject with EPERM.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const source = join(root, 'node_modules', 'webr', 'dist');
const target = join(root, 'public', 'webr');
const stamp = join(target, '.webr-version');

/**
 * @param {{ quiet?: boolean }} [options]
 * @returns {'copied' | 'up-to-date' | 'missing'}
 */
export function ensureWebRRuntime({ quiet = false } = {}) {
  if (!existsSync(source)) {
    console.warn('[setup-webr] node_modules/webr/dist is missing — run `npm install` first.');
    return 'missing';
  }

  const version = JSON.parse(readFileSync(join(root, 'node_modules', 'webr', 'package.json'), 'utf8'))
    .version;
  const installed = existsSync(stamp) ? readFileSync(stamp, 'utf8').trim() : '';

  if (installed === version) {
    if (!quiet) console.log(`[setup-webr] webR ${version} already available in public/webr`);
    return 'up-to-date';
  }

  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  cpSync(source, target, {
    recursive: true,
    force: true,
    // Node-only bundles and source maps are not needed by the browser.
    filter: (path) => !path.endsWith('.cjs') && !path.endsWith('.map'),
  });
  writeFileSync(stamp, `${version}\n`, 'utf8');
  console.log(`[setup-webr] copied webR ${version} to public/webr`);
  return 'copied';
}

// Allow `node scripts/setup-webr.mjs` / `npm run setup:webr` as a standalone step.
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/setup-webr.mjs')) {
  const result = ensureWebRRuntime();
  if (result === 'missing') process.exit(1);
}
