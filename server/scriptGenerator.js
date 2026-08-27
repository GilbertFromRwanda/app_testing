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
  const reqCountConds = [];
  if (t.minRequests !== undefined && t.minRequests !== null && t.minRequests !== '') {
    reqCountConds.push(`'count>${Number(t.minRequests)}'`);
  }
  if (t.maxRequests !== undefined && t.maxRequests !== null && t.maxRequests !== '') {
    reqCountConds.push(`'count<${Number(t.maxRequests)}'`);
  }
  if (reqCountConds.length) {
    thresholdLines.push(`    http_reqs: [${reqCountConds.join(', ')}]`);
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

  return entries;
}

const REALISTIC_USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1.2 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1.2 Safari/605.1.15',
];

// Emitted once when "distinct client per request" is on. Provides a fresh
// random public-looking IPv4 and a rotating browser User-Agent, so each
// request looks like it came from a different real client — this is what
// spreads traffic across IP-keyed rate limiters (e.g. @nestjs/throttler).
// Only has any effect when the target sits behind a proxy it trusts and
// derives the client IP from these headers; it does not change the real
// TCP source IP.
function buildClientIpPrelude(config) {
  if (!config.spoofClientIp) return null;
  return [
    'function __randomIp() {',
    '  return `${Math.floor(Math.random() * 223) + 1}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 254) + 1}`;',
    '}',
    'const __userAgents = [',
    ...REALISTIC_USER_AGENTS.map((ua) => `  ${jsString(ua)},`),
    '];',
    'function __randomUserAgent() {',
    '  return __userAgents[Math.floor(Math.random() * __userAgents.length)];',
    '}',
  ].join('\n');
}

// The browser-like header block attached to each request (and the login) when
// client spoofing is on. `ipExpr` is the JS expression holding this request's
// IP (a per-request const), reused across both IP headers so they agree.
function realisticClientHeaderLines(indent, ipExpr) {
  return [
    `${indent}'X-Forwarded-For': ${ipExpr},`,
    `${indent}'X-Real-IP': ${ipExpr},`,
    `${indent}'User-Agent': __randomUserAgent(),`,
    `${indent}'Accept-Language': 'en-US,en;q=0.9',`,
    `${indent}'Accept-Encoding': 'gzip, deflate, br',`,
    `${indent}'Cache-Control': 'no-cache',`,
  ];
}

function buildRequest(req, index, targetVar, authHeaderEntries, spoofClientIp) {
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
  if (spoofClientIp) {
    headerLines.push(...realisticClientHeaderLines('    ', `__ip${index}`));
  }

  const optsLines = [];
  if (headerLines.length) {
    optsLines.push('    headers: {');
    optsLines.push(...headerLines);
    optsLines.push('    },');
  }
  const tagEntries = [`name: ${jsString(nameTag)}`];
  if (spoofClientIp) tagEntries.push(`ip: __ip${index}`);
  optsLines.push(`    tags: { ${tagEntries.join(', ')} },`);

  if (spoofClientIp) {
    lines.push(`  const __ip${index} = __randomIp();`);
  }

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
    ? realisticClientHeaderLines('      ', '__loginIp')
    : [];

  const lines = [];
  lines.push('let __sessionReady = false;');
  if (auth.tokenField) lines.push('let __authToken;');
  lines.push('function __login() {');
  if (config.spoofClientIp) lines.push('  const __loginIp = __randomIp();');
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
  const clientIpPrelude = buildClientIpPrelude(config);
  const loginPrelude = buildLoginPrelude(config);

  const parts = [];
  parts.push(`// Generated by k6 Dynamic Test UI — ${new Date().toISOString()}`);
  parts.push(`// Test type: ${config.testType || 'custom'}`);
  parts.push("import http from 'k6/http';");
  parts.push("import { check, sleep } from 'k6';");
  parts.push('');
  parts.push(buildOptions(config));
  parts.push('');
  parts.push(`const BASE_URL = ${jsString(config.target.trim())};`);
  if (clientIpPrelude) {
    parts.push('');
    parts.push(clientIpPrelude);
  }
  if (loginPrelude) {
    parts.push('');
    parts.push(loginPrelude);
  }
  parts.push('');
  parts.push('export default function () {');
  if (loginPrelude) {
    parts.push('  if (!__sessionReady) __login();');
    parts.push('');
  }
  parts.push(
    requests
      .map((r, i) => buildRequest(r, i, 'BASE_URL', authHeaderEntries, config.spoofClientIp))
      .join('\n\n')
  );
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

module.exports = { generateScript, REALISTIC_USER_AGENTS };
