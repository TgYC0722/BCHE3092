// Captures the two README screenshots from the running dev server:
//   screenshots/01_start.png    — empty state, full tool visible
//   screenshots/02_results.png  — parameters table + charts after a fit
//
// Usage: npm run dev (in another terminal), then
//        node scripts/capture-screenshots.mjs [url]
//
// Requires Chrome/Edge. Set CHROME_PATH if it is not in a default location.

import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = join(root, 'screenshots');
const pageUrl = process.argv[2] ?? 'http://localhost:5173/';
const port = 9337;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const candidates = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);
const chromePath = candidates.find((candidate) => existsSync(candidate));
if (!chromePath) throw new Error('No Chrome/Edge executable found');

const profile = await mkdtemp(join(tmpdir(), 'potency-ranker-shots-'));
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

async function waitForDevtools() {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error('DevTools endpoint did not become reachable');
}

let socket;
let nextId = 1;
const pending = new Map();

function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const response = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description ?? 'evaluate failed');
  }
  return response.result.value;
}

async function waitFor(expression, timeout = 240000) {
  const started = Date.now();
  for (;;) {
    if (await evaluate(expression)) return;
    if (Date.now() - started > timeout) throw new Error(`Timed out: ${expression}`);
    await sleep(300);
  }
}

async function capture(path) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(path, Buffer.from(data, 'base64'));
  console.log(`wrote ${path}`);
}

try {
  await waitForDevtools();
  const target = await (
    await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(pageUrl)}`, { method: 'PUT' })
  ).json();

  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  });

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1250,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send('Page.navigate', { url: pageUrl });
  await waitFor('document.readyState === "complete" && !!document.querySelector(".card")');
  await sleep(500);

  await mkdir(outputDir, { recursive: true });
  await evaluate('window.scrollTo(0, 0); true');
  await sleep(300);
  await capture(join(outputDir, '01_start.png'));

  await evaluate("document.getElementById('sample-btn').click(); true");
  await waitFor('document.querySelectorAll(".mini-table tbody tr").length === 6');
  await evaluate("document.getElementById('run-btn').click(); true");
  await waitFor(
    `!!document.querySelector('.results-bar') && !document.getElementById('run-btn').classList.contains('is-busy')`,
  );
  await sleep(700);

  const y = await evaluate(
    'document.querySelector("#results-card").getBoundingClientRect().top + window.scrollY - 18',
  );
  await evaluate(`window.scrollTo(0, ${Math.max(0, Math.round(y))}); true`);
  await sleep(500);
  await capture(join(outputDir, '02_results.png'));
} finally {
  try {
    socket?.close();
  } catch {
    /* ignore */
  }
  chrome.kill();
}
