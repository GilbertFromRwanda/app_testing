// Builds a k6 test script (as text) from a JSON config submitted by the UI.

function jsString(value) {
  return JSON.stringify(String(value));
}

function buildOptions(config) {
  const lines = [];
  lines.push('export const options = {');

  if (config.mode === 'constant') {
    lines.push(`  vus: ${Number(config.vus) || 1},`);
    lines.push(`  duration: ${jsString(config.duration || '1m')},`);
  } else {
    lines.push('  stages: [');
    for (const stage of config.stages || []) {
      lines.push(`    { duration: ${jsString(stage.duration)}, target: ${Number(stage.target) || 0} },`);
    }
    lines.push('  ],');
  }

  const thresholdLines = [];
  const t = config.thresholds || {};
  if (t.p95 !== undefined && t.p95 !== null && t.p95 !== '') {
    thresholdLines.push(`    http_req_duration: ['p(95)<${Number(t.p95)}']`);
  }
  if (t.failRate !== undefined && t.failRate !== null && t.failRate !== '') {
    thresholdLines.push(`    http_req_failed: ['rate<${Number(t.failRate)}']`);
  }
  if (t.minRequests !== undefined && t.minRequests !== null && t.minRequests !== '') {
    thresholdLines.push(`    http_reqs: ['count>${Number(t.minRequests)}']`);
  }
  if (thresholdLines.length) {
    lines.push('  thresholds: {');
    lines.push(thresholdLines.join(',\n'));
    lines.push('  },');
  }

  lines.push('};');
  return lines.join('\n');
}

// Extra headers sent on every request: global custom headers + whatever the
// chosen auth mode contributes (static token, basic auth, or the token
// captured from a login call). Returns an array of `"Key": expr` strings —
// `expr` may reference the __authToken runtime variable for login mode.
function buildAuthHeaderEntries(config) {
  const entries = [];

  for (const h of config.headers || []) {
    if (!h.key || !h.key.trim()) continue;
    entries.push(`    ${jsString(h.key.trim())}: ${jsString(h.value || '')},`);
  }

  const auth = config.auth || { type: 'none' };
  if (auth.type === 'static' && auth.headerValue) {
    const name = (auth.headerName || 'Authorization').trim() || 'Authorization';
    entries.push(`    ${jsString(name)}: ${jsString(auth.headerValue)},`);
  } else if (auth.type === 'basic' && auth.username) {
    const b64 = Buffer.from(`${auth.username}:${auth.password || ''}`).toString('base64');
    entries.push(`    Authorization: ${jsString(`Basic ${b64}`)},`);
  } else if (auth.type === 'login' && auth.tokenField) {
    const name = (auth.headerName || 'Authorization').trim() || 'Authorization';
    entries.push(`    ${jsString(name)}: \`Bearer \${__authToken}\`,`);
  }

  if (config.spoofClientIp) {
    entries.push(`    'X-Forwarded-For': __clientIp,`);
    entries.push(`    'X-Real-IP': __clientIp,`);
  }

  return entries;
}

// Only meaningful against a target that trusts a reverse proxy and reads
// the client IP from these headers (e.g. Express/NestJS with `trust proxy`
// on) — this can't and doesn't spoof the real TCP source IP. One random IP
// is generated per VU (not per request) so it behaves like one simulated
// client keeping a stable identity across its own iterations.
function buildClientIpPrelude(config) {
  if (!config.spoofClientIp) return null;
  return [
    'function __randomIp() {',
    '  return `${Math.floor(Math.random() * 223) + 1}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`;',
    '}',
    'let __clientIp;',
  ].join('\n');
}

function buildRequest(req, index, targetVar, authHeaderEntries) {
  const method = (req.method || 'GET').toUpperCase();
  const varName = `res${index}`;
  const path = req.path || '';
  const nameTag = req.name || `${method} ${path || '(base URL)'}`;
  const suffix = !path ? '' : path.startsWith('/') ? path : `/${path}`;
  const url = `\`\${${targetVar}}${suffix}\``;
  const hasBody = !(method === 'GET' || method === 'DELETE');
  const lines = [];

  const headerLines = [];
  if (hasBody) headerLines.push(`    'Content-Type': 'application/json',`);
  headerLines.push(...authHeaderEntries);

  const optsLines = [];
  if (headerLines.length) {
    optsLines.push('    headers: {');
    optsLines.push(...headerLines);
    optsLines.push('    },');
  }
  optsLines.push(`    tags: { name: ${jsString(nameTag)} },`);

  if (hasBody) {
    const body = req.body && req.body.trim() ? req.body.trim() : '{}';
    lines.push(`  const ${varName} = http.${method.toLowerCase()}(${url}, JSON.stringify(${body}), {`);
    lines.push(...optsLines);
    lines.push('  });');
  } else {
    lines.push(`  const ${varName} = http.${method.toLowerCase()}(${url}, {`);
    lines.push(...optsLines);
    lines.push('  });');
  }

  const expected = req.expectStatus || '200-299';
  const [lo, hi] = String(expected).includes('-')
    ? String(expected).split('-').map(Number)
    : [Number(expected), Number(expected)];

  const okVar = `${varName}Ok`;
  lines.push(`  const ${okVar} = check(${varName}, {`);
  lines.push(`    ${jsString(`${nameTag} status ok`)}: (r) => r.status >= ${lo} && r.status <= ${hi},`);
  lines.push('  });');
  // Failures are aggregated in the k6 summary (counts only), so log the
  // concrete reason here — status code, k6's transport-level error string
  // (timeouts, connection resets, etc. show up as res.error), and a snippet
  // of the response body — to the console, which the UI streams live.
  lines.push(`  if (!${okVar}) {`);
  lines.push(`    let __failMsg${index} = ${jsString(`[FAIL] ${nameTag} -> status `)} + ${varName}.status;`);
  lines.push(`    if (${varName}.error) __failMsg${index} += ' error=' + ${varName}.error;`);
  lines.push(
    `    if (${varName}.body) __failMsg${index} += ' body=' + String(${varName}.body).slice(0, 200);`
  );
  lines.push(`    console.error(__failMsg${index});`);
  lines.push('  }');

  return lines.join('\n');
}

