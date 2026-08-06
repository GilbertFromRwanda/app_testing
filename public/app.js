let presets = {};
let currentEventSource = null;
let currentRunId = null;

const el = (id) => document.getElementById(id);

// ---------- Tabs ----------
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
    btn.classList.add('active');
    el(`tab-${btn.dataset.tab}`).classList.add('active');
  });
});

function switchTab(name) {
  document.querySelector(`.tab-btn[data-tab="${name}"]`).click();
}

// ---------- Stage rows ----------
function addStageRow(duration = '1m', target = 10) {
  const row = document.createElement('div');
  row.className = 'stage-row';
  row.innerHTML = `
    <input type="text" class="stage-duration" placeholder="duration e.g. 2m" value="${duration}" />
    <input type="number" class="stage-target" placeholder="target VUs" value="${target}" />
    <button type="button" class="remove-btn">✕</button>
  `;
  row.querySelector('.remove-btn').addEventListener('click', () => row.remove());
  el('stagesEditor').appendChild(row);
}

function getStages() {
  return [...el('stagesEditor').querySelectorAll('.stage-row')].map((row) => ({
    duration: row.querySelector('.stage-duration').value.trim(),
    target: Number(row.querySelector('.stage-target').value),
  }));
}

function setStages(stages) {
  el('stagesEditor').innerHTML = '';
  stages.forEach((s) => addStageRow(s.duration, s.target));
}

// ---------- Request rows ----------
function addRequestRow(req = {}) {
  const row = document.createElement('div');
  row.className = 'request-row';
  const method = req.method || 'GET';
  row.innerHTML = `
    <select class="req-method">
      ${['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => `<option ${m === method ? 'selected' : ''}>${m}</option>`).join('')}
    </select>
    <input type="text" class="req-path" placeholder="/path (blank = target URL exactly)" value="${req.path || ''}" />
    <input type="text" class="req-status" placeholder="200-299" value="${req.expectStatus || '200-299'}" />
    <button type="button" class="remove-btn">✕</button>
    <textarea class="req-body-row req-body" rows="2" placeholder='JSON body (for POST/PUT/PATCH), e.g. {"key":"value"}'>${req.body || ''}</textarea>
  `;
  row.querySelector('.remove-btn').addEventListener('click', () => row.remove());
  el('requestsEditor').appendChild(row);
}

function getRequests() {
  return [...el('requestsEditor').querySelectorAll('.request-row')].map((row) => ({
    method: row.querySelector('.req-method').value,
    path: row.querySelector('.req-path').value.trim(),
    expectStatus: row.querySelector('.req-status').value.trim() || '200-299',
    body: row.querySelector('.req-body').value.trim(),
  }));
}

function setRequests(requests) {
  el('requestsEditor').innerHTML = '';
  (requests && requests.length ? requests : [{ method: 'GET', path: '' }]).forEach(addRequestRow);
}

el('addStage').addEventListener('click', () => addStageRow());
el('addRequest').addEventListener('click', () => addRequestRow());

// ---------- Auth ----------
function refreshAuthPanels() {
  const type = el('authType').value;
  el('authStatic').classList.toggle('hidden', type !== 'static');
  el('authBasic').classList.toggle('hidden', type !== 'basic');
  el('authLogin').classList.toggle('hidden', type !== 'login');
}
el('authType').addEventListener('change', refreshAuthPanels);

function getAuth() {
  const type = el('authType').value;
  if (type === 'static') {
    return { type, headerName: el('authHeaderName').value.trim() || 'Authorization', headerValue: el('authHeaderValue').value };
  }
  if (type === 'basic') {
    return { type, username: el('authUser').value, password: el('authPass').value };
  }
  if (type === 'login') {
    return {
      type,
      loginMethod: el('authLoginMethod').value,
      loginPath: el('authLoginPath').value.trim(),
      loginBody: el('authLoginBody').value,
      tokenField: el('authTokenField').value.trim(),
      headerName: el('authLoginHeaderName').value.trim() || 'Authorization',
    };
  }
  return { type: 'none' };
}

