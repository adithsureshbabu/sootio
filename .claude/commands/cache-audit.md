Audit all cache layers — configuration, health, TTLs, and consistency.

No arguments required.

## Instructions

Read the following files and produce a structured cache audit. Do NOT modify any files.

### Step 1 — Identify active cache backend

Read `lib/util/cache-store.js`:
- Which backend is selected (`sqlite`, `postgres`, or none)
- The selector logic (environment variable used)
- Default TTL values per table/type

Check `.env` (preferred) or `.env.example` for:
- `SQLITE_CACHE_ENABLED` — is SQLite cache on?
- `CACHE_BACKEND` — `sqlite` or `postgres`
- `SQLITE_CACHE_TTL_DAYS` — SQLite TTL
- `POSTGRES_URL` / `DATABASE_URL` — is Postgres configured?
- `DISABLE_CACHE` — is caching completely disabled?

### Step 2 — SQLite cache layer

Read `lib/util/sqlite-cache.js`:
- SQLite pragmas: WAL mode, synchronous, cache_size, temp_store
- Tables defined (names and purpose)
- Cleanup interval
- Batch upsert configuration
- Any lock contention mitigations

Check if the data directory exists:
Run: `ls -la data/ 2>/dev/null || echo "WARNING: data/ directory does not exist"`

If `.db` files exist, check their sizes:
Run: `ls -lh data/*.db 2>/dev/null || echo "No .db files found"`

### Step 3 — Hash cache layer

Read `lib/util/hash-cache-store.js`:
- Interface between SQLite and Postgres hash caches
- Batch size for hash lookups

Read `lib/util/sqlite-hash-cache.js`:
- Hash cache specific tables and TTL

### Step 4 — Postgres cache layer (if configured)

Read `lib/util/postgres-cache.js`:
- Tables and schema
- Upsert concurrency (`POSTGRES_UPSERT_CONCURRENCY` default)
- Upsert queue max (`POSTGRES_UPSERT_QUEUE_MAX` default)
- Circuit breaker: consecutive failure threshold, reset interval
- Connection pooling config

Read `lib/util/postgres-client.js`:
- Pool size, idle timeout, connection timeout

### Step 5 — In-memory cache layers

Read `lib/util/scraper-cache.js`:
- Max entries, TTL for movies vs series
- Eviction strategy

Read `lib/util/personal-files-cache.js`:
- TTL for personal cloud file listings
- Max entries

Search for `NodeCache` or `new Map()` usage in `lib/stream-provider.js` (first 100 lines):
- Resolve cache TTL
- Resolve fail cache TTL
- In-flight deduplication map

### Step 6 — Cinemeta metadata cache

Read `lib/util/cinemeta-sql-cache.js`:
- Metadata cache TTL
- Whether it uses SQLite or in-memory

### Step 7 — Produce audit report

```
## Cache Audit Report
Date: <today>

### Active Cache Layers
| Layer | Backend | Status |
|-------|---------|--------|
| Scraper results | In-memory (NodeCache/Map) | <active/disabled> |
| Torrent hashes | SQLite / Postgres | <active/disabled> |
| Search results | SQLite / Postgres | <active/disabled> |
| HTTP streams | SQLite / Postgres | <active/disabled> |
| Resolve cache | In-memory | always active |
| Cinemeta metadata | <backend> | <active/disabled> |
| Personal files | In-memory | <active/disabled> |

### TTL Configuration
| Cache | TTL | Status |
|-------|-----|--------|
| Scraper cache (movies) | <value>min | <ok/short/warning> |
| Scraper cache (series) | <value>min | <ok/short/warning> |
| SQLite/Postgres entries | <value>days | <ok/warning> |
| HTTP streams | <value>days | <ok/warning> |
| Resolve cache | <value>ms | <ok/warning> |
| Resolve fail cache | <value>ms | <ok/warning> |
| Cinemeta metadata | <value> | <ok/warning> |
| Personal files | <value> | <ok/warning> |

### SQLite Health
data/ directory: <exists/missing>
Database files: <list with sizes or "none">
WAL mode: <enabled/disabled>
Cleanup interval: <value>

### Postgres Health (if configured)
Connection: <configured/not configured>
Pool size: <value>
Upsert concurrency: <value>
Circuit breaker: <threshold> failures → open

### Issues Found
<numbered list of problems>

### Recommendations
<numbered list of specific changes with exact env var names and values>
```

### Common cache issues to flag:

1. **`data/` directory missing** — SQLite cache will fail silently; fix: `mkdir -p data`
2. **`SQLITE_CACHE_ENABLED` not set** — defaults to disabled in some configs; fix: `SQLITE_CACHE_ENABLED=true`
3. **`DISABLE_CACHE=true`** — completely disables caching, every request hits all APIs; only acceptable for debugging
4. **Scraper cache TTL too short** — less than 30 minutes means binge watching re-scrapes constantly; recommend 60–120 min for series
5. **SQLite TTL too short** — less than 7 days means debrid cache checks repeat unnecessarily; recommend 30 days
6. **No Postgres with multiple workers** — if `MAX_WORKERS > 1` and `CACHE_BACKEND=sqlite`, each worker has its own SQLite; consider Postgres for shared cache
7. **Postgres upsert queue overflow** — if `POSTGRES_UPSERT_QUEUE_MAX` is too low under load, cache writes are silently dropped
8. **No WAL mode** — without WAL, SQLite reads block during writes; verify pragma is set in `sqlite-cache.js`
9. **Circuit breaker too sensitive** — Postgres circuit breaker opening on 2–3 failures will disable caching under brief network blips; recommend threshold of 5–10
