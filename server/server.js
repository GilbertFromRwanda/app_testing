const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const { generateScript } = require('./scriptGenerator');
const { generateGoScript } = require('./goGenerator');
const { presets } = require('./presets');

// Comma-separated local source IPs / ranges / CIDRs passed to `k6 run
// --local-ips`. k6 round-robins outgoing connections across them, so this only
// does anything when the host (or container, via host networking / macvlan)
// actually owns those addresses. A per-run value from the UI takes precedence.
const K6_LOCAL_IPS = process.env.K6_LOCAL_IPS || '';

const app = express();
const PORT = process.env.PORT || 4600;
const GENERATED_DIR = path.join(__dirname, '..', 'generated');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

fs.mkdirSync(GENERATED_DIR, { recursive: true });

app.use(express.json({ limit: '1mb' }));
app.use(express.static(PUBLIC_DIR));

// runId -> { emitter, logs: string[], status, exitCode, summary, proc }
const runs = new Map();

app.get('/api/presets', (req, res) => {
  res.json(presets);
});

app.post('/api/generate', (req, res) => {
  try {
    const body = req.body || {};
    const isGo = body.format === 'go';
    const script = isGo ? generateGoScript(body) : generateScript(body);
    res.json({ script, format: isGo ? 'go' : 'k6' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Native Go runs are executed by the separate go-runner service, not here — the
// two share only ./generated. We write the script (+ its config) there, then
// tail the <id>.log file go-runner streams into and re-broadcast it over the
// same SSE channel the k6 path uses, so the UI shows live output either way.
const GO_POLL_MS = 500;

function startGoRun(runId, relScriptPath) {
  const logPath = path.join(GENERATED_DIR, `${runId}.log`);
  const donePath = path.join(GENERATED_DIR, `${runId}.done`);

  const emitter = new EventEmitter();
  const state = {
    emitter, logs: [], status: 'running', exitCode: null,
    summary: null, proc: null, kind: 'go', timer: null,
  };
  runs.set(runId, state);

  const pushLog = (text) => {
    state.logs.push(text);
    state.emitter.emit('log', text);
  };

  let offset = 0;
  const drain = () => {
    if (!fs.existsSync(logPath)) return;
    const size = fs.statSync(logPath).size;
    if (size < offset) offset = 0; // truncated / rewritten
    if (size <= offset) return;
    const fd = fs.openSync(logPath, 'r');
    try {
      const buf = Buffer.alloc(size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      offset = size;
      pushLog(buf.toString('utf8'));
    } finally {
      fs.closeSync(fd);
    }
  };

  const finish = (code) => {
    if (state.status === 'done') return;
    clearInterval(state.timer);
    state.timer = null;
    state.status = 'done';
    state.exitCode = code;
    state.emitter.emit('done', { code, summary: null, kind: 'go' });
    setTimeout(() => runs.delete(runId), 30 * 60 * 1000);
  };

  pushLog(`[node] wrote ${relScriptPath} — waiting for go-runner to pick it up…\n`);

  let sawLog = false;
  state.timer = setInterval(() => {
    try {
      if (!sawLog && fs.existsSync(logPath)) {
        sawLog = true;
        pushLog(`[node] go-runner started ${runId}.go\n`);
      }
      drain();
      if (fs.existsSync(donePath)) {
        drain();
        const raw = fs.readFileSync(donePath, 'utf8').trim();
        const numeric = /^-?\d+$/.test(raw);
        if (!numeric) pushLog(`\n[go-runner] ${raw}\n`);
        finish(numeric ? Number(raw) : 1);
      }
    } catch (e) {
      // races with go-runner writing these files are expected — retry next tick
    }
  }, GO_POLL_MS);
}

app.post('/api/run', (req, res) => {
  const config = req.body || {};

  if (config.format === 'go') {
    let goScript;
    try {
      goScript = generateGoScript(config);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    const runId = crypto.randomBytes(6).toString('hex');
    const goPath = path.join(GENERATED_DIR, `${runId}.go`);
    fs.writeFileSync(goPath, goScript, 'utf8');
    fs.writeFileSync(
      path.join(GENERATED_DIR, `${runId}.config.json`),
      JSON.stringify(config, null, 2),
      'utf8'
    );
    const rel = path.relative(path.join(__dirname, '..'), goPath);
    startGoRun(runId, rel);
    return res.json({ runId, scriptPath: rel, kind: 'go' });
  }

  let script;
  try {
    script = generateScript(config);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const runId = crypto.randomBytes(6).toString('hex');
  const scriptPath = path.join(GENERATED_DIR, `${runId}.js`);
  const summaryPath = path.join(GENERATED_DIR, `${runId}-summary.json`);
  fs.writeFileSync(scriptPath, script, 'utf8');

  // IPv4/IPv6 addresses, ranges and CIDRs only — this reaches a shell (spawn
  // with shell:true), so keep it to the character set k6 actually accepts.
  const localIps = (config.localIps || K6_LOCAL_IPS || '').trim().replace(/[^0-9a-fA-F.,:/ -]/g, '');
  const k6Args = ['run', '--summary-export', summaryPath];
  if (localIps) k6Args.push(`--local-ips=${localIps}`);
  k6Args.push(scriptPath);

  const emitter = new EventEmitter();
  const state = { emitter, logs: [], status: 'running', exitCode: null, summary: null, proc: null };
  runs.set(runId, state);

  const proc = spawn('k6', k6Args, {
    cwd: GENERATED_DIR,
    shell: true,
  });
  state.proc = proc;

  const pushLog = (chunk) => {
    const text = chunk.toString();
    state.logs.push(text);
    state.emitter.emit('log', text);
  };

  proc.stdout.on('data', pushLog);
  proc.stderr.on('data', pushLog);

  proc.on('close', (code) => {
    state.status = 'done';
    state.exitCode = code;
    if (fs.existsSync(summaryPath)) {
      try {
        state.summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
      } catch (e) {
        state.summary = null;
      }
    }
    state.emitter.emit('done', { code, summary: state.summary });
    // Keep the run's state around for a while so late viewers can still fetch it.
    setTimeout(() => runs.delete(runId), 30 * 60 * 1000);
  });

  res.json({ runId, scriptPath: path.relative(path.join(__dirname, '..'), scriptPath) });
});

app.get('/api/run/:id/stream', (req, res) => {
  const state = runs.get(req.params.id);
  if (!state) {
    res.status(404).end();
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Replay everything captured so far, then continue live.
  for (const line of state.logs) send('log', line);
  if (state.status === 'done') {
    send('done', { code: state.exitCode, summary: state.summary });
    res.end();
    return;
  }

  const onLog = (text) => send('log', text);
  const onDone = (payload) => {
    send('done', payload);
    res.end();
  };
  state.emitter.on('log', onLog);
  state.emitter.on('done', onDone);

  req.on('close', () => {
    state.emitter.off('log', onLog);
    state.emitter.off('done', onDone);
  });
});

app.post('/api/run/:id/stop', (req, res) => {
  const state = runs.get(req.params.id);
  if (!state || state.status !== 'running') {
    return res.status(404).json({ error: 'No running test with that id' });
  }
  // Go runs live in the other container — drop a .stop marker go-runner watches
  // for and kills the run on. The tailer ends when it sees <id>.done.
  if (state.kind === 'go') {
    fs.writeFileSync(path.join(GENERATED_DIR, `${req.params.id}.stop`), '1', 'utf8');
    return res.json({ stopped: true });
  }
  if (!state.proc) return res.status(404).json({ error: 'No running test with that id' });
  state.proc.kill();
  res.json({ stopped: true });
});

app.listen(PORT, () => {
  console.log(`k6 dynamic test UI running at http://localhost:${PORT}`);
});
