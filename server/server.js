const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const { generateScript } = require('./scriptGenerator');
const { presets } = require('./presets');

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
    const script = generateScript(req.body || {});
    res.json({ script });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/run', (req, res) => {
  let script;
  try {
    script = generateScript(req.body || {});
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const runId = crypto.randomBytes(6).toString('hex');
  const scriptPath = path.join(GENERATED_DIR, `${runId}.js`);
  const summaryPath = path.join(GENERATED_DIR, `${runId}-summary.json`);
  fs.writeFileSync(scriptPath, script, 'utf8');

  const emitter = new EventEmitter();
  const state = { emitter, logs: [], status: 'running', exitCode: null, summary: null, proc: null };
  runs.set(runId, state);

  const proc = spawn('k6', ['run', '--summary-export', summaryPath, scriptPath], {
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
  if (!state || !state.proc || state.status !== 'running') {
    return res.status(404).json({ error: 'No running test with that id' });
  }
  state.proc.kill();
  res.json({ stopped: true });
});

app.listen(PORT, () => {
  console.log(`k6 dynamic test UI running at http://localhost:${PORT}`);
});
