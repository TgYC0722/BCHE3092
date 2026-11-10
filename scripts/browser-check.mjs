// End-to-end check of the real page in headless Chrome via the DevTools
// protocol: loads the app, runs the bundled demo data through webR, validates
// the table / charts / R code panel, then repeats with a dataset that must
// produce explicit "拟合失败" rows. Saves screenshots to .tmp-shot-*.png.
//
// Usage: node scripts/browser-check.mjs [url]

import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PAGE_URL = process.argv[2] ?? 'http://localhost:5173/';
const PORT = 9333;
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const chromePath = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
if (!chromePath) throw new Error('No Chrome/Edge executable found');

const profile = await mkdtemp(join(tmpdir(), 'potency-ranker-chrome-'));
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--window-size=1440,2200',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

async function waitForDevtools() {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error('DevTools endpoint did not become reachable');
}

let ws;
let nextId = 1;
const pending = new Map();
const consoleMessages = [];
const pageErrors = [];
const failedRequests = [];
const externalRequests = [];
const requestUrls = new Map();

async function waitForRunResult({ timeout = 240000 } = {}) {
  const started = Date.now();
  for (;;) {
    const state = await evaluate(`(() => {
      const alert = document.querySelector('#results-body .alert.error');
      const bar = document.querySelector('.results-bar');
      const busy = document.getElementById('run-btn').classList.contains('is-busy');
      return {
        hasResults: !!bar,
        busy,
        status: document.getElementById('run-status').textContent,
        engine: document.getElementById('engine-text').textContent,
        alert: alert ? alert.textContent.replace(/\\s+/g, ' ').trim() : '',
        loading: document.querySelector('.loading-panel p')?.textContent ?? '',
      };
    })()`);
    if (state.hasResults && !state.busy) return state;
    if (!state.busy && (state.alert || state.status.includes('失败'))) {
      throw new Error(
        `fit failed: ${state.alert || state.status}\nengine: ${state.engine}\nloading: ${state.loading}\nconsole: ${consoleMessages.join(' | ')}\nnet: ${failedRequests.join(' | ')}`,
      );
    }
    if (Date.now() - started > timeout) {
      throw new Error(
        `timed out waiting for results\nstatus: ${state.status}\nengine: ${state.engine}\nloading: ${state.loading}\nconsole: ${consoleMessages.join(' | ')}\nnet: ${failedRequests.join(' | ')}`,
      );
    }
    await sleep(500);
  }
}

function send(method, params = {}) {
  const id = nextId;
  nextId += 1;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
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
    throw new Error(
      response.exceptionDetails.exception?.description ?? JSON.stringify(response.exceptionDetails),
    );
  }
  return response.result.value;
}

async function waitFor(expression, { timeout = 240000, interval = 500, label = 'condition' } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await evaluate(expression);
    if (value) return value;
    if (Date.now() - started > timeout) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await sleep(interval);
  }
}

async function screenshot(name, scrollY = 0) {
  await evaluate(`window.scrollTo(0, ${scrollY}); true`);
  await sleep(400);
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(`.tmp-shot-${name}.png`, Buffer.from(data, 'base64'));
  console.log(`   screenshot .tmp-shot-${name}.png`);
}

