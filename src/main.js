import './style.css';
import { inspectCsv, toCsv } from './csv.js';
import { checkRowConsistency, formatRowCheck } from './consistency.js';
import { buildRCode, parseFitLines } from './r-code.js';
import { renderDoseResponseSvg } from './plot.js';
import {
  formatConc,
  formatFixed,
  formatInt,
  formatNumber,
  formatRange,
} from './format.js';
import { ensureEngine, runRCode } from './webr-engine.js';
import { SAMPLE_CSV } from './sample.js';

const $ = (id) => document.getElementById(id);

const dom = {
  dropzone: $('dropzone'),
  fileInput: $('file-input'),
  fileMeta: $('file-meta'),
  selfcheckTag: $('selfcheck-tag'),
  selfcheckBody: $('selfcheck-body'),
  runBtn: $('run-btn'),
  runBtnLabel: $('run-btn-label'),
  runHint: $('run-hint'),
  runStatus: $('run-status'),
  sampleBtn: $('sample-btn'),
  exportBtn: $('export-btn'),
  resultsBody: $('results-body'),
  engineBadge: $('engine-badge'),
  engineText: $('engine-text'),
  rVersion: $('r-version'),
};

const EMPTY_SELFCHECK = dom.selfcheckBody.innerHTML;

const state = {
  inspection: null,
  sourceName: '',
  results: null,
  running: false,
};

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));

/** RSE above min(5 percentage points, 10% of the fitted dynamic range). */
const rseThreshold = (row) =>
  Math.min(5, 0.1 * Math.abs((row.top ?? 0) - (row.bottom ?? 0)));

function setRunStatus(text, kind = '') {
  dom.runStatus.textContent = text;
  dom.runStatus.className = `run-status${kind ? ` is-${kind}` : ''}`;
}

function setEngineBadge(kind, text) {
  dom.engineBadge.className = `badge${kind ? ` is-${kind}` : ''}`;
  dom.engineText.textContent = text;
}

function setBusy(busy) {
  dom.runBtn.disabled = busy || !state.inspection;
  dom.runBtn.classList.toggle('is-busy', busy);
  dom.runBtnLabel.textContent = busy ? '拟合中…' : 'Run fit';
  dom.sampleBtn.disabled = busy;
}

function resetResults() {
  state.results = null;
  dom.exportBtn.disabled = true;
}

/* ------------------------------------------------------------------ */
/* Data self-check                                                     */
/* ------------------------------------------------------------------ */

