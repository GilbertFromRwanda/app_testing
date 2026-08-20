# Askfor Test Runner (gil-testing)

A small web app for building and running [k6](https://k6.io/) load tests without hand-writing scripts. Pick a test type, point it at a target URL, define the requests, and run it — you get a live log, a progress bar, and a results summary with charts, right in the browser.

Also includes standalone k6 scripts (smoke, load, stress, spike, soak) that were the starting point for this project and still work on their own.

## Features

- **Presets for the five classic k6 test types** — smoke, load, stress, spike, soak — each with sensible default VUs/stages and thresholds ([server/presets.js](server/presets.js)).
- **Visual test builder** — configure stages or constant VUs, thresholds (p95 latency, max fail rate, min requests), sleep time between iterations, custom headers, and multiple requests (method, path, body, expected status).
- **Auth support** — static header/token, HTTP basic auth, or a login step that runs once per VU and reuses the session (cookie jar and/or a captured bearer token).
- **Script preview** — generates the actual k6 JS script from your config before running it, so you can inspect or copy it ([server/scriptGenerator.js](server/scriptGenerator.js)).
- **Live run output** — streams k6's stdout/stderr over SSE with a progress bar, and lets you stop a run in progress.
- **Results dashboard** — parses the k6 summary export into readable charts and stats after each run.
- **Dockerized** — a `Dockerfile` and `docker-compose.yml` bundle k6 itself, so no local k6 install is required.

## Project structure

```text
server/              Express backend
  server.js          API routes, spawns k6, streams logs over SSE
  scriptGenerator.js  Builds a k6 script from the submitted JSON config
  presets.js          Default config per test type (smoke/load/stress/spike/soak)
public/              Frontend (static HTML/CSS/JS, no build step)
generated/           k6 scripts + summary JSON written per run (gitignored)
load_testing.js       Standalone example k6 scripts (one per test type)
smoke_testing.js
soak_testing.js
spike_esting.js
stress_testing.js
```

## Requirements

- [Node.js](https://nodejs.org/) 18+
- [k6](https://k6.io/docs/get-started/installation/) installed and available on your `PATH` (or use Docker, which installs it for you)

## Getting started

### Run locally

```bash
cd server
npm install
npm start
```

The app listens on `http://localhost:4600` by default (override with the `PORT` env var).

### Run with Docker

```bash
docker compose up --build
```

This builds an image with k6 preinstalled and serves the app on `http://localhost:4600`. Generated scripts and summaries are persisted to `./generated` via a bind mount. The Compose project is named `gil-testing` (set via `name:` in [docker-compose.yml](docker-compose.yml)), so container/network names stay stable regardless of the folder you run it from.

## Using the UI

1. Open `http://localhost:4600` and choose a **test type** (smoke, load, stress, spike, soak, or custom).
2. Set the **target base URL** and add one or more **requests** (method, path, body, expected status).
3. Optionally configure **auth**, **custom headers**, **thresholds**, and **sleep time**.
4. Click **Preview script** to see the generated k6 code, or **Run test** to execute it.
5. Watch progress and logs in the *Log* tab, then check the *Results* tab for the summary and charts once the run finishes.

## API

- `GET /api/presets` — returns default configs per test type
- `POST /api/generate` — generates a k6 script from a config (no run)
- `POST /api/run` — generates a script, runs it with k6, returns a `runId`
- `GET /api/run/:id/stream` — SSE stream of live log output and the final summary
- `POST /api/run/:id/stop` — stops a running test

## Standalone k6 scripts

The root-level `*.js` files are plain k6 scripts you can run directly without the UI, e.g.:

```bash
k6 run load_testing.js
```

Update the target URLs/payloads inside each script before running against your own API.