// ---------- Extra headers ----------
function addHeaderRow(key = '', value = '') {
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = `
    <input type="text" class="header-key" placeholder="Header name, e.g. X-Api-Key" value="${key}" />
    <input type="text" class="header-value" placeholder="Header value" value="${value}" />
    <button type="button" class="remove-btn">✕</button>
  `;
  row.querySelector('.remove-btn').addEventListener('click', () => row.remove());
  el('headersEditor').appendChild(row);
}

function getHeaders() {
  return [...el('headersEditor').querySelectorAll('.row')].map((row) => ({
    key: row.querySelector('.header-key').value.trim(),
    value: row.querySelector('.header-value').value,
  })).filter((h) => h.key);
}

el('addHeader').addEventListener('click', () => addHeaderRow());

// ---------- Mode toggle ----------
document.querySelectorAll('input[name="mode"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    const mode = document.querySelector('input[name="mode"]:checked').value;
    el('stagesEditor').classList.toggle('hidden', mode !== 'stages');
    el('addStage').classList.toggle('hidden', mode !== 'stages');
    el('constantEditor').classList.toggle('hidden', mode !== 'constant');
  });
});

// ---------- Presets ----------
async function loadPresets() {
  const res = await fetch('/api/presets');
  presets = await res.json();
  applyPreset(el('testType').value);
}

function applyPreset(type) {
  const p = presets[type];
  if (!p) {
    el('testTypeDesc').textContent = 'Custom configuration — set everything manually below.';
    return;
  }
  el('testTypeDesc').textContent = p.description || '';

  document.querySelector(`input[name="mode"][value="${p.mode}"]`).checked = true;
  el('stagesEditor').classList.toggle('hidden', p.mode !== 'stages');
  el('addStage').classList.toggle('hidden', p.mode !== 'stages');
  el('constantEditor').classList.toggle('hidden', p.mode !== 'constant');

  if (p.mode === 'stages') setStages(p.stages || []);
  if (p.mode === 'constant') {
    el('vus').value = p.vus ?? 1;
    el('duration').value = p.duration ?? '1m';
  }

  el('thP95').value = p.thresholds?.p95 ?? '';
  el('thFailRate').value = p.thresholds?.failRate ?? '';
  el('thMinReq').value = p.thresholds?.minRequests ?? '';
  el('sleepMin').value = p.sleepMin ?? 1;
  el('sleepMax').value = p.sleepMax ?? 2;
}

el('testType').addEventListener('change', (e) => applyPreset(e.target.value));

// ---------- Config collection ----------
function collectConfig() {
  const mode = document.querySelector('input[name="mode"]:checked').value;
  return {
    testType: el('testType').value,
    target: el('target').value.trim(),
    mode,
    stages: mode === 'stages' ? getStages() : [],
    vus: el('vus').value,
    duration: el('duration').value,
    thresholds: {
      p95: el('thP95').value,
      failRate: el('thFailRate').value,
      minRequests: el('thMinReq').value,
    },
    sleepMin: el('sleepMin').value,
    sleepMax: el('sleepMax').value,
    auth: getAuth(),
    headers: getHeaders(),
    requests: getRequests(),
  };
}

function requireTarget() {
  if (el('target').value.trim()) return true;
  el('target').focus();
  el('target').reportValidity ? el('target').reportValidity() : alert('Enter a target base URL first.');
  return false;
}

// ---------- Load profile chart ----------
// Parses k6/Go-style durations ("2m", "1h30m", "500ms") into seconds.
function parseDurationToSeconds(str) {
  if (!str) return 0;
  const re = /([\d.]+)\s*(ms|s|m|h)/g;
  let total = 0;
  let found = false;
  let match;
  while ((match = re.exec(str))) {
    found = true;
    const val = parseFloat(match[1]);
    const mult = { ms: 0.001, s: 1, m: 60, h: 3600 }[match[2]];
    total += val * mult;
  }
  if (!found) {
    const n = parseFloat(str);
    return Number.isFinite(n) ? n : 0;
  }
  return total;
}

function formatSeconds(s) {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600); s %= 3600;
  const m = Math.floor(s / 60); s %= 60;
  let out = '';
  if (h) out += `${h}h`;
  if (m) out += `${m}m`;
  if (s || (!h && !m)) out += `${s}s`;
  return out;
}