function renderSelfCheck(inspection) {
  if (!inspection) {
    dom.selfcheckTag.textContent = '等待数据';
    dom.selfcheckTag.className = 'panel-tag';
    dom.selfcheckBody.innerHTML = EMPTY_SELFCHECK;
    return;
  }

  if (!inspection.ok) {
    dom.selfcheckTag.textContent = '未通过';
    dom.selfcheckTag.className = 'panel-tag error';
    const details = (inspection.details ?? []).map((line) => `<li>${esc(line)}</li>`).join('');
    const header = inspection.header?.length
      ? `<p class="small" style="margin-top:8px">检测到的表头：<code>${esc(
          inspection.header.join(', '),
        )}</code></p>`
      : '';
    const skippedList = inspection.skipped?.length
      ? `<details class="skipped" open>
           <summary>被跳过的 ${inspection.skipped.length} 行</summary>
           <div class="skipped-list">${inspection.skipped
             .map((row) => `第 ${row.line} 行 — ${esc(row.reason)}`)
             .join('<br>')}</div>
         </details>`
      : '';
    dom.selfcheckBody.innerHTML = `
      <div class="selfcheck-error">
        <strong>${esc(inspection.error ?? '数据格式不正确。')}</strong>
        ${details ? `<ul>${details}</ul>` : ''}
      </div>
      ${header}${skippedList}`;
    return;
  }

  const skipped = inspection.skipped;
  const skippedCount = skipped.length;
  dom.selfcheckTag.textContent = skippedCount ? `已读入 · 跳过 ${skippedCount} 行` : '已读入';
  dom.selfcheckTag.className = `panel-tag ${skippedCount ? 'warn' : 'ok'}`;

  const compoundRows = inspection.compounds
    .map(
      (compound) => `
      <tr>
        <td title="${esc(compound.name)}">${esc(compound.name)}</td>
        <td class="num">${compound.n}</td>
        <td class="num">${compound.levels}</td>
        <td class="num">${esc(compound.replicates)}</td>
        <td class="num">${formatConc(compound.concMin)} – ${formatConc(compound.concMax)}</td>
      </tr>`,
    )
    .join('');

  const tooFew = inspection.compounds.filter((compound) => compound.tooFewLevels);

  const skipBreakdown = [
    ['存在缺失值', '缺失值'],
    ['有单元格不是数值', '非数值'],
    ['浓度 ≤ 0，无法取 log10', '浓度 ≤ 0'],
  ]
    .map(([reason, label]) => {
      const count = skipped.filter((row) => row.reason === reason).length;
      return count ? `${label} ${count} 行` : '';
    })
    .filter(Boolean)
    .join(' · ');

  const skippedList = skippedCount
    ? `<p class="small muted" style="margin-top:10px">跳过的 ${skippedCount} 行：${esc(
        skipBreakdown,
      )}</p>
       <details class="skipped">
         <summary>查看被跳过的 ${skippedCount} 行（不参与拟合，但逐行列在这里）</summary>
         <div class="skipped-list">${skipped
           .map((row) => `第 ${row.line} 行 — ${esc(row.reason)}`)
           .join('<br>')}</div>
       </details>`
    : '<p class="small muted" style="margin-top:10px">没有缺失值或无效行：所有数据行都参与了拟合。</p>';

  const tooFewNote = tooFew.length
    ? `<p class="small" style="margin-top:10px;color:var(--amber)">⚠ ${tooFew
        .map((compound) => `${esc(compound.name)}（仅 ${compound.levels} 个浓度点）`)
        .join('、')} 的浓度点少于 4 个，4PL 拟合会失败，结果表里会给出原因。</p>`
    : '';

  dom.selfcheckBody.innerHTML = `
    <div class="stats-grid">
      <div class="stat">
        <span class="stat-label">总行数</span>
        <span class="stat-value">${formatInt(inspection.totalRows)}</span>
      </div>
      <div class="stat">
        <span class="stat-label">化合物</span>
        <span class="stat-value">${inspection.compounds.length}</span>
      </div>
      <div class="stat">
        <span class="stat-label">浓度范围</span>
        <span class="stat-value" title="${esc(formatRange(inspection.range.min, inspection.range.max))}">${esc(
          formatRange(inspection.range.min, inspection.range.max),
        )}</span>
      </div>
      <div class="stat">
        <span class="stat-label">跳过行数</span>
        <span class="stat-value ${skippedCount ? 'is-warn' : ''}">${skippedCount}</span>
      </div>
    </div>
    <table class="mini-table">
      <thead>
        <tr>
          <th>化合物</th>
          <th class="num">有效 n</th>
          <th class="num">浓度点位数</th>
          <th class="num">重复数/浓度</th>
          <th class="num">浓度范围 (nM)</th>
        </tr>
      </thead>
      <tbody>${compoundRows}</tbody>
    </table>
    ${tooFewNote}
    ${skippedList}`;
}

/* ------------------------------------------------------------------ */
/* Results states                                                      */
/* ------------------------------------------------------------------ */