// A login step runs once per VU (not once per iteration): a module-level
// flag/variable in a k6 script keeps its value across iterations of the same
// VU, so checking that flag at the top of the default function is the
// standard way to "log in once, then reuse the session." k6's HTTP client
// keeps a per-VU cookie jar automatically, so a PHP session cookie
// (PHPSESSID) set by this login response is sent on every later request in
// that VU with no extra config — this is what makes it work like a browser
// session. If a JSON token field is also configured, it's captured into
// __authToken and attached via buildAuthHeaderEntries() above for APIs that
// use a bearer token instead of (or alongside) the session cookie.
function buildLoginPrelude(config) {
  const auth = config.auth;
  if (!auth || auth.type !== 'login' || !auth.loginPath) return null;

  const method = (auth.loginMethod || 'POST').toUpperCase();
  const url = `\`\${BASE_URL}${auth.loginPath.startsWith('/') ? '' : '/'}${auth.loginPath}\``;
  const body = auth.loginBody && auth.loginBody.trim() ? auth.loginBody.trim() : '{}';

  const ipHeaderLines = config.spoofClientIp
    ? [`      'X-Forwarded-For': __clientIp,`, `      'X-Real-IP': __clientIp,`]
    : [];

  const lines = [];
  lines.push('let __sessionReady = false;');
  if (auth.tokenField) lines.push('let __authToken;');
  lines.push('function __login() {');
  if (method === 'GET') {
    lines.push(`  const res = http.get(${url}, {`);
    if (ipHeaderLines.length) {
      lines.push('    headers: {');
      lines.push(...ipHeaderLines);
      lines.push('    },');
    }
    lines.push(`    tags: { name: 'login' },`);
    lines.push('  });');
  } else {
    lines.push(`  const res = http.${method.toLowerCase()}(${url}, JSON.stringify(${body}), {`);
    lines.push(`    headers: {`);
    lines.push(`      'Content-Type': 'application/json',`);
    lines.push(...ipHeaderLines);
    lines.push(`    },`);
    lines.push(`    tags: { name: 'login' },`);
    lines.push('  });');
  }
  lines.push(`  check(res, { 'login succeeded': (r) => r.status >= 200 && r.status < 300 });`);
  if (auth.tokenField) lines.push(`  __authToken = res.json(${jsString(auth.tokenField)});`);
  lines.push('  __sessionReady = true;');
  lines.push('}');

  return lines.join('\n');
}

function generateScript(config) {
  if (!config.target || !config.target.trim()) {
    throw new Error('target base URL is required');
  }

  const requests = Array.isArray(config.requests) && config.requests.length
    ? config.requests
    : [{ method: 'GET', path: '', name: 'homepage' }];

  const sleepMin = Number(config.sleepMin ?? 1);
  const sleepMax = Number(config.sleepMax ?? 2);

  const authHeaderEntries = buildAuthHeaderEntries(config);
  const loginPrelude = buildLoginPrelude(config);
  const clientIpPrelude = buildClientIpPrelude(config);

  const parts = [];
  parts.push(`// Generated by k6 Dynamic Test UI — ${new Date().toISOString()}`);
  parts.push(`// Test type: ${config.testType || 'custom'}`);
  parts.push("import http from 'k6/http';");
  parts.push("import { check, sleep } from 'k6';");
  parts.push('');
  parts.push(buildOptions(config));
  parts.push('');
  parts.push(`const BASE_URL = ${jsString(config.target.trim())};`);
  if (loginPrelude) {
    parts.push('');
    parts.push(loginPrelude);
  }
  if (clientIpPrelude) {
    parts.push('');
    parts.push(clientIpPrelude);
  }
  parts.push('');
  parts.push('export default function () {');
  if (clientIpPrelude) {
    parts.push('  if (!__clientIp) __clientIp = __randomIp();');
  }
  if (loginPrelude) {
    parts.push('  if (!__sessionReady) __login();');
    parts.push('');
  }
  parts.push(requests.map((r, i) => buildRequest(r, i, 'BASE_URL', authHeaderEntries)).join('\n\n'));
  parts.push('');
  if (sleepMax > sleepMin) {
    parts.push(`  sleep(Math.random() * ${(sleepMax - sleepMin).toFixed(2)} + ${sleepMin.toFixed(2)});`);
  } else {
    parts.push(`  sleep(${sleepMin.toFixed(2)});`);
  }
  parts.push('}');
  parts.push('');

  return parts.join('\n');
}

module.exports = { generateScript };
