/**
 * Thin wrapper around webR.
 *
 * The R engine is started lazily on the first "Run fit" click. Its worker,
 * WebAssembly payload and R virtual filesystem are self-hosted under
 * /webr/ (copied from node_modules/webr/dist by scripts/setup-webr.mjs), so no
 * request ever leaves the browser to a CDN.
 *
 * API verified against webr 0.6.1 (dist/webR/webr-main.d.ts):
 *   new WebR(options) -> .init() -> .evalRString() / .evalRRaw(code, 'string[]')
 */

import { WebR } from 'webr';

/** Absolute URL of the self-hosted webR runtime folder. */
function baseUrl() {
  return new URL('webr/', document.baseURI).href;
}

let enginePromise = null;
let engine = null;

async function startEngine() {
  const webR = new WebR({ baseUrl: baseUrl() });
  await webR.init();

  const rVersion = await webR.evalRString('R.version.string');
  const match = /R version\s+([\d.]+)/.exec(rVersion);

  engine = {
    webR,
    rVersion,
    rVersionNumber: match ? match[1] : 'R',
    webrVersion: webR.version ?? '',
  };

  return engine;
}

/**
 * Start webR once and reuse the same R session for every run.
 * @returns {Promise<{webR: WebR, rVersion: string, rVersionNumber: string, webrVersion: string}>}
 */
export function ensureEngine() {
  if (engine) return Promise.resolve(engine);
  if (!enginePromise) {
    enginePromise = startEngine().catch((error) => {
      // Allow a retry after a failed start (e.g. temporary load error).
      enginePromise = null;
      throw error;
    });
  }
  return enginePromise;
}

/**
 * Evaluate the generated R program and return its character vector result.
 * @param {string} code
 * @returns {Promise<string[]>}
 */
export async function runRCode(code) {
  const { webR } = await ensureEngine();
  const result = await webR.evalRRaw(code, 'string[]');
  return Array.isArray(result) ? result.map(String) : [];
}
