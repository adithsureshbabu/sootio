Deployment health check — verify system resources, worker config, cache backend, and external service connectivity.

No arguments required. Run this after deployment or when the addon seems slow/unresponsive.

## Instructions

Read config files and run system commands to produce a comprehensive health report.

### Step 1 — Read cluster and server config

Read `cluster.js` (first 80 lines). Extract:
- Worker count calculation logic (CPU-based, with min/max bounds)
- Default `MAX_WORKERS` logic
- Crash loop protection thresholds (restart limits, time windows)
- Memory limit thresholds for automatic worker restart

Read `lib/util/memory-monitor.js`. Extract:
- Memory warning threshold (% of heap used)
- Memory critical threshold (restart trigger)
- Monitoring interval

### Step 2 — Read current env config

Read `.env` (preferred) or `.env.example`. Extract:
- `MAX_WORKERS`
- `UV_THREADPOOL_SIZE`
- `HTTP_KEEPALIVE_TIMEOUT`
- `HTTP_HEADERS_TIMEOUT`
- `HTTP_MAX_CONNECTIONS`
- `SQLITE_CACHE_ENABLED`, `CACHE_BACKEND`, `POSTGRES_URL`
- `PORT`
- `JACKETT_URL`, `JACKETT_API_KEY`
- `ZILEAN_URL`
- `FLARESOLVERR_URL`

### Step 3 — Run system checks

Run these Bash commands and collect output:

```bash
# Node version
node --version

# CPU count
nproc

# Available RAM (in MB)
free -m | awk 'NR==2{printf "Total: %sMB, Available: %sMB", $2, $7}'

# SQLite files
ls -lh data/*.db 2>/dev/null || echo "No SQLite files found"

# Disk space for data directory
df -h . | awk 'NR==2{print "Disk: " $4 " available of " $2}'

# Check if data/ directory exists
[ -d data ] && echo "data/ exists" || echo "WARNING: data/ directory missing"

# Process check (is addon running?)
pgrep -f "node.*server.js\|node.*cluster.js" && echo "Addon process: running" || echo "Addon process: not running"
```

### Step 4 — Check external service reachability

For each configured service URL, test connectivity:

**Jackett** (if `JACKETT_URL` is set):
```bash
curl -s --max-time 3 -o /dev/null -w "%{http_code}" "${JACKETT_URL}/api/v2.0/indexers?apikey=${JACKETT_API_KEY}"
```
200 → ✅ | timeout/error → ❌

**Zilean** (if `ZILEAN_URL` is set):
```bash
curl -s --max-time 3 -o /dev/null -w "%{http_code}" "${ZILEAN_URL}/v1/ping"
```

**FlareSolverr** (if `FLARESOLVERR_URL` is set):
```bash
curl -s --max-time 5 -o /dev/null -w "%{http_code}" "${FLARESOLVERR_URL}/v1"
```

**Postgres** (if `CACHE_BACKEND=postgres` and `POSTGRES_URL` is set):
```bash
node --eval "import pg from 'pg'; const c = new pg.Client(process.env.POSTGRES_URL); c.connect().then(() => { console.log('Postgres: connected'); c.end(); }).catch(e => console.log('Postgres: ' + e.message));" --input-type=module 2>/dev/null || echo "Postgres: connection failed"
```

### Step 5 — Produce health report

```
## Health Check Report
<timestamp>

### System
Node.js: <version> [✅ ≥20 / ❌ <20]
CPUs: <nproc>
RAM: <total>MB total, <available>MB available
Disk: <available> free

### Workers & Clustering
MAX_WORKERS: <configured value or "auto"> → <actual workers = min(MAX_WORKERS, nproc*2)>
UV_THREADPOOL_SIZE: <value or NOT SET> [✅ ≥16 / ⚠️ <16 (default 4)]
HTTP Keep-Alive: <value>ms
Max Connections: <value or default>

Recommendation: [if nproc ≥ 4 but MAX_WORKERS ≤ 1 → suggest increasing]

### Cache Backend
Backend: <sqlite / postgres / none>
SQLite cache: <enabled/disabled>
SQLite files: <list with sizes or "none">
data/ directory: <exists / MISSING>
Disk space: <available>

[If postgres]: Postgres URL: <set/not set>
[If postgres]: Connection: <✅ OK / ❌ failed>

### External Services
Jackett: [✅ OK (200) / ❌ unreachable / ⏭ not configured]
Zilean: [✅ OK / ❌ unreachable / ⏭ not configured]
FlareSolverr: [✅ OK / ❌ unreachable / ⏭ not configured]

### Addon Process
Status: [running / not running]
Port: <PORT>

### Issues Found ❌
<numbered list of critical issues>

### Warnings ⚠️
<numbered list of warnings>

### Recommendations
<numbered list of specific env var or system changes>
```

### Common issues to flag:

1. **`data/` missing** → `mkdir -p data` then restart
2. **Node.js < 20** → upgrade Node.js (project requires ^20.x)
3. **`UV_THREADPOOL_SIZE` not set** → add `UV_THREADPOOL_SIZE=16` (default 4 causes SQLite lock contention under load)
4. **`MAX_WORKERS=1` with ≥4 CPUs** → increase to `MAX_WORKERS=<nproc>` for better concurrency
5. **FlareSolverr unreachable** but MKVDrama/MKVCinemas enabled → providers will fail silently; fix FlareSolverr or disable those providers
6. **Jackett unreachable** but `JACKETT_ENABLED=true` → scraper will timeout on every request; fix or disable
7. **Low disk space** (<500MB) for SQLite cache → cache writes will fail; free up disk space
8. **Postgres connection failed** with `CACHE_BACKEND=postgres` → addon falls back to no cache; fix Postgres connection string