function renderReadyState(inspection) {
  const skipped = inspection.skipped.length;
  const chips = inspection.compounds
    .map((compound) => `<span class="summary-chip">${esc(compound.name)}</span>`)
    .join('');
  dom.resultsBody.innerHTML = `
    <div class="alert info">
      已读入 <strong>${inspection.validRows}</strong> 行有效数据、<strong>${inspection.compounds.length}</strong> 个化合物${
        skipped ? `；另有 <strong>${skipped}</strong> 行无效/缺失，已在数据自检中逐行列出` : ''
      }。点击 <strong>Run fit</strong> 开始用 R 拟合。
    </div>
    <div class="results-bar" style="margin-top:14px">${chips}</div>`;
}

function renderResultsEmpty(message) {
  dom.resultsBody.innerHTML = `
    <div class="alert error">${esc(message)}</div>
    <div class="empty-state" style="margin-top:16px">
      <div class="empty-grid">
        <article class="empty-card">
          <span class="empty-index">①</span><h3>参数表</h3>
          <p>IC50、95% 置信区间上下限、Hill 斜率、top / bottom、数据点数、残差标准误与状态。</p>
        </article>
        <article class="empty-card">
          <span class="empty-index">②</span><h3>剂量–反应图</h3>
          <p>每个化合物单独一张图：log10 浓度轴、全部原始重复散点、4PL 拟合曲线、IC50 竖虚线。</p>
        </article>
        <article class="empty-card">
          <span class="empty-index">③</span><h3>R code</h3>
          <p>原样展示本次实际在 webR 中执行的 R 代码，只用 base R 与 stats。</p>
        </article>
      </div>
    </div>`;
}

function renderLoading(message) {
  dom.resultsBody.innerHTML = `
    <div class="loading-panel">
      <div class="loading-ring"></div>
      <p>${esc(message)}</p>
    </div>`;
}

function renderRunError(message, detail = '') {
  dom.resultsBody.innerHTML = `
    <div class="alert error">
      <strong>拟合没有完成。</strong><br>
      ${esc(message)}
      ${detail ? `<br><span class="small">${esc(detail)}</span>` : ''}
      <br><span class="small">页面没有崩溃：修正数据或检查浏览器控制台后可以再次点击 Run fit。</span>
    </div>`;
}

/* ------------------------------------------------------------------ */
/* Results rendering                                                   */
/* ------------------------------------------------------------------ */

function statusCell(row) {
  if (!row.ok) {
    return `<span class="chip fail">拟合失败</span>
      <span class="status-reason" title="${esc(row.message)}">${esc(
        row.message || 'nls() 未收敛，且没有返回错误信息',
      )}</span>`;
  }
  const notes = [...row.warnings];
  if (row.rseHigh) {
    notes.push(
      `残差偏大：RSE ${formatFixed(row.rse, 2)} > 阈值 ${formatFixed(row.rseThreshold, 2)}`,
    );
  }
  if (!notes.length) return '<span class="chip ok">拟合成功</span>';
  return `<span class="chip warn">拟合成功 · 警告</span>${notes
    .map((note) => `<span class="status-reason is-warn">${esc(note)}</span>`)
    .join('')}`;
}

function chartSubtitle(row) {
  if (!row.ok) return `n = ${row.n} · 未得到拟合曲线`;
  const ci =
    row.ciLow !== null && row.ciHigh !== null
      ? `${formatNumber(row.ciLow)}–${formatNumber(row.ciHigh)} nM`
      : '不可用';
  return `IC50 ${formatNumber(row.ic50)} nM · 95% CI ${ci} · n = ${row.n}`;
}