// Picks the most readable unit for a millisecond duration: ms under 1s,
// seconds (with decimals) under a minute, then combined m/h via formatSeconds.
function formatMsDuration(ms) {
  if (!Number.isFinite(ms)) return String(ms);
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 2 : 1)} s`;
  return formatSeconds(s);
}

// Builds the piecewise-linear VU-over-time profile k6 will actually run:
// ramping-vus stages interpolate linearly between targets starting at 0;
// a constant-vus test holds flat at `vus` for the whole duration.
function buildProfilePoints(config) {
  if (config.mode === 'constant') {
    const dur = parseDurationToSeconds(config.duration || '1m') || 1;
    const vus = Number(config.vus) || 1;
    return { points: [{ t: 0, vus }, { t: dur, vus }], totalSeconds: dur, maxVus: vus };
  }
  const stages = (config.stages || []).filter((s) => s.duration);
  const points = [{ t: 0, vus: 0 }];
  let t = 0;
  for (const s of stages) {
    t += parseDurationToSeconds(s.duration);
    points.push({ t, vus: Number(s.target) || 0 });
  }
  const maxVus = Math.max(0, ...points.map((p) => p.vus));
  return { points, totalSeconds: t || 1, maxVus };
}

function niceStep(roughStep) {
  if (roughStep <= 0) return 1;
  const exp = Math.floor(Math.log10(roughStep));
  const f = roughStep / Math.pow(10, exp);
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nf * Math.pow(10, exp);
}

function vuAtTime(points, t) {
  for (let i = 1; i < points.length; i++) {
    if (t <= points[i].t) {
      const a = points[i - 1];
      const b = points[i];
      const span = b.t - a.t;
      const frac = span > 0 ? (t - a.t) / span : 0;
      return a.vus + (b.vus - a.vus) * frac;
    }
  }
  return points[points.length - 1]?.vus ?? 0;
}

function renderProfileChart(config) {
  const wrap = el('profileChart');
  const { points, totalSeconds, maxVus } = buildProfilePoints(config);

  if (points.length < 2 || totalSeconds <= 0) {
    wrap.classList.add('hidden');
    wrap.innerHTML = '';
    return;
  }
  wrap.classList.remove('hidden');

  const W = 640, H = 200;
  const padL = 34, padR = 12, padT = 14, padB = 22;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const yStep = niceStep((maxVus || 1) / 4) || 1;
  const yMax = Math.max(yStep, Math.ceil((maxVus || 1) / yStep) * yStep);
  const yTicks = [];
  for (let v = 0; v <= yMax + 1e-9; v += yStep) yTicks.push(Math.round(v));

  const xScale = (t) => padL + (t / totalSeconds) * plotW;
  const yScale = (v) => padT + plotH - (v / yMax) * plotH;

  const xTickCount = Math.min(6, points.length + 1);
  const xTicks = [];
  for (let i = 0; i <= xTickCount; i++) xTicks.push((totalSeconds * i) / xTickCount);

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xScale(p.t).toFixed(2)} ${yScale(p.vus).toFixed(2)}`).join(' ');
  const areaPath = `${linePath} L ${xScale(points[points.length - 1].t).toFixed(2)} ${yScale(0).toFixed(2)} L ${xScale(0).toFixed(2)} ${yScale(0).toFixed(2)} Z`;

  const peak = points.reduce((max, p) => (p.vus > max.vus ? p : max), points[0]);

  const gridLines = yTicks.map((v) => `<line class="grid-line" x1="${padL}" x2="${W - padR}" y1="${yScale(v).toFixed(2)}" y2="${yScale(v).toFixed(2)}" />`).join('');
  const yLabels = yTicks.map((v) => `<text class="axis-text" x="${padL - 6}" y="${(yScale(v) + 3).toFixed(2)}" text-anchor="end">${v}</text>`).join('');
  const xLabels = xTicks.map((t) => `<text class="axis-text" x="${xScale(t).toFixed(2)}" y="${H - 6}" text-anchor="middle">${formatSeconds(t)}</text>`).join('');
  const vertices = points.map((p) => `<circle class="profile-vertex" cx="${xScale(p.t).toFixed(2)}" cy="${yScale(p.vus).toFixed(2)}" r="4" />`).join('');
  const peakLabel = `<text class="profile-vertex-label" x="${xScale(peak.t).toFixed(2)}" y="${(yScale(peak.vus) - 10).toFixed(2)}" text-anchor="middle">${peak.vus} VUs</text>`;

  wrap.innerHTML = `
    <p class="chart-title">Load profile — target virtual users over ${formatSeconds(totalSeconds)}</p>
    <svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Target virtual users over time">
      ${gridLines}
      <path class="profile-area" d="${areaPath}" />
      <path class="profile-line" d="${linePath}" />
      ${vertices}
      ${peakLabel}
      ${yLabels}
      ${xLabels}
      <g id="chartCrosshair" style="display:none">
        <line class="crosshair-line" x1="0" x2="0" y1="${padT}" y2="${padT + plotH}" />
        <circle class="crosshair-dot" r="4" />
      </g>
      <rect class="chart-hit-area" x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" />
    </svg>
  `;

  let tooltip = wrap.querySelector('.chart-tooltip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.className = 'chart-tooltip';
    tooltip.style.display = 'none';
    wrap.appendChild(tooltip);
  }
  tooltip.style.display = 'none';

  const svg = wrap.querySelector('svg');
  const hitArea = wrap.querySelector('.chart-hit-area');
  const crosshair = wrap.querySelector('#chartCrosshair');
  const crosshairLine = crosshair.querySelector('.crosshair-line');
  const crosshairDot = crosshair.querySelector('.crosshair-dot');

  const onMove = (evt) => {
    const rect = svg.getBoundingClientRect();
    const clientX = evt.touches ? evt.touches[0].clientX : evt.clientX;
    const svgX = ((clientX - rect.left) / rect.width) * W;
    const t = Math.min(totalSeconds, Math.max(0, ((svgX - padL) / plotW) * totalSeconds));
    const vus = vuAtTime(points, t);

    const cx = xScale(t);
    const cy = yScale(vus);
    crosshair.style.display = '';
    crosshairLine.setAttribute('x1', cx.toFixed(2));
    crosshairLine.setAttribute('x2', cx.toFixed(2));
    crosshairDot.setAttribute('cx', cx.toFixed(2));
    crosshairDot.setAttribute('cy', cy.toFixed(2));

    tooltip.style.display = '';
    tooltip.style.left = `${(cx / W) * 100}%`;
    tooltip.style.top = `${(cy / H) * 100}%`;
    tooltip.innerHTML = '';
    const valueEl = document.createElement('div');
    valueEl.className = 'tt-value';
    valueEl.textContent = `${Math.round(vus)} VUs`;
    const timeEl = document.createElement('div');
    timeEl.className = 'tt-time';
    timeEl.textContent = `at ${formatSeconds(t)}`;
    tooltip.appendChild(valueEl);
    tooltip.appendChild(timeEl);
  };

  const onLeave = () => {
    crosshair.style.display = 'none';
    tooltip.style.display = 'none';
  };

  hitArea.addEventListener('mousemove', onMove);
  hitArea.addEventListener('mouseleave', onLeave);
  hitArea.addEventListener('touchmove', onMove, { passive: true });
  hitArea.addEventListener('touchend', onLeave);
}

