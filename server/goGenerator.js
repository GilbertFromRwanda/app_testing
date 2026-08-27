// Builds a standalone Go load / client-spoofing program from the same UI config
// the k6 generator consumes. Export + hand-off only — the node service never
// runs these; the go-runner container (or you, by hand) runs `go run <file>.go`.
//
// Where the k6 script only rewrites X-Forwarded-For from a k6 VU, this binds
// every outgoing TCP connection to a rotating local source IP via
// net.Dialer.LocalAddr, so the target sees genuinely different source IPs at
// the network layer — not just a header. Those IPs must be real aliases on the
// load machine's NIC (Windows: New-NetIPAddress; Linux: `ip addr add`) and the
// container must own them (host networking / macvlan) or the bind is ignored.
//
// The generated program is stdlib-only, so `go run file.go` works with no
// go.mod and no external modules.

const { REALISTIC_USER_AGENTS } = require('./scriptGenerator');

// JSON string syntax is a valid Go interpreted-string literal for the text we
// emit (no raw control chars, and Go accepts \n \t \" \\ \uXXXX just like JSON;
// JSON.stringify does not escape "/", which Go would reject).
function goStr(value) {
  return JSON.stringify(String(value));
}

// k6/Go-style durations ("2m", "1h30m", "500ms") -> seconds.
function durationToSeconds(str) {
  if (!str) return 0;
  const re = /([\d.]+)\s*(ms|s|m|h)/g;
  let total = 0;
  let found = false;
  let m;
  while ((m = re.exec(str))) {
    found = true;
    total += parseFloat(m[1]) * { ms: 0.001, s: 1, m: 60, h: 3600 }[m[2]];
  }
  if (!found) {
    const n = parseFloat(str);
    return Number.isFinite(n) ? n : 0;
  }
  return total;
}

function parseExpect(expectStatus) {
  const raw = String(expectStatus || '200-299').trim();
  if (raw.includes('-')) {
    const [lo, hi] = raw.split('-').map(Number);
    return [lo || 0, hi || 0];
  }
  const n = Number(raw);
  return [n, n];
}

function thresholdNum(v) {
  return v === undefined || v === null || v === '' ? -1 : Number(v);
}

// The Go program sends the body field verbatim as the HTTP body, so it must be
// strict JSON. Normalise it and fail loudly on typos rather than emitting a
// program that 400s on every request.
function normalizeJsonBody(raw, label) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  try {
    return JSON.stringify(JSON.parse(s));
  } catch (err) {
    throw new Error(
      `${label} is not valid JSON (${err.message}). Use double-quoted keys, ` +
        'e.g. {"username":"x","password":"y"}'
    );
  }
}

// Custom headers + static/basic auth collapse into a flat header map; login
// mode becomes a struct the program replays once per worker before its loop.
function buildAuth(config) {
  const extraHeaders = {};
  for (const h of config.headers || []) {
    if (h && h.key && h.key.trim()) extraHeaders[h.key.trim()] = h.value || '';
  }

  const auth = config.auth || { type: 'none' };
  let login = null;
  if (auth.type === 'static' && auth.headerValue) {
    const name = (auth.headerName || 'Authorization').trim() || 'Authorization';
    extraHeaders[name] = auth.headerValue;
  } else if (auth.type === 'basic' && auth.username) {
    const b64 = Buffer.from(`${auth.username}:${auth.password || ''}`).toString('base64');
    extraHeaders.Authorization = `Basic ${b64}`;
  } else if (auth.type === 'login' && auth.loginPath) {
    login = {
      method: (auth.loginMethod || 'POST').toUpperCase(),
      path: auth.loginPath.startsWith('/') ? auth.loginPath : `/${auth.loginPath}`,
      body:
        auth.loginBody && auth.loginBody.trim()
          ? normalizeJsonBody(auth.loginBody, 'login body')
          : '',
      tokenField: (auth.tokenField || '').trim(),
      header: (auth.headerName || 'Authorization').trim() || 'Authorization',
    };
  }
  return { extraHeaders, login };
}

function goHeaderMap(map) {
  const entries = Object.entries(map);
  if (!entries.length) return 'map[string]string{}';
  return (
    'map[string]string{\n' +
    entries.map(([k, v]) => `\t${goStr(k)}: ${goStr(v)},`).join('\n') +
    '\n}'
  );
}