async function click(selector) {
  return evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`);
}

async function readResults() {
  return evaluate(`(() => {
    const rows = [...document.querySelectorAll('table.results tbody tr')].map((tr) =>
      [...tr.children].map((cell) => cell.textContent.replace(/\\s+/g, ' ').trim()));
    const code = document.querySelector('.code-pre code')?.textContent ?? '';
    const rowCheck = document.querySelector('.row-check');
    return {
      rows,
      charts: document.querySelectorAll('.chart-card').length,
      failedCharts: document.querySelectorAll('.chart-card.is-failed').length,
      codeChars: code.length,
      codeHasNls: code.includes('nls('),
      codeHasConfint: code.includes('confint('),
      codeHasConfintCall: code.includes('confint(fit, "logIC50", level = 0.95)'),
      codeHasFormula: code.includes('bottom + (top - bottom) / (1 + 10^((logIC50 - log10_conc) * hill))'),
      codeHasUrlData: code.includes('compound%2Cconc_nM%2Cresponse_pct%2Creplicate'),
      rowCheck: rowCheck ? rowCheck.textContent.replace(/\\s+/g, ' ').trim() : '',
      rowCheckOk: Boolean(document.querySelector('.row-check.is-ok')),
      rowCheckWarn: Boolean(document.querySelector('.row-check.is-warn')),
      exportEnabled: !document.getElementById('export-btn').disabled,
      status: document.getElementById('run-status').textContent,
      engine: document.getElementById('engine-text').textContent,
      summary: document.querySelector('.results-bar')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
    };
  })()`);
}

try {
  await waitForDevtools();
  const newTarget = await (
    await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(PAGE_URL)}`, { method: 'PUT' })
  ).json();

  ws = new WebSocket(newTarget.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
      return;
    }
    if (message.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(message.params.type)) {
      consoleMessages.push(
        `${message.params.type}: ${message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' ')}`,
      );
    }
    if (message.method === 'Runtime.exceptionThrown') {
      pageErrors.push(message.params.exceptionDetails.exception?.description ?? 'exception');
    }
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
      pageErrors.push(`${message.params.entry.source}: ${message.params.entry.text}`);
    }
    if (message.method === 'Network.requestWillBeSent') {
      requestUrls.set(message.params.requestId, message.params.request.url);
      const url = message.params.request.url;
      const local =
        url.startsWith('http://localhost:5173') ||
        url.startsWith('data:') ||
        url.startsWith('blob:') ||
        url.startsWith('about:');
      if (!local) externalRequests.push(url);
    }
    if (message.method === 'Network.responseReceived' && message.params.response.status >= 400) {
      failedRequests.push(`${message.params.response.status} ${message.params.response.url}`);
    }
    if (message.method === 'Network.loadingFailed') {
      const url = requestUrls.get(message.params.requestId) ?? message.params.requestId;
      failedRequests.push(`${message.params.errorText} ${url}`);
    }
  });

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Log.enable');
  await send('Network.enable');

  await send('Page.navigate', { url: PAGE_URL });
  await waitFor('document.readyState === "complete"', { label: 'page load' });
  await waitFor('!!document.querySelector(".card")', { label: 'app render' });

  console.log(`page loaded: ${PAGE_URL}`);
  console.log('isolated:', await evaluate('crossOriginIsolated'));
  await screenshot('empty', 0);

  // --- happy path ----------------------------------------------------
  if (!(await click('#sample-btn'))) throw new Error('sample button missing');
  await waitFor('document.querySelectorAll(".mini-table tbody tr").length === 6', {
    label: 'self-check table',
  });
  const selfCheck = await evaluate(
    `document.getElementById('selfcheck-body').textContent.replace(/\\s+/g, ' ').trim()`,
  );
  console.log('self-check:', selfCheck.slice(0, 220));

  await click('#run-btn');
  console.log('run started…');
  await waitForRunResult();
  await sleep(500);

  const results = await readResults();
  console.log(`\nrun status: ${results.status}`);
  console.log(`engine: ${results.engine}`);
  console.log(`charts: ${results.charts} (failed: ${results.failedCharts})`);
  console.log(`code: ${results.codeChars} chars (nls=${results.codeHasNls}, confint=${results.codeHasConfint}, formula=${results.codeHasFormula}, data=${results.codeHasUrlData})`);
  console.log(`row check: ${results.rowCheck}`);
  console.log(`export enabled: ${results.exportEnabled}`);
  console.log('table:');
  for (const row of results.rows) console.log('  ', row.join(' | '));

  await screenshot('top', 0);
  const tableY = await evaluate('document.querySelector(".table-wrap").getBoundingClientRect().top + window.scrollY - 40');
  await screenshot('table', Math.max(0, tableY));
  const chartY = await evaluate('document.querySelector(".charts-grid").getBoundingClientRect().top + window.scrollY - 40');
  await screenshot('charts', Math.max(0, chartY));
  const codeY = await evaluate('document.querySelector(".code-panel").getBoundingClientRect().top + window.scrollY - 40');
  await screenshot('code', Math.max(0, codeY));
  await evaluate('window.scrollTo(0, 0); true');

  // --- export --------------------------------------------------------
  const downloadDir = await mkdtemp(join(tmpdir(), 'potency-ranker-dl-'));
  await send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: downloadDir,
    eventsEnabled: true,
  });
  await click('#export-btn');
  let exported = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const files = readdirSync(downloadDir).filter((file) => file.endsWith('.csv'));
    if (files.length) {
      exported = readFileSync(join(downloadDir, files[0]), 'utf8');
      break;
    }
    await sleep(250);
  }
  if (!exported) throw new Error('导出结果 CSV did not produce a file');
  const exportLines = exported.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  console.log(`\nexport: ${exportLines.length - 1} data rows`);
  console.log(`  header: ${exportLines[0]}`);
  console.log(`  first:  ${exportLines[1]}`);
  if (exportLines.length !== 7 || !exported.includes('拟合成功')) {
    throw new Error('unexpected exported CSV content');
  }

  // --- failure path --------------------------------------------------
  const edgeCsv = [
    'compound,conc_nM,response_pct,replicate',
    'Good,0.1,3.1,1', 'Good,0.1,4.2,2', 'Good,0.1,2.8,3',
    'Good,1,15.2,1', 'Good,1,16.8,2', 'Good,1,14.5,3',
    'Good,10,50.4,1', 'Good,10,52.1,2', 'Good,10,49.3,3',
    'Good,100,84.6,1', 'Good,100,86.2,2', 'Good,100,85.1,3',
    'Good,1000,96.2,1', 'Good,1000,97.4,2', 'Good,1000,96.8,3',
    // decreasing curve: must still fit, with a negative Hill slope
    'Down,0.1,94.6,1', 'Down,0.1,93.9,2',
    'Down,1,89.6,1', 'Down,1,90.2,2',
    'Down,3,77.8,1', 'Down,3,78.6,2',
    'Down,10,50.0,1', 'Down,10,49.1,2',
    'Down,100,10.3,1', 'Down,100,11.0,2',
    'Down,1000,5.4,1', 'Down,1000,6.1,2',
    'OnlyThree,1,5,1', 'OnlyThree,10,50,1', 'OnlyThree,100,95,1',
  ].join('\n');

  await evaluate(`(() => {
    const file = new File([${JSON.stringify(edgeCsv)}], 'edge.csv', { type: 'text/csv' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const input = document.getElementById('file-input');
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await waitFor('document.querySelectorAll(".mini-table tbody tr").length === 3', {
    label: 'edge self-check',
  });
  await click('#run-btn');
  await waitForRunResult();
  await sleep(500);
  const edge = await readResults();
  console.log(`\nedge status: ${edge.status}`);
  console.log(`edge charts: ${edge.charts} (failed: ${edge.failedCharts})`);
  for (const row of edge.rows) console.log('  ', row.join(' | '));
  await screenshot('edge', 0);

  // --- invalid CSV is rejected without breaking the page -----------------
  await evaluate(`(() => {
    const file = new File([${JSON.stringify('compound,conc_nM,response_pct\nA,1,2\n')}], 'bad.csv', { type: 'text/csv' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const input = document.getElementById('file-input');
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await waitFor(
    'document.getElementById("run-btn").disabled === true && document.querySelector(".panel-tag.error")',
    { label: 'invalid CSV rejection' },
  );
  console.log('invalid CSV rejected, run button disabled');
  await screenshot('bad-csv', 0);

  console.log('\nconsole warnings/errors:', consoleMessages.length ? consoleMessages : 'none');
  console.log('page errors:', pageErrors.length ? pageErrors : 'none');
  console.log('external requests:', externalRequests.length ? externalRequests : 'none (fully self-hosted)');

  const failedRows = edge.rows.filter((row) => row.join(' ').includes('拟合失败')).length;
  const happyFailed = results.rows.filter((row) => row.join(' ').includes('拟合失败')).length;
  const downRow = edge.rows.find((row) => row[1] === 'Down');
  if (results.rows.length !== 6 || happyFailed !== 0) {
    throw new Error(`happy path returned ${results.rows.length} rows, ${happyFailed} failed`);
  }
  if (!results.rowCheckOk || results.rowCheckWarn) {
    throw new Error(`row bookkeeping was not confirmed: ${results.rowCheck}`);
  }
  if (!results.codeHasConfintCall || !results.codeHasFormula || !results.codeHasUrlData) {
    throw new Error('the R code panel does not contain the executed 4PL / confint code');
  }
  if (edge.rowCheckWarn || !edge.rowCheckOk) {
    throw new Error(`edge row bookkeeping was not confirmed: ${edge.rowCheck}`);
  }
  if (edge.rows.length !== 3 || failedRows !== 1) {
    throw new Error(`edge path returned ${edge.rows.length} rows, ${failedRows} failed`);
  }
  if (!downRow || downRow[5].startsWith('—') || !downRow[5].startsWith('-')) {
    throw new Error(`decreasing curve did not fit with a negative Hill slope: ${downRow?.join(' | ')}`);
  }
  if (pageErrors.length) throw new Error('page errors were raised');
  if (externalRequests.length) throw new Error(`external requests were made: ${externalRequests.join(', ')}`);
  if (failedRequests.length) throw new Error(`failed requests: ${failedRequests.join(', ')}`);

  console.log('\nALL BROWSER CHECKS PASSED');
} finally {
  try {
    if (ws) ws.close();
  } catch {
    /* ignore */
  }
  chrome.kill();
}