// ---------- Preview ----------
el('previewBtn').addEventListener('click', async () => {
  if (!requireTarget()) return;
  renderProfileChart(collectConfig());
  const res = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(collectConfig()),
  });
  const data = await res.json();
  if (!res.ok) {
    el('scriptPreview').textContent = `Error: ${data.error}`;
  } else {
    el('scriptPreview').textContent = data.script;
  }
  switchTab('script');
});

// ---------- Progress bar ----------
// k6 doesn't stream progress when stdout isn't a TTY (which it never is here),
// so we estimate progress from wall-clock time against the planned test
// duration we already compute for the load-profile chart.
let progressTimer = null;

function stopProgressTimer() {
  if (progressTimer) {
    clearInterval(progressTimer);
    progressTimer = null;
  }
}

function startProgress(totalSeconds) {
  stopProgressTimer();
  const wrap = el('runProgress');
  const fill = el('progressFill');
  const label = el('progressLabel');
  wrap.classList.remove('hidden');

  if (!totalSeconds || !Number.isFinite(totalSeconds) || totalSeconds <= 0) {
    wrap.classList.add('indeterminate');
    label.innerHTML = '<span>Running…</span><span></span>';
    return;
  }

  wrap.classList.remove('indeterminate');
  const startedAt = Date.now();

  const tick = () => {
    const elapsed = (Date.now() - startedAt) / 1000;
    const pct = Math.min(99, (elapsed / totalSeconds) * 100);
    fill.style.width = `${pct.toFixed(1)}%`;
    label.innerHTML = `<span>${formatSeconds(elapsed)} / ~${formatSeconds(totalSeconds)}</span><span>${Math.round(pct)}%</span>`;
  };
  tick();
  progressTimer = setInterval(tick, 300);
}

