Diagnose why streams are not returning results for a given content ID.

Arguments: $ARGUMENTS
Format: `<imdb-id> [type] [season] [episode]`
Examples:
  `tt1375666 movie`
  `tt0944947 series 1 1`
  `tt0903747` (defaults to movie if type omitted)

## Instructions

Read the following files and produce a structured diagnostic report. Do NOT modify any files.

### Step 1 — Check active configuration

Read `.env` if it exists (preferred), otherwise read `.env.example`. Extract and list:
- Which debrid service is active (`DEBRID_SERVICE`, `DEFAULT_DEBRID_SERVICE`)
- Which debrid API keys are set (just note if set or empty, never print the actual key)
- Which scrapers are enabled (`*_ENABLED=true`)
- Which HTTP streaming providers are enabled
- `FLARESOLVERR_URL` — is FlareSolverr configured?
- `SQLITE_CACHE_ENABLED`, `CACHE_BACKEND`

### Step 2 — Check timeout settings

Read `lib/stream-provider.js` (first 100 lines to find config) and extract:
- `SERVICE_TIMEOUT_MS` (default: 15000)
- `HTTP_STREAMING_TIMEOUT_MS` (default: 8000)
- `EARLY_RETURN_TIMEOUT_MS`
- `DISABLE_EARLY_RETURN` / `EARLY_RETURN_ENABLED`
- `BACKGROUND_REFRESH_BASE_DELAY_MS`

### Step 3 — Check rate limiter config

Read `lib/util/rd-rate-limit.js`:
- `RATE_LIMIT` (requests/min), `CONCURRENCY`, `MAX_QUEUE_SIZE`
- Current queue depth hint (from code, not runtime)

Read `lib/util/ad-rate-limit.js`:
- Dual rate limits (per-minute + per-second), `CONCURRENCY`

### Step 4 — Check FlareSolverr

Read `lib/util/flaresolverr-manager.js` (first 50 lines):
- Max concurrent, queue depth, circuit breaker threshold
- Which providers depend on FlareSolverr (search for references to `flaresolverr` in `lib/http-streams/providers/`)

### Step 5 — Check cache config

Read `lib/util/cache-store.js`:
- Active backend
- TTL settings
- Check if `data/` directory exists: run `ls data/ 2>/dev/null || echo "data/ directory missing"`

### Step 6 — Produce diagnostic report

Output a structured report:

```
## Stream Diagnostic Report
Content: <imdb-id> (<type>)
Date: <today>

### Active Configuration
Debrid Service: <value or NOT SET>
API Key: <set/not set>
Enabled Scrapers: <list>
Enabled HTTP Providers: <list>
FlareSolverr: <configured URL or NOT CONFIGURED>
Cache Backend: <sqlite/postgres/none>

### Timeout Settings
SERVICE_TIMEOUT_MS: <value>ms
HTTP_STREAMING_TIMEOUT_MS: <value>ms
Early Return: <enabled/disabled>

### Rate Limiter Settings
Real-Debrid: <rate>/min, <concurrency> concurrent
All-Debrid: <rate>/min, <rate>/sec, <concurrency> concurrent

### Likely Issues
<numbered list of detected problems>

### Recommended Fixes
<numbered list of specific env var changes to make>
```

### Common issues to check for and report:

1. **No debrid service configured** — `DEBRID_SERVICE` or `DEFAULT_DEBRID_SERVICE` not set → fix: set `DEFAULT_DEBRID_SERVICE=realdebrid` and `RD_API_KEY=...`
2. **No scrapers enabled** — all `*_ENABLED=false` → fix: enable at least Knaben, Jackett, or Torrentio
3. **FlareSolverr missing but required** — MKVDrama/MKVCinemas enabled without `FLARESOLVERR_URL` → fix: set `FLARESOLVERR_URL=http://localhost:8191`
4. **Timeout too low** — `SERVICE_TIMEOUT_MS < 10000` for slow scrapers → fix: increase to 20000
5. **Cache disabled** — `DISABLE_CACHE=true` or `SQLITE_CACHE_ENABLED=false` with no postgres → fix: enable SQLite cache
6. **SQLite data dir missing** — `data/` directory doesn't exist → fix: `mkdir -p data`
7. **All scrapers returning empty** — check if scraper URLs need updating (e.g. site moved domain)
8. **HTTP provider timeouts** — `HTTP_STREAMING_TIMEOUT_MS` too low for providers that need to resolve multiple redirect chains → fix: increase per-provider timeout env vars