function renderResults() {
  const { rows, code, elapsed } = state.results;

  const pointsByCompound = new Map();
  for (const record of state.inspection.records) {
    if (!pointsByCompound.has(record.compound)) pointsByCompound.set(record.compound, []);
    pointsByCompound.get(record.compound).push(record);
  }

  const model = rows.map((row, index) => {
    row.index = index;
    row.points = pointsByCompound.get(row.compound) ?? [];
    row.warnings = row.message ? row.message.split(' | ').filter(Boolean) : [];
    row.rseThreshold = rseThreshold(row);
    row.rseHigh = row.ok && row.rse !== null && row.rse > row.rseThreshold;
    return row;
  });

  const sorted = [...model].sort((a, b) => {
    if (a.ok !== b.ok) return a.ok ? -1 : 1;
    if (!a.ok) return a.index - b.index;
    if (a.ic50 === null) return 1;
    if (b.ic50 === null) return -1;
    return a.ic50 - b.ic50;
  });

  let rank = 0;
  for (const row of sorted) {
    row.rank = row.ok ? (rank += 1) : null;
  }

  const okCount = sorted.filter((row) => row.ok).length;
  const failCount = sorted.length - okCount;
  const warnCount = sorted.filter((row) => row.ok && (row.warnings.length || row.rseHigh)).length;

  const tableRows = sorted
    .map((row) => {
      const failed = !row.ok;
      const ciLow = row.ok && row.ciLow !== null ? formatNumber(row.ciLow) : '—';
      const ciHigh = row.ok && row.ciHigh !== null ? formatNumber(row.ciHigh) : '—';
      return `
        <tr class="${failed ? 'is-failed' : ''}">
          <td class="rank">${row.ok ? row.rank : '—'}</td>
          <td class="compound">${esc(row.compound)}</td>
          <td class="num ic50">${row.ok ? formatNumber(row.ic50) : '—'}</td>
          <td class="num">${ciLow}</td>
          <td class="num">${ciHigh}</td>
          <td class="num">${row.ok ? formatFixed(row.hill, 2) : '—'}</td>
          <td class="num">${row.ok ? formatFixed(row.top, 1) : '—'}</td>
          <td class="num">${row.ok ? formatFixed(row.bottom, 1) : '—'}</td>
          <td class="num">${formatInt(row.n)}</td>
          <td class="num">${
            row.ok && row.rse !== null
              ? `${formatFixed(row.rse, 2)}${
                  row.rseHigh
                    ? ` <span class="rse-flag" title="RSE 高于阈值 ${formatFixed(
                        row.rseThreshold,
                        2,
                      )}">⚠</span>`
                    : ''
                }`
              : '—'
          }</td>
          <td class="status-cell">${statusCell(row)}</td>
        </tr>`;
    })
    .join('');

  const chartCards = sorted
    .map((row) => {
      const svg = renderDoseResponseSvg({
        compound: row.compound,
        points: row.points,
        curve: row.ok ? row.curve : [],
        ic50: row.ok ? row.ic50 : null,
        ok: row.ok,
      });
      const note = row.ok
        ? row.rseHigh
          ? `<p class="chart-note" style="color:var(--amber)">⚠ 残差偏大：RSE ${formatFixed(
              row.rse,
              2,
            )}（阈值 ${formatFixed(row.rseThreshold, 2)}）——曲线对这批点的解释力有限。</p>`
          : '<p class="chart-note">原始重复点全部画出；虚线为该化合物的 IC50。</p>'
        : `<p class="chart-fail-note">拟合失败：${esc(
            row.message || 'nls() 未收敛',
          )}<br><span class="small">散点仍保留在图中，但没有曲线和 IC50 参考线。</span></p>`;
      return `
        <article class="chart-card ${row.ok ? '' : 'is-failed'}">
          <div class="chart-head">
            <span class="chart-rank">${row.ok ? `#${row.rank}` : '—'}</span>
            <div style="min-width:0">
              <h4 class="chart-title">${esc(row.compound)}</h4>
              <p class="chart-sub">${chartSubtitle(row)}</p>
            </div>
          </div>
          ${svg}
          ${note}
        </article>`;
    })
    .join('');

  const summaryChips = [
    `<span class="summary-chip"><span class="dot"></span>${okCount} / ${sorted.length} 拟合成功</span>`,
    failCount
      ? `<span class="summary-chip is-fail"><span class="dot"></span>${failCount} 拟合失败</span>`
      : '',
    warnCount
      ? `<span class="summary-chip is-warn"><span class="dot"></span>${warnCount} 有警告 / 残差偏大</span>`
      : '',
    `<span class="summary-chip">用时 ${elapsed.toFixed(1)} s</span>`,
  ]
    .filter(Boolean)
    .join('');

  const consistency = state.results.consistency;
  const rowCheck = consistency ? formatRowCheck(consistency, sorted.length) : '';

  dom.resultsBody.innerHTML = `
    <div class="results-stack">
      <div class="results-bar">
        ${summaryChips}
        <span class="summary-note">排序：IC50 由小到大（效力由强到弱）；失败的化合物排在最后。</span>
      </div>

      <section>
        <h3 class="section-title">参数表 <span class="hint">${sorted.length} 个化合物 · 每个化合物单独拟合</span></h3>
        ${rowCheck}
        <div class="table-wrap">
          <table class="results">
            <thead>
              <tr>
                <th>#</th>
                <th>化合物</th>
                <th class="num">IC50 (nM)</th>
                <th class="num">95% CI 下限 (nM)</th>
                <th class="num">95% CI 上限 (nM)</th>
                <th class="num">Hill</th>
                <th class="num">top (%)</th>
                <th class="num">bottom (%)</th>
                <th class="num">数据点数</th>
                <th class="num">残差标准误 (%)</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>${tableRows}</tbody>
          </table>
        </div>
        <p class="table-footnote">
          IC50 与 95% CI 都是对 logIC50 做 <code>confint(fit, "logIC50", level = 0.95)</code>（profile
          likelihood）后再用 10^ 反变换得到，因此在 nM 尺度上区间并不对称，上下限分别保留。
          RSE 为残差标准误（响应百分比单位）；RSE &gt; min(5, 10% × |top − bottom|) 时标记为「残差偏大」，
          不会只给一个好看的 R²。拟合失败的化合物不参与排序，也不会被静默丢弃。
        </p>
      </section>

      <section>
        <div class="charts-head">
          <h3 class="section-title" style="margin:0">剂量–反应图 <span class="hint">横轴 log10 浓度 · 全部重复点 + 拟合曲线 + IC50</span></h3>
          <div class="legend">
            <span class="legend-item"><span class="legend-dot"></span>原始重复点</span>
            <span class="legend-item"><span class="legend-swatch"></span>4PL 拟合</span>
            <span class="legend-item"><span class="legend-dash"></span>IC50</span>
          </div>
        </div>
        <div class="charts-grid">${chartCards}</div>
      </section>

      <section>
        <h3 class="section-title">R code <span class="hint">本次实际执行的代码，原样打印</span></h3>
        <div class="code-panel">
          <div class="code-head">
            <span><span class="dots"><i></i><i></i><i></i></span>potency-ranker.R · webR</span>
            <button class="btn-mini" type="button" data-action="copy-r">复制代码</button>
          </div>
          <pre class="code-pre"><code>${esc(code)}</code></pre>
          <p class="code-note">
            只使用 base R 与 stats（nls / confint / predict），没有加载任何其他 R 包。
            上传的 CSV 以 URL 编码字符串传入，R 端用 URLdecode() 还原后交给 read.csv(text = ...)。
            数据没有离开这个浏览器。
          </p>
        </div>
      </section>
    </div>`;

  state.results.sorted = sorted;
  dom.exportBtn.disabled = false;
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

function applyData(text, sourceName, metaLabel) {
  resetResults();
  dom.fileInput.value = '';

  const inspection = inspectCsv(text);
  state.sourceName = sourceName;

  if (!inspection.ok) {
    state.inspection = null;
    dom.dropzone.classList.remove('has-file');
    dom.fileMeta.hidden = true;
    dom.runBtn.disabled = true;
    dom.runHint.textContent = 'CSV 未通过自检，修正后重新上传。';
    setRunStatus('数据自检未通过', 'error');
    renderSelfCheck(inspection);
    renderResultsEmpty(inspection.error ?? '数据未通过自检，暂时无法拟合。');
    return;
  }

  state.inspection = inspection;
  dom.dropzone.classList.add('has-file');
  dom.fileMeta.hidden = false;
  dom.fileMeta.textContent = `${metaLabel} · ${inspection.validRows} 行有效`;
  dom.runBtn.disabled = false;
  dom.runHint.textContent = '数据已读入。点击 Run fit，在浏览器内启动 R 并逐个化合物拟合。';
  setRunStatus('');
  renderSelfCheck(inspection);
  renderReadyState(inspection);
}

async function loadFile(file) {
  if (!file) return;
  if (state.running) return;

  dom.dropzone.classList.remove('has-file');
  dom.fileMeta.hidden = false;
  dom.fileMeta.textContent = `读取中：${file.name}…`;

  try {
    const text = await file.text();
    const sizeKb = (file.size / 1024).toFixed(1);
    applyData(text, file.name, `${file.name} · ${sizeKb} KB`);
    if (state.inspection) {
      dom.fileMeta.textContent = `${file.name} · ${sizeKb} KB · ${state.inspection.validRows} 行有效`;
    }
  } catch (error) {
    resetResults();
    state.inspection = null;
    dom.runBtn.disabled = true;
    dom.fileMeta.hidden = true;
    dom.dropzone.classList.remove('has-file');
    dom.runHint.textContent = '文件读取失败，请重新选择。';
    setRunStatus('文件读取失败', 'error');
    renderRunError('读取文件失败。', error?.message ?? String(error));
  }
}

function loadSample() {
  if (state.running) return;
  applyData(SAMPLE_CSV, '示例数据', '示例数据（6 个化合物 × 10 个浓度 × 3 重复）');
}

async function runFit() {
  if (state.running || !state.inspection?.ok) return;

  state.running = true;
  setBusy(true);
  setRunStatus('正在启动 R 引擎…');
  setEngineBadge('busy', 'R 引擎：启动中');
  renderLoading('正在启动 R 引擎（首次需要加载 wasm，约数秒）…');

  const started = performance.now();

  try {
    const engine = await ensureEngine();
    setEngineBadge('ready', `R ${engine.rVersionNumber} · webR ${engine.webrVersion}`);
    dom.rVersion.textContent = `${engine.rVersion} · webR ${engine.webrVersion}`;

    setRunStatus(`R ${engine.rVersionNumber} 已就绪，正在拟合 ${state.inspection.compounds.length} 个化合物…`);
    renderLoading(
      `R ${engine.rVersionNumber} 已就绪，正在逐个化合物拟合 4PL 曲线（nls + confint profile likelihood）…`,
    );

    // Build the exact program that is executed and shown in the R code panel.
    const code = buildRCode(state.inspection.csvText);
    const lines = await runRCode(code);
    const parsed = parseFitLines(lines);

    if (!parsed.length) {
      throw new Error('R 没有返回任何拟合结果（化合物列表为空）。');
    }

    state.results = {
      rows: parsed,
      code,
      elapsed: (performance.now() - started) / 1000,
      consistency: checkRowConsistency(state.inspection, parsed),
    };
    renderResults();

    const okCount = parsed.filter((row) => row.ok).length;
    const consistencyNote = state.results.consistency.ok ? '' : ' · 行数核对不一致';
    setRunStatus(
      `完成：${okCount} / ${parsed.length} 个化合物拟合成功${consistencyNote} · ${state.results.elapsed.toFixed(1)} s`,
      okCount === parsed.length && state.results.consistency.ok ? '' : 'error',
    );
  } catch (error) {
    console.error(error);
    state.results = null;
    dom.exportBtn.disabled = true;
    setRunStatus('拟合失败', 'error');
    setEngineBadge('error', 'R 引擎：出错');

    const detail = error?.message ?? String(error);
    const runtimeHint = /worker|404|network|failed to fetch|wasm/i.test(detail)
      ? 'webR 运行时可能没有就绪：先执行 npm install（或 npm run setup:webr），确认 public/webr 存在后刷新页面重试。'
      : '';
    renderRunError('R 执行出错。', [detail, runtimeHint].filter(Boolean).join(' '));
  } finally {
    state.running = false;
    setBusy(false);
  }
}

function exportResults() {
  const sorted = state.results?.sorted;
  if (!sorted) return;

  const headers = [
    'compound',
    'ic50_nM',
    'ci_low_nM',
    'ci_high_nM',
    'hill',
    'top_pct',
    'bottom_pct',
    'n_points',
    'residual_se_pct',
    'status',
    'note',
  ];

  const rows = sorted.map((row) => {
    const notes = [];
    if (row.message) notes.push(row.message);
    if (row.rseHigh) {
      notes.push(`残差偏大：RSE ${formatFixed(row.rse, 2)} > ${formatFixed(row.rseThreshold, 2)}`);
    }
    return [
      row.compound,
      row.ok && row.ic50 !== null ? row.ic50 : '',
      row.ok && row.ciLow !== null ? row.ciLow : '',
      row.ok && row.ciHigh !== null ? row.ciHigh : '',
      row.ok && row.hill !== null ? row.hill : '',
      row.ok && row.top !== null ? row.top : '',
      row.ok && row.bottom !== null ? row.bottom : '',
      row.n,
      row.ok && row.rse !== null ? row.rse : '',
      row.ok ? '拟合成功' : '拟合失败',
      notes.join('; '),
    ];
  });

  const csv = toCsv(headers, rows);
  const stamp = new Date()
    .toISOString()
    .slice(0, 19)
    .replace(/[-:T]/g, '')
    .slice(0, 14);
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `potency-ranker-results-${stamp}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

async function copyText(text, button) {
  const original = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const helper = document.createElement('textarea');
    helper.value = text;
    helper.style.position = 'fixed';
    helper.style.opacity = '0';
    document.body.appendChild(helper);
    helper.select();
    document.execCommand('copy');
    helper.remove();
  }
  button.textContent = '已复制';
  setTimeout(() => {
    button.textContent = original;
  }, 1500);
}

/* ------------------------------------------------------------------ */
/* Event wiring                                                        */
/* ------------------------------------------------------------------ */

function openFilePicker() {
  if (state.running) return;
  dom.fileInput.click();
}

dom.dropzone.addEventListener('click', openFilePicker);
dom.dropzone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    openFilePicker();
  }
});

dom.fileInput.addEventListener('change', () => {
  const file = dom.fileInput.files?.[0];
  if (file) loadFile(file);
});

['dragenter', 'dragover'].forEach((type) => {
  dom.dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!state.running) dom.dropzone.classList.add('is-dragover');
  });
});

['dragleave', 'dragend'].forEach((type) => {
  dom.dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!dom.dropzone.contains(event.relatedTarget)) {
      dom.dropzone.classList.remove('is-dragover');
    }
  });
});

dom.dropzone.addEventListener('drop', (event) => {
  event.preventDefault();
  event.stopPropagation();
  dom.dropzone.classList.remove('is-dragover');
  const file = event.dataTransfer?.files?.[0];
  if (file) loadFile(file);
});

// Dropping a file outside the drop zone must not navigate away from the app.
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', (event) => event.preventDefault());

dom.sampleBtn.addEventListener('click', loadSample);
dom.runBtn.addEventListener('click', runFit);
dom.exportBtn.addEventListener('click', exportResults);

dom.resultsBody.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action="copy-r"]');
  if (!button || !state.results?.code) return;
  copyText(state.results.code, button);
});

renderSelfCheck(null);
