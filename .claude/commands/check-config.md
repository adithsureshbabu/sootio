Validate the Sootio addon configuration and report any issues.

No arguments required. Run this whenever streams aren't working or after changing configuration.

## Instructions

Read the following files and produce a structured validation report. Use ✅ for OK, ⚠️ for warnings, ❌ for errors that will break functionality.

### Step 1 — Load configuration

Read `.env` if it exists. If not, read `.env.example` and warn that no `.env` file has been created yet.
Extract all key=value pairs into a working set.

### Step 2 — Core required vars

Check:
- `ADDON_URL` — must be set; ❌ if empty (Stremio can't install the addon)
- `PORT` — should be set; ⚠️ if missing (will default to 7000)
- `DEFAULT_DEBRID_SERVICE` or `DEBRID_SERVICE` — should be set; ⚠️ if missing (no streams will resolve without a debrid service)

### Step 3 — Debrid service API keys

For each debrid service, check if the service is enabled AND if its API key var is set:
- `realdebrid` / `real-debrid` → `RD_API_KEY`
- `alldebrid` / `all-debrid` → `AD_API_KEY`
- `torbox` → `TORBOX_API_KEY`
- `premiumize` → `PREMIUMIZE_API_KEY`
- `offcloud` → `OFFCLOUD_API_KEY`
- `debridlink` / `debrid-link` → `DL_API_KEY`
- `debrider` → `DEBRIDER_API_KEY`

If `DEFAULT_DEBRID_SERVICE=realdebrid` but `RD_API_KEY` is empty → ❌

### Step 4 — Torrent scrapers coverage

Read `lib/scrapers/index.js` to get the full list of all scrapers and their export names.

For each scraper, derive the env var name (e.g. `searchKnaben` → `KNABEN_ENABLED`, `search1337x` → `TORRENT_1337X_ENABLED`, `searchJackett` → `JACKETT_ENABLED`).

Check how many scrapers have `_ENABLED=true`:
- 0 enabled → ❌ no torrents will be found
- 1–3 enabled → ⚠️ limited coverage
- 4+ enabled → ✅

For Jackett specifically: if `JACKETT_ENABLED=true` but `JACKETT_URL` or `JACKETT_API_KEY` is missing → ❌
For Zilean specifically: if `ZILEAN_ENABLED=true` but `ZILEAN_URL` is missing → ❌
For Torrentio: if `TORRENTIO_ENABLED=true` → ✅ (no URL needed, uses public API)

### Step 5 — HTTP streaming providers

Read `lib/http-streams/index.js` to get the list of all HTTP providers.

Check which providers have `_ENABLED=true` in `.env`. Providers are optional so only report ✅ (at least 1 enabled) or ⚠️ (0 enabled = no HTTP streams).

FlareSolverr check: if MKVDrama or MKVCinemas is enabled but `FLARESOLVERR_URL` is not set → ⚠️ (they may work without it but with reduced reliability)

### Step 6 — Cache configuration

Check:
- If `SQLITE_CACHE_ENABLED=true` → check that `CACHE_BACKEND` is not set to `postgres` without `POSTGRES_URL`
- If `CACHE_BACKEND=postgres` but `POSTGRES_URL` (or `DATABASE_URL`) is empty → ❌
- If `DISABLE_CACHE=true` → ⚠️ caching disabled, performance will be poor
- If neither SQLite nor Postgres is configured → ⚠️ no persistent cache

### Step 7 — Connectivity checks

For each of these, if the var is set, attempt a connectivity test using Bash:
- `JACKETT_URL`: `curl -s --max-time 3 -o /dev/null -w "%{http_code}" "${JACKETT_URL}/api/v2.0/indexers?apikey=${JACKETT_API_KEY}"` → 200 = ✅, other = ❌
- `ZILEAN_URL`: `curl -s --max-time 3 -o /dev/null -w "%{http_code}" "${ZILEAN_URL}/v1/ping"` → 200 = ✅
- `FLARESOLVERR_URL`: `curl -s --max-time 3 -o /dev/null -w "%{http_code}" "${FLARESOLVERR_URL}/v1"` → 200 = ✅

If connectivity check fails, mark ❌ with the error.

### Step 8 — Produce report

```
## Config Validation Report

### Core Settings
ADDON_URL: <value or NOT SET> [✅/⚠️/❌]
PORT: <value or default 7000> [✅]
Default Debrid Service: <value or NOT SET> [✅/⚠️/❌]

### Debrid Service
Service: <name>
API Key: <set/NOT SET> [✅/❌]

### Torrent Scrapers
Enabled: <count> of <total>
<list of enabled scrapers>
<list of issues>

### HTTP Streaming Providers
Enabled: <count> of <total>
FlareSolverr: <configured/not configured> [✅/⚠️]

### Cache
Backend: <sqlite/postgres/none>
Status: [✅/⚠️/❌]

### Connectivity
<service>: [✅ OK / ❌ unreachable / ⏭ not configured]

### Issues Found
<numbered list — ❌ errors first, then ⚠️ warnings>

### Quick Fixes
<numbered list of specific env var changes needed>
```
