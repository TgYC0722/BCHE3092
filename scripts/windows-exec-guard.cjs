/**
 * Windows sandbox guard for Vite.
 *
 * Vite runs `exec("net use")` once while initialising its Windows path
 * handling, to learn about mapped network drives. In confined environments
 * that forbid child processes with piped stdio, `exec` throws EPERM
 * synchronously and the dev server answers every module request with a 500.
 *
 * The information is only an optimisation, so when (and only when) the probe
 * fails with EPERM we replace `exec("net use")` with a call that reports an
 * error to Vite. On normal machines nothing is patched.
 *
 * Loaded via `node --require ./scripts/windows-exec-guard.cjs` from the
 * `npm run dev` / `npm run build` scripts.
 */

const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');

let blocked = false;
try {
  childProcess.exec('net use', () => {});
} catch (error) {
  blocked = Boolean(error && error.code === 'EPERM');
}

if (blocked) {
  const originalExec = childProcess.exec;
  childProcess.exec = function exec(command, options, callback) {
    let cb = callback;
    let opts = options;
    if (typeof opts === 'function') {
      cb = opts;
      opts = undefined;
    }
    if (String(command).trim().toLowerCase() === 'net use') {
      if (cb) {
        const error = new Error('spawn EPERM');
        error.code = 'EPERM';
        process.nextTick(() => cb(error, '', ''));
      }
      // Vite ignores the returned child process; a minimal stand-in is enough.
      const stub = new EventEmitter();
      stub.kill = () => {};
      stub.stdin = null;
      stub.stdout = null;
      stub.stderr = null;
      return stub;
    }
    return originalExec.call(this, command, opts, cb);
  };
}