function finishProgress(success) {
  stopProgressTimer();
  const wrap = el('runProgress');
  wrap.classList.remove('indeterminate');
  el('progressFill').style.width = '100%';
  const label = el('progressLabel');
  const prev = label.querySelector('span')?.textContent || '';
  label.innerHTML = `<span>${prev}</span><span>${success ? '100%' : 'stopped'}</span>`;
}

// ---------- Run ----------
el('runBtn').addEventListener('click', async () => {
  if (!requireTarget()) return;
  const config = collectConfig();
  renderProfileChart(config);
  if (currentEventSource) currentEventSource.close();

  el('logConsole').textContent = '';
  el('resultsSummary').innerHTML = '<p class="hint">Waiting for results…</p>';
  const statusEl = el('runStatus');
  statusEl.textContent = 'Starting…';
  statusEl.className = 'status running';
  el('runProgress').classList.add('hidden');

  const res = await fetch('/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  const data = await res.json();
  if (!res.ok) {
    statusEl.textContent = `Failed to start: ${data.error}`;
    statusEl.className = 'status done-fail';
    return;
  }

  currentRunId = data.runId;
  el('scriptPreview').textContent = `// running ${data.scriptPath}\n\n` + el('scriptPreview').textContent;
  switchTab('log');
  el('runBtn').classList.add('hidden');
  el('stopBtn').classList.remove('hidden');

  statusEl.textContent = 'Running…';
  const { totalSeconds } = buildProfilePoints(config);
  startProgress(totalSeconds);

  const es = new EventSource(`/api/run/${data.runId}/stream`);
  currentEventSource = es;

  es.addEventListener('log', (evt) => {
    el('logConsole').textContent += JSON.parse(evt.data);
    el('logConsole').scrollTop = el('logConsole').scrollHeight;
  });

  es.addEventListener('done', (evt) => {
    const payload = JSON.parse(evt.data);
    es.close();
    currentEventSource = null;
    el('runBtn').classList.remove('hidden');
    el('stopBtn').classList.add('hidden');

    const passed = payload.code === 0;
    finishProgress(passed);
    statusEl.textContent = passed ? 'Finished — thresholds passed' : `Finished — exit code ${payload.code} (check thresholds/errors)`;
    statusEl.className = `status ${passed ? 'done-pass' : 'done-fail'}`;

    renderResults(payload.summary);
    switchTab('results');
  });

  es.onerror = () => {
    stopProgressTimer();
    statusEl.textContent = 'Connection to test runner lost.';
    statusEl.className = 'status done-fail';
    el('runBtn').classList.remove('hidden');
    el('stopBtn').classList.add('hidden');
  };
});

el('stopBtn').addEventListener('click', async () => {
  if (!currentRunId) return;
  await fetch(`/api/run/${currentRunId}/stop`, { method: 'POST' });
});

// ---------- Results rendering ----------
// k6's raw summary uses field names that read backwards for a couple of
// metrics: on http_req_failed, "passes" counts requests that WERE flagged
// failed (not the other way round, unlike on "checks"), and a threshold's
// boolean is true when it was BREACHED (false = passed). Both are easy to
// misread, so special-case them into plain language instead of showing the
// raw k6 field names.
function formatMetricValue(name, m) {
  if (m == null || typeof m !== 'object') return String(m);

  if (name === 'http_req_failed' && (m.passes !== undefined || m.fails !== undefined)) {
    const failedCount = m.passes || 0;
    const total = failedCount + (m.fails || 0);
    const pct = total ? (failedCount / total) * 100 : 0;
    return `${pct.toFixed(2)}% failed (${failedCount} of ${total} requests)`;
  }

  if (name === 'checks' && (m.passes !== undefined || m.fails !== undefined)) {
    const total = (m.passes || 0) + (m.fails || 0);
    const pct = total ? (m.passes / total) * 100 : 0;
    return `${pct.toFixed(1)}% passed (${m.passes || 0} of ${total} checks)`;
  }

  const keys = ['rate', 'value', 'avg', 'p(95)', 'p(90)', 'med', 'min', 'max', 'count', 'passes', 'fails'];
  const present = keys.filter((k) => m[k] !== undefined);
  if (!present.length) return JSON.stringify(m);
  return present.map((k) => `${k}: ${Number.isFinite(m[k]) ? Math.round(m[k] * 100) / 100 : m[k]}`).join(' · ');
}

// Colors a metric card by whether its own result is good, bad, or purely
// informational (no pass/fail meaning, e.g. data_sent).
function metricStatus(name, m) {
  if (m && typeof m === 'object' && m.thresholds) {
    const breached = Object.values(m.thresholds).some(Boolean);
    return breached ? 'bad' : 'good';
  }
  if (name === 'checks' && m && typeof m === 'object') {
    return (m.fails || 0) > 0 ? 'bad' : 'good';
  }
  if (name === 'http_req_failed' && m && typeof m === 'object') {
    return (m.value || 0) > 0 ? 'bad' : 'good';
  }
  return 'neutral';
}

function collectThresholds(summary) {
  const rows = [];
  for (const [metricName, m] of Object.entries(summary.metrics || {})) {
    if (m && m.thresholds) {
      for (const [expr, breached] of Object.entries(m.thresholds)) {
        rows.push({ metric: metricName, expr, breached });
      }
    }
  }
  return rows;
}

// Builds a horizontal bar chart of the http_req_duration percentiles/stats
// (min/avg/med/p90/p95/max), scaled against the largest value present.
function buildDurationChart(metrics) {
  const m = metrics.http_req_duration;
  if (!m || typeof m !== 'object') return null;

  const rows = [
    ['min', 'Min'],
    ['avg', 'Avg'],
    ['med', 'Median'],
    ['p(90)', 'p90'],
    ['p(95)', 'p95'],
    ['max', 'Max'],
  ].filter(([key]) => m[key] !== undefined);
  if (!rows.length) return null;

  const maxVal = Math.max(...rows.map(([key]) => m[key])) || 1;

  const wrap = document.createElement('div');
  wrap.className = 'duration-chart';
  wrap.innerHTML = `<p class="chart-title">Response time (ms)</p>`;
  for (const [key, label] of rows) {
    const val = m[key];
    const pct = Math.max(2, (val / maxVal) * 100);
    const row = document.createElement('div');
    row.className = 'duration-row';
    row.innerHTML = `
      <span class="duration-label">${label}</span>
      <div class="duration-track"><div class="duration-fill" style="width:${pct.toFixed(1)}%"></div></div>
      <span class="duration-val">${formatMsDuration(val)}</span>
    `;
    wrap.appendChild(row);
  }
  return wrap;
}

function buildDonutCard(pct, title, colorVar) {
  if (pct == null || !Number.isFinite(pct)) return null;
  const card = document.createElement('div');
  card.className = 'donut-card';
  card.innerHTML = `
    <div class="donut" style="--pct:${pct.toFixed(1)}%; --donut-color:var(${colorVar});">
      <div class="donut-hole"><div class="donut-value">${pct.toFixed(1)}%</div></div>
    </div>
    <div class="donut-title">${title}</div>
  `;
  return card;
}

// checks and http_req_failed are both pass/fail rates, shown as donuts.
function buildDonutGroup(metrics) {
  const group = document.createElement('div');
  group.className = 'donut-group';

  const checks = metrics.checks;
  if (checks && typeof checks === 'object') {
    const total = (checks.passes || 0) + (checks.fails || 0);
    if (total) {
      const card = buildDonutCard((checks.passes / total) * 100, 'Checks passed', '--accent-2');
      if (card) group.appendChild(card);
    }
  }

  const failed = metrics.http_req_failed;
  if (failed && typeof failed === 'object') {
    // k6 quirk: on http_req_failed, "passes" counts requests flagged as failed.
    const failedCount = failed.passes || 0;
    const total = failedCount + (failed.fails || 0);
    if (total) {
      const card = buildDonutCard(((total - failedCount) / total) * 100, 'Requests OK', '--accent-2');
      if (card) group.appendChild(card);
    }
  }

  return group.children.length ? group : null;
}

function buildResultsCharts(summary) {
  const metrics = summary.metrics || {};
  const durationChart = buildDurationChart(metrics);
  const donutGroup = buildDonutGroup(metrics);
  if (!durationChart && !donutGroup) return null;

  const row = document.createElement('div');
  row.className = 'results-charts';
  if (durationChart) row.appendChild(durationChart);
  if (donutGroup) row.appendChild(donutGroup);
  return row;
}

let lastSummary = null;

function renderResults(summary) {
  const container = el('resultsSummary');
  lastSummary = summary || null;
  el('copyResultsBtn').classList.toggle('hidden', !lastSummary);

  if (!summary || !summary.metrics) {
    container.innerHTML = '<p class="hint">No summary was produced (test may have failed to start, or was stopped before any data was collected). Check the Live log tab.</p>';
    return;
  }

  container.innerHTML = '';

  const thresholds = collectThresholds(summary);
  if (thresholds.length) {
    const anyBreached = thresholds.some((t) => t.breached);
    const banner = document.createElement('div');
    banner.className = `status ${anyBreached ? 'done-fail' : 'done-pass'}`;
    banner.textContent = anyBreached
      ? `${thresholds.filter((t) => t.breached).length} of ${thresholds.length} threshold(s) breached`
      : `All ${thresholds.length} threshold(s) passed`;
    container.appendChild(banner);

    const list = document.createElement('div');
    list.className = 'threshold-list';
    for (const t of thresholds) {
      const row = document.createElement('div');
      row.className = `threshold-row ${t.breached ? 'breached' : 'passed'}`;
      row.innerHTML = `<span>${t.breached ? '✗' : '✓'}</span> <code>${t.metric}: ${t.expr}</code> <span class="threshold-status">${t.breached ? 'Breached' : 'Passed'}</span>`;
      list.appendChild(row);
    }
    container.appendChild(list);
  }

  const charts = buildResultsCharts(summary);
  if (charts) container.appendChild(charts);

  const grid = document.createElement('div');
  grid.className = 'metric-grid';

  const priority = ['http_reqs', 'http_req_duration', 'http_req_failed', 'checks', 'iterations', 'vus_max'];
  const names = Object.keys(summary.metrics).sort((a, b) => {
    const ia = priority.indexOf(a);
    const ib = priority.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });

  for (const name of names) {
    const card = document.createElement('div');
    card.className = `metric-card ${metricStatus(name, summary.metrics[name])}`;
    card.innerHTML = `<div class="m-name">${name}</div><div class="m-value">${formatMetricValue(name, summary.metrics[name])}</div>`;
    grid.appendChild(card);
  }

  container.appendChild(grid);

  const details = document.createElement('details');
  details.className = 'raw-json';
  details.innerHTML = `<summary>Raw summary JSON</summary><pre class="code-block">${JSON.stringify(summary, null, 2)}</pre>`;
  container.appendChild(details);
}

el('copyResultsBtn').addEventListener('click', async () => {
  if (!lastSummary) return;
  const btn = el('copyResultsBtn');
  try {
    await navigator.clipboard.writeText(JSON.stringify(lastSummary, null, 2));
    const original = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = original; }, 1500);
  } catch (err) {
    alert('Could not copy to clipboard: ' + err.message);
  }
});

// ---------- Init ----------
setStages([{ duration: '2m', target: 20 }, { duration: '5m', target: 100 }, { duration: '2m', target: 0 }]);
setRequests([{ method: 'GET', path: '' }]);
loadPresets();