function generateGoScript(config) {
  if (!config.target || !config.target.trim()) {
    throw new Error('target base URL is required');
  }
  const target = config.target.trim();

  const requests = (
    Array.isArray(config.requests) && config.requests.length
      ? config.requests
      : [{ method: 'GET', path: '', name: 'homepage' }]
  ).map((r) => {
    const method = (r.method || 'GET').toUpperCase();
    const path = r.path ? (r.path.startsWith('/') ? r.path : `/${r.path}`) : '';
    const hasBody = !(method === 'GET' || method === 'DELETE');
    const body = hasBody
      ? normalizeJsonBody(r.body, `request body for ${method} ${path || '(base URL)'}`)
      : '';
    const [lo, hi] = parseExpect(r.expectStatus);
    const name = r.name || `${method} ${path || '(base URL)'}`;
    return { method, path, body, lo, hi, name };
  });

  // Traffic profile -> a linearly-interpolated stage list the supervisor tracks.
  let startVUs;
  let stages;
  let runSeconds;
  if (config.mode === 'constant') {
    const vus = Number(config.vus) || 1;
    runSeconds = Math.max(1, Math.round(durationToSeconds(config.duration || '1m')));
    startVUs = vus;
    stages = [{ dur: runSeconds, target: vus }];
  } else {
    const raw = (config.stages || []).map((s) => ({
      dur: Math.max(0, durationToSeconds(s.duration)),
      target: Number(s.target) || 0,
    }));
    runSeconds = Math.max(1, Math.round(raw.reduce((a, s) => a + s.dur, 0)));
    startVUs = 0;
    stages = raw.length ? raw : [{ dur: runSeconds, target: 1 }];
  }
  const peak = Math.max(1, startVUs, ...stages.map((s) => s.target));

  const spoof = !!config.spoofClientIp;
  const localIps = (config.localIps || '').trim();
  const { extraHeaders, login } = buildAuth(config);
  const t = config.thresholds || {};

  const sleepMin = Number(config.sleepMin ?? 1);
  const sleepMax = Number(config.sleepMax ?? 2);

  const reqLines = requests
    .map(
      (r) =>
        `\t{Method: ${goStr(r.method)}, Path: ${goStr(r.path)}, Body: ${goStr(r.body)}, ` +
        `Name: ${goStr(r.name)}, Lo: ${r.lo}, Hi: ${r.hi}},`
    )
    .join('\n');

  const stageLines = stages
    .map((s) => `\t{Dur: ${s.dur}, Target: ${s.target}},`)
    .join('\n');

  const uaLines = REALISTIC_USER_AGENTS.map((ua) => `\t${goStr(ua)},`).join('\n');

  const loginLiteral = login
    ? `loginSpec{Enabled: true, Method: ${goStr(login.method)}, Path: ${goStr(login.path)}, ` +
      `Body: ${goStr(login.body)}, TokenField: ${goStr(login.tokenField)}, Header: ${goStr(login.header)}}`
    : 'loginSpec{}';

  return `// Generated by Askfor Test Runner — ${new Date().toISOString()}
// Test type: ${config.testType || 'custom'}
//
// Native Go load / client-spoofing test. Each virtual user is a goroutine with
// its own cookie jar; a background supervisor ramps the active count to track
// the configured stages. Every outgoing TCP connection is bound, round-robin,
// to one of LOCAL_IPS via net.Dialer.LocalAddr, so the target sees real
// distinct source IPs at the network layer. When client spoofing is on,
// X-Forwarded-For / X-Real-IP / User-Agent are also rewritten per request for
// targets that trust those headers instead.
//
// LOCAL_IPS must be addresses this host actually owns (NIC aliases) and the
// container must see them (host networking / macvlan). Empty => send from the
// default IP, same as any normal client.
//
// RUN:
//   go run <this-file>.go
// Overrides (no regeneration needed):
//   TARGET_URL=https://host  RUN_SECONDS=60  PEAK=50  MAX_VUS=5000 \\
//   LOCAL_IPS=192.168.1.101,192.168.1.102  go run <this-file>.go
//
// LOCAL_IPS also accepts the literal "auto" (use every IPv4 currently assigned
// to a local non-loopback interface). By default each address is verified to be
// locally assigned before it's used — a bind to anything else fails on every
// connection. Set LOCAL_IPS_NO_VERIFY=1 to skip that check (macvlan /
// IP_FREEBIND setups where the OS won't report the alias).

package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"math/rand"
	"net"
	"net/http"
	"net/http/cookiejar"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// ---- config baked in from the UI (env vars win at run time) ----

var (
	baseURL     = envStr("TARGET_URL", ${goStr(target)})
	runSeconds  = envInt("RUN_SECONDS", ${runSeconds})
	peak        = envInt("PEAK", ${peak})
	maxVUs      = envInt("MAX_VUS", 5000)
	localIPsRaw = envStr("LOCAL_IPS", ${goStr(localIps)})
	spoofClient = ${spoof ? 'true' : 'false'}
)

var thinkMin = ${sleepMin.toFixed(3)}
var thinkMax = ${sleepMax.toFixed(3)}

// thresholds: -1 == unset
var (
	thP95MS      float64 = ${thresholdNum(t.p95)}
	thFailRate   float64 = ${thresholdNum(t.failRate)}
	thMinRequest float64 = ${thresholdNum(t.minRequests)}
	thMaxRequest float64 = ${thresholdNum(t.maxRequests)}
)

var userAgents = []string{
${uaLines}
}

// custom headers + static / basic auth, sent on every request (and the login)
var extraHeaders = ${goHeaderMap(extraHeaders)}

type reqSpec struct {
	Method, Path, Body, Name string
	Lo, Hi                   int
}

var requests = []reqSpec{
${reqLines}
}

type stage struct {
	Dur    float64
	Target int
}

var startVUs = ${startVUs}
var stageList = []stage{
${stageLines}
}

// login replayed once per worker; zero value => disabled
type loginSpec struct {
	Enabled                    bool
	Method, Path, Body         string
	TokenField, Header         string
}

var login = ${loginLiteral}

// ---- helpers ----

func envStr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func envInt(k string, def int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func incIP(ip net.IP) {
	for j := len(ip) - 1; j >= 0; j-- {
		ip[j]++
		if ip[j] > 0 {
			break
		}
	}
}

// Accepts "a,b,c", "a-b" last-value ranges, and CIDRs (expanded, capped).
func parseLocalIPs(raw string) []net.IP {
	var out []net.IP
	for _, tok := range strings.Split(raw, ",") {
		tok = strings.TrimSpace(tok)
		if tok == "" {
			continue
		}
		if strings.Contains(tok, "/") {
			ip, ipnet, err := net.ParseCIDR(tok)
			if err != nil {
				fmt.Printf("[WARN] bad CIDR %q: %v\\n", tok, err)
				continue
			}
			cur := ip.Mask(ipnet.Mask)
			for ipnet.Contains(cur) {
				dup := make(net.IP, len(cur))
				copy(dup, cur)
				out = append(out, dup)
				if len(out) > 4096 {
					break
				}
				incIP(cur)
			}
			continue
		}
		if i := strings.Index(tok, "-"); i > 0 {
			lo := net.ParseIP(strings.TrimSpace(tok[:i])).To4()
			hi := net.ParseIP(strings.TrimSpace(tok[i+1:])).To4()
			if lo != nil && hi != nil {
				cur := make(net.IP, 4)
				copy(cur, lo)
				for {
					dup := make(net.IP, 4)
					copy(dup, cur)
					out = append(out, dup)
					if cur.Equal(hi) || len(out) > 4096 {
						break
					}
					incIP(cur)
				}
				continue
			}
		}
		if ip := net.ParseIP(tok); ip != nil {
			out = append(out, ip)
		} else {
			fmt.Printf("[WARN] bad source IP %q\\n", tok)
		}
	}
	return out
}

// IPv4 addresses currently assigned to a local, non-loopback interface.
func localInterfaceIPv4s() map[string]bool {
	set := map[string]bool{}
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return set
	}
	for _, a := range addrs {
		if ipnet, ok := a.(*net.IPNet); ok {
			if v4 := ipnet.IP.To4(); v4 != nil && !ipnet.IP.IsLoopback() {
				set[v4.String()] = true
			}
		}
	}
	return set
}

// resolveSourceIPs turns LOCAL_IPS into the addresses we'll actually bind to.
// "auto" => every IPv4 on a local non-loopback interface. Otherwise the parsed
// list is filtered to addresses the OS reports as locally assigned, because a
// bind to anything else fails on every connection (Windows especially). Set
// LOCAL_IPS_NO_VERIFY=1 to bind the list as-is.
func resolveSourceIPs(raw string) (usable []net.IP, skipped []string) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	local := localInterfaceIPv4s()
	if strings.EqualFold(raw, "auto") {
		for s := range local {
			ip := net.ParseIP(s)
			if ip.IsLinkLocalUnicast() { // 169.254/16 — never a deliberate source
				continue
			}
			usable = append(usable, ip)
		}
		sort.Slice(usable, func(i, j int) bool { return usable[i].String() < usable[j].String() })
		return usable, nil
	}
	noVerify := os.Getenv("LOCAL_IPS_NO_VERIFY") != ""
	for _, ip := range parseLocalIPs(raw) {
		if noVerify || local[ip.String()] {
			usable = append(usable, ip)
		} else {
			skipped = append(skipped, ip.String())
		}
	}
	return usable, skipped
}

func ipStrings(ips []net.IP) []string {
	out := make([]string, len(ips))
	for i, ip := range ips {
		out[i] = ip.String()
	}
	return out
}

// Returns a DialContext that rotates the local source address per connection.
func buildDialContext(ips []net.IP) func(context.Context, string, string) (net.Conn, error) {
	base := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	if len(ips) == 0 {
		return base.DialContext
	}
	var n uint64
	return func(ctx context.Context, network, addr string) (net.Conn, error) {
		ip := ips[atomic.AddUint64(&n, 1)%uint64(len(ips))]
		d := &net.Dialer{
			Timeout:   base.Timeout,
			KeepAlive: base.KeepAlive,
			LocalAddr: &net.TCPAddr{IP: ip},
		}
		conn, err := d.DialContext(ctx, network, addr)
		if err != nil {
			return nil, fmt.Errorf("dial from %s: %w", ip, err)
		}
		return conn, nil
	}
}

func randomIP() string {
	return fmt.Sprintf("%d.%d.%d.%d", rand.Intn(223)+1, rand.Intn(256), rand.Intn(256), rand.Intn(254)+1)
}

// When client spoofing is on, stamp a fresh random client identity onto the
// request. Applied to every request AND the login call — a login-first auth
// flow that hits an IP-keyed limiter needs the login itself to look distinct.
func applySpoofHeaders(h http.Header) {
	if !spoofClient {
		return
	}
	ip := randomIP()
	h.Set("X-Forwarded-For", ip)
	h.Set("X-Real-IP", ip)
	h.Set("User-Agent", userAgents[rand.Intn(len(userAgents))])
	h.Set("Accept-Language", "en-US,en;q=0.9")
	h.Set("Cache-Control", "no-cache")
}

func thinkDuration() time.Duration {
	lo, hi := thinkMin, thinkMax
	if hi < lo {
		hi = lo
	}
	if hi <= 0 {
		return 0
	}
	return time.Duration((lo + rand.Float64()*(hi-lo)) * float64(time.Second))
}

func percentile(vals []float64, p float64) float64 {
	if len(vals) == 0 {
		return 0
	}
	s := append([]float64(nil), vals...)
	sort.Float64s(s)
	k := (float64(len(s)) - 1) * (p / 100)
	lo := int(k)
	hi := lo + 1
	if hi >= len(s) {
		hi = len(s) - 1
	}
	return s[lo] + (s[hi]-s[lo])*(k-float64(lo))
}

// piecewise-linear VU target at t seconds, starting from startVUs
func desiredVUs(elapsed float64) int {
	prevT, prev := 0.0, float64(startVUs)
	for _, s := range stageList {
		end := prevT + s.Dur
		if s.Dur <= 0 {
			return s.Target
		}
		if elapsed <= end {
			frac := (elapsed - prevT) / s.Dur
			if frac < 0 {
				frac = 0
			}
			return int(prev + (float64(s.Target)-prev)*frac + 0.5)
		}
		prevT, prev = end, float64(s.Target)
	}
	return int(prev + 0.5)
}

// ---- stats ----

type stats struct {
	mu     sync.Mutex
	ms     []float64
	count  int64
	failed int64
}

func (s *stats) record(ms float64, ok bool) {
	atomic.AddInt64(&s.count, 1)
	if !ok {
		atomic.AddInt64(&s.failed, 1)
	}
	s.mu.Lock()
	s.ms = append(s.ms, ms)
	s.mu.Unlock()
}

// ---- request / login ----

func doLogin(c *http.Client) string {
	if !login.Enabled {
		return ""
	}
	var body io.Reader
	if login.Body != "" {
		body = bytes.NewReader([]byte(login.Body))
	}
	req, err := http.NewRequest(login.Method, baseURL+login.Path, body)
	if err != nil {
		fmt.Printf("[WARN] login build error: %v\\n", err)
		return ""
	}
	if login.Body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range extraHeaders {
		req.Header.Set(k, v)
	}
	applySpoofHeaders(req.Header)
	resp, err := c.Do(req)
	if err != nil {
		fmt.Printf("[WARN] login request error: %v\\n", err)
		return ""
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		fmt.Printf("[WARN] login -> status %d\\n", resp.StatusCode)
		return ""
	}
	// The cookie jar already holds any session cookie. Only dig out a bearer
	// token if one was configured.
	if login.TokenField == "" {
		return ""
	}
	var parsed map[string]interface{}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		fmt.Printf("[WARN] login response not JSON: %v\\n", err)
		return ""
	}
	if v, ok := parsed[login.TokenField].(string); ok {
		return v
	}
	fmt.Printf("[WARN] token field %q not found in login response\\n", login.TokenField)
	return ""
}

func doRequest(c *http.Client, spec reqSpec, token string, st *stats) {
	var body io.Reader
	if spec.Body != "" {
		body = bytes.NewReader([]byte(spec.Body))
	}
	req, err := http.NewRequest(spec.Method, baseURL+spec.Path, body)
	if err != nil {
		fmt.Printf("[FAIL] %s -> build error: %v\\n", spec.Name, err)
		st.record(0, false)
		return
	}
	if spec.Body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range extraHeaders {
		req.Header.Set(k, v)
	}
	if token != "" {
		req.Header.Set(login.Header, "Bearer "+token)
	}
	applySpoofHeaders(req.Header)

	t0 := time.Now()
	resp, err := c.Do(req)
	elapsed := float64(time.Since(t0).Microseconds()) / 1000.0
	if err != nil {
		fmt.Printf("[FAIL] %s -> transport error: %v\\n", spec.Name, err)
		st.record(elapsed, false)
		return
	}
	snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 200))
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()

	ok := resp.StatusCode >= spec.Lo && resp.StatusCode <= spec.Hi
	if !ok {
		fmt.Printf("[FAIL] %s -> status %d %s\\n", spec.Name, resp.StatusCode, strings.TrimSpace(string(snippet)))
	}
	st.record(elapsed, ok)
}

func worker(tr *http.Transport, st *stats, deadline time.Time, stop <-chan struct{}) {
	jar, _ := cookiejar.New(nil)
	client := &http.Client{
		Transport: tr,
		Jar:       jar,
		Timeout:   30 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 10 {
				return http.ErrUseLastResponse
			}
			return nil
		},
	}

	token := doLogin(client)

	for {
		select {
		case <-stop:
			return
		default:
		}
		if time.Now().After(deadline) {
			return
		}
		for _, spec := range requests {
			select {
			case <-stop:
				return
			default:
			}
			doRequest(client, spec, token, st)
		}
		time.Sleep(thinkDuration())
	}
}

func report(st *stats) {
	count := atomic.LoadInt64(&st.count)
	failed := atomic.LoadInt64(&st.failed)
	rate := 0.0
	if count > 0 {
		rate = float64(failed) / float64(count)
	}

	st.mu.Lock()
	p95 := percentile(st.ms, 95)
	sum := 0.0
	for _, v := range st.ms {
		sum += v
	}
	avg := 0.0
	if len(st.ms) > 0 {
		avg = sum / float64(len(st.ms))
	}
	st.mu.Unlock()

	fmt.Println()
	fmt.Println("==== SUMMARY ====")
	fmt.Printf("requests : %d\\n", count)
	fmt.Printf("failed   : %d (%.2f%%)\\n", failed, rate*100)
	fmt.Printf("avg ms   : %.0f\\n", avg)
	fmt.Printf("p95 ms   : %.0f\\n", p95)

	var breaches []string
	if thP95MS >= 0 && p95 >= thP95MS {
		breaches = append(breaches, fmt.Sprintf("p95 %.0fms >= %.0fms", p95, thP95MS))
	}
	if thFailRate >= 0 && rate >= thFailRate {
		breaches = append(breaches, fmt.Sprintf("fail rate %.3f >= %.3f", rate, thFailRate))
	}
	if thMinRequest >= 0 && float64(count) < thMinRequest {
		breaches = append(breaches, fmt.Sprintf("requests %d < %.0f", count, thMinRequest))
	}
	if thMaxRequest >= 0 && float64(count) > thMaxRequest {
		breaches = append(breaches, fmt.Sprintf("requests %d > %.0f", count, thMaxRequest))
	}
	if len(breaches) > 0 {
		fmt.Println("THRESHOLDS BREACHED:")
		for _, b := range breaches {
			fmt.Println("  - " + b)
		}
		os.Exit(1)
	}
	fmt.Println("all thresholds passed")
}

func main() {
	srcIPs, skipped := resolveSourceIPs(localIPsRaw)

	transport := &http.Transport{
		DialContext:         buildDialContext(srcIPs),
		TLSClientConfig:     &tls.Config{InsecureSkipVerify: true},
		MaxIdleConns:        0,
		MaxIdleConnsPerHost: 10000,
		ForceAttemptHTTP2:   true,
		// With a source-IP pool, keep-alive would pin traffic to a handful of
		// long-lived connections and only rotate the bound IP per dial. Force a
		// fresh dial per request so the source IP actually cycles the pool.
		DisableKeepAlives: len(srcIPs) > 0,
	}

	fmt.Printf("Go load test -> %s for %ds (peak ~%d VUs)\\n", baseURL, runSeconds, peak)
	if strings.TrimSpace(localIPsRaw) != "" {
		fmt.Printf("source IPs   : %d usable %v\\n", len(srcIPs), ipStrings(srcIPs))
		if len(skipped) > 0 {
			fmt.Printf("[WARN] %d configured source IP(s) not assigned to a local interface, skipped: %v\\n",
				len(skipped), skipped)
			fmt.Println("       alias them first (Windows: New-NetIPAddress; Linux: ip addr add), or set LOCAL_IPS_NO_VERIFY=1")
		}
		if len(srcIPs) == 0 {
			fmt.Println("[WARN] no usable source IPs — sending from the default source address")
		}
	}
	if spoofClient {
		fmt.Println("client spoofing ON: rotating X-Forwarded-For / X-Real-IP / User-Agent per request")
	}

	st := &stats{}
	deadline := time.Now().Add(time.Duration(runSeconds) * time.Second)

	var wg sync.WaitGroup
	var wmu sync.Mutex
	var workers []chan struct{}

	scale := func(target int) {
		if target > maxVUs {
			target = maxVUs
		}
		if target < 0 {
			target = 0
		}
		wmu.Lock()
		defer wmu.Unlock()
		for len(workers) < target {
			stop := make(chan struct{})
			workers = append(workers, stop)
			wg.Add(1)
			go func(stop <-chan struct{}) {
				defer wg.Done()
				worker(transport, st, deadline, stop)
			}(stop)
		}
		for len(workers) > target {
			last := workers[len(workers)-1]
			workers = workers[:len(workers)-1]
			close(last)
		}
	}

	start := time.Now()
	scale(desiredVUs(0))

	ticker := time.NewTicker(time.Second)
	go func() {
		for range ticker.C {
			el := time.Since(start).Seconds()
			if el >= float64(runSeconds) {
				scale(0)
				return
			}
			scale(desiredVUs(el))
		}
	}()

	time.Sleep(time.Until(deadline))
	ticker.Stop()
	scale(0)
	wg.Wait()

	report(st)
}
`;
}

module.exports = { generateGoScript };
