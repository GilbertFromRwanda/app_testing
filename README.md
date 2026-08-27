# Askfor Test Runner (gil-testing)

A small web app for building and running [k6](https://k6.io/) load tests without hand-writing scripts. Pick a test type, point it at a target URL, define the requests, and run it — you get a live log, a progress bar, and a results summary with charts, right in the browser.

It can also generate a **native Go client-spoofing** variant of the same test, executed by a separate `go-runner` service. The Go program binds every outgoing TCP connection to a rotating local source IP via `net.Dialer.LocalAddr`, so the target sees genuinely distinct source addresses at the network layer — not just an `X-Forwarded-For` header.

Also includes standalone k6 scripts (smoke, load, stress, spike, soak) that were the starting point for this project and still work on their own.

## Two services

The Compose stack (project name `gil-testing`) runs two loosely-coupled services that share **only** the `./generated` directory — there is no HTTP between them.

| Service | What it does |
| --- | --- |
| `node-runner` | The web UI + k6 runner. Generates k6 / Go scripts, runs the k6 ones live, and writes Go ones into `./generated`. Port `4600`. |
| `go-runner` | Go 1.22 toolchain. Watches `./generated` for new `*.go`, runs each once with `go run`, and writes `<id>.log` / `<id>.done` beside it. |

Flow for a Go run: pick **Output → Go — native source IP** in the UI, configure as normal, hit **Send to go-runner**. The Node service writes `./generated/<id>.go` (+ `<id>.config.json`); `go-runner` picks it up within ~2s and runs it. Node tails `./generated/<id>.log` and re-streams it to the UI's **Live log** tab over SSE — same as a k6 run — and the **Stop** button drops a `<id>.stop` marker that `go-runner` kills the run on. The run ends with a `==== SUMMARY ====` block in the log (there's no k6 metrics export, so no charts). `docker compose logs -f go-runner` still works if you'd rather watch it there.

## Features

- **Presets for the five classic k6 test types** — smoke, load, stress, spike, soak — each with sensible default VUs/stages and thresholds ([server/presets.js](server/presets.js)).
- **Visual test builder** — stages or constant VUs, thresholds (p95 latency, max/min fail rate, min/max requests), sleep time, custom headers, and multiple requests (method, path, body, expected status).
- **Auth support** — static header/token, HTTP basic auth, or a login step that runs once per VU and reuses the session (cookie jar and/or a captured bearer token).
- **Client spoofing** — optional per-request random `X-Forwarded-For` / `X-Real-IP` + rotating `User-Agent` and browser headers, to spread load across IP-keyed rate limiters. Present in both the k6 and Go outputs.
- **Native source-IP rotation** — the *Source IPs* field maps to `k6 run --local-ips` for the k6 output and to `net.Dialer.LocalAddr` binding in the Go output (both round-robin the real TCP source IP per connection). Requires the addresses to actually be assigned to the host/container (NIC aliases + host networking or macvlan).
- **Script preview** — generates the actual k6 JS ([server/scriptGenerator.js](server/scriptGenerator.js)) or Go program ([server/goGenerator.js](server/goGenerator.js)) from your config before running.
- **Live run output** (k6) — streams stdout/stderr over SSE with a progress bar; stop a run in progress.
- **Results dashboard** (k6) — parses the k6 summary export into charts and stats.

## Project structure

```text
server/               Express backend (node-runner)
  server.js           API routes, spawns k6, streams logs over SSE, queues Go runs
  scriptGenerator.js  Builds a k6 script from the submitted JSON config
  goGenerator.js      Builds a standalone Go program from the same config
  presets.js          Default config per test type (smoke/load/stress/spike/soak)
public/               Frontend (static HTML/CSS/JS, no build step)
go-runner/            The go-runner service
  Dockerfile          golang:1.22-bookworm, prebuilds the runner + warms the std cache
  go.mod              module stub (the runner itself; generated scripts are stdlib-only)
  runner.go           run one script, or --watch a directory
generated/            Shared volume: k6 scripts + summaries, Go programs + logs (gitignored)
docker-compose.yml    Orchestrates node-runner + go-runner
Dockerfile            node-runner image (Node 20 + k6)
*_testing.js          Standalone example k6 scripts (one per test type)
```

## Requirements

