import { defineConfig } from 'vite';
import { ensureWebRRuntime } from './scripts/setup-webr.mjs';

// Copy the self-hosted webR runtime into public/webr before Vite starts, so the
// page loads R from this origin instead of the webR CDN.
ensureWebRRuntime();

// webR ships its worker script and WebAssembly payload next to dist/webr.mjs.
// Excluding it from Vite's dependency pre-bundling keeps those relative asset
// URLs intact, and the COOP/COEP headers enable cross-origin isolation so the
// SharedArrayBuffer communication channel can be used.
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  optimizeDeps: {
    // Nothing needs pre-bundling: the only dependency is webR, which must stay
    // untouched so its worker/wasm URLs resolve. Disabling the scan also avoids
    // esbuild's service process, which some sandboxes refuse to start.
    noDiscovery: true,
    include: [],
    exclude: ['webr'],
  },
  server: {
    port: 5173,
    strictPort: true,
    headers: isolationHeaders,
    watch: {
      // The webR runtime is static, and scratch files (screenshots, temporary
      // browser profiles) must never trip the file watcher.
      ignored: ['**/public/webr/**', '**/.tmp-*', '**/.npm-cache/**', '**/*.log'],
    },
  },
  preview: {
    port: 5173,
    strictPort: true,
    headers: isolationHeaders,
  },
  build: {
    target: 'esnext',
    chunkSizeWarningLimit: 4000,
  },
});