- [Docker](https://docs.docker.com/get-docker/) + Compose — installs Node, k6, and the Go toolchain for you, **or**
- [Node.js](https://nodejs.org/) 18+ and [k6](https://k6.io/docs/get-started/installation/) on `PATH` for the UI alone; [Go](https://go.dev/dl/) 1.21+ on `PATH` to run the Go exports by hand (they're stdlib-only, so no modules to fetch).

## Getting started

### Run with Docker (both services)

```bash
docker compose up --build
```

UI on `http://localhost:4600`. `go-runner` starts watching `./generated` immediately.

> Upgrading from the old single-service setup? Run `docker compose down` first — the service was renamed from `gil-testing` to `node-runner`.

### Run the UI locally

```bash
cd server
npm install
npm start          # http://localhost:4600 (override with PORT)
```

### Run a Go export by hand

```bash
go run ./generated/<id>.go                       # stdlib-only, no go.mod needed
# with overrides:
TARGET_URL=https://host RUN_SECONDS=60 PEAK=50 \
  LOCAL_IPS=192.168.1.101,192.168.1.102 go run ./generated/<id>.go
```

## Native source IPs (`--local-ips` / `LOCAL_IPS`)

Both outputs can bind each outgoing connection to one of a list of local addresses — `k6 --local-ips` for the k6 script, `net.Dialer.LocalAddr` for the Go program. It only does something when those addresses are really assigned:

1. Add them as aliases on the load machine's NIC:
   - **Windows:** `New-NetIPAddress -IPAddress 192.168.1.101 -PrefixLength 24 -InterfaceAlias "Ethernet"` (repeat; Administrator PowerShell). Windows silently ignores a bind to a source IP it doesn't own, so the address *must* be in this list.
   - **Linux:** `ip addr add 10.0.0.11/24 dev eth0` (repeat).
2. Give the container access to them — uncomment `network_mode: host` in [docker-compose.yml](docker-compose.yml) (Linux only) or attach a macvlan network. In a default bridge network the container only has its own single IP and the bind fails.
3. Set the *Source IPs* field in the UI (baked into each generated script), or `K6_LOCAL_IPS` / `LOCAL_IPS` in Compose. Accepts `a,b,c`, `a-b` ranges, or CIDRs.

The Go output adds two conveniences here: `LOCAL_IPS=auto` uses every IPv4 already assigned to the machine's NIC, and any address that *isn't* locally assigned is verified and dropped before the run starts (with a one-line warning) instead of failing every request with `bind: address not valid`. `LOCAL_IPS_NO_VERIFY=1` skips that check for macvlan / `IP_FREEBIND` setups where the OS doesn't report the alias.

If the target reads the client IP from `X-Forwarded-For` (e.g. NestJS/Express behind `trust proxy`), you usually don't need this — the header spoofing checkbox is enough.

## Using the UI

1. Open `http://localhost:4600`, choose a **test type** and **Output** format (k6 or Go).
2. Set the **target base URL** and add one or more **requests**.
3. Optionally configure **auth**, **headers**, **thresholds**, **sleep time**, **client spoofing**, **source IPs**.
4. **Preview script** to inspect the generated code; **Download** to save it.
5. **Run test** (k6) / **Send to go-runner** (Go) — both stream live output to the **Live log** tab. k6 also renders a **Results** dashboard from its summary export; the Go run prints its own `==== SUMMARY ====` block to the log.

## API

- `GET /api/presets` — default configs per test type
- `POST /api/generate` — generate a script (`format: "k6"` default, or `"go"`); no run
- `POST /api/run` — generate + run, returns `{ runId, scriptPath, kind }` (`kind: "go"` for the Go path). k6 runs spawn `k6` here; Go runs are written to `generated/<runId>.go` for `go-runner` and their `generated/<runId>.log` is tailed back into the stream.
- `GET /api/run/:id/stream` — SSE stream of live log output; for k6 the final event carries the parsed summary, for Go it carries just the exit code
- `POST /api/run/:id/stop` — stop a running test (kills `k6`; for Go, drops a `<id>.stop` marker `go-runner` acts on)

## Standalone k6 scripts

The root-level `*_testing.js` files are plain k6 scripts you can run directly:

```bash
k6 run load_testing.js
```

Update the target URLs/payloads inside each before running against your own API.
