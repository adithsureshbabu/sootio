Audit and report on the addon's performance configuration — rate limits, timeouts, concurrency, caching, and clustering.

No arguments required.

## Instructions

Read the following files and produce a structured performance audit report. Do NOT modify any files.

### Step 1 — Rate limiter config

Read `lib/util/rd-rate-limit.js`:
- Extract: `RATE_LIMIT` (req/min), `CONCURRENCY` cap, `MAX_QUEUE_SIZE`, token refill interval, retry logic, request timeout
- Note whether soft/hard concurrency limits exist

Read `lib/util/ad-rate-limit.js`:
- Extract: per-minute limit, per-second limit, `CONCURRENCY` cap, `MAX_QUEUE_SIZE`
- Note the dual-limit token bucket design

### Step 2 — Timeout configuration

Read the first 150 lines of `lib/stream-provider.js` to extract timeout constants:
- `SERVICE_TIMEOUT_MS` (default: 15000) — debrid service overall timeout
- `HTTP_STREAMING_TIMEOUT_MS` (default: 8000) — HTTP provider timeout
- `EARLY_RETURN_TIMEOUT_MS` — early return window
- `DISABLE_EARLY_RETURN` — is early return active?
- `BACKGROUND_REFRESH_BASE_DELAY_MS`, `BACKGROUND_REFRESH_MAX_DELAY_MS`, `BACKGROUND_REFRESH_JITTER_MS`
- `RESOLVE_CACHE_TTL_MS`, `RESOLVE_FAIL_TTL_MS`

Read `lib/util/adaptive-timeout.js`:
- Summarise how adaptive timeouts work (adjusts based on historical p95 latency)
- Note the percentile used, min/max bounds, and warmup period

### Step 3 — Cache TTL configuration

Read `lib/util/cache-store.js` (first 80 lines):
- `SQLITE_CACHE_TTL_DAYS` default
- `HTTP_STREAMS_CACHE_TTL_DAYS` default
- `SCRAPER_CACHE_TTL_MOVIE_MIN`, `SCRAPER_CACHE_TTL_SERIES_MIN` defaults
- `SCRAPER_CACHE_LIMIT` (max in-memory entries)
- `PTT_CACHE_LIMIT` (parse-torrent-title cache)

Read `lib/util/scraper-cache.js`:
- In-memory TTL and max size

### Step 4 — Clustering & process config

Read `cluster.js` (first 60 lines):
- `MAX_WORKERS` default and logic
- `UV_THREADPOOL_SIZE` recommendation
- Crash loop protection thresholds

Read `.env` or `.env.example` and extract:
- `MAX_WORKERS`, `UV_THREADPOOL_SIZE`
- `HTTP_KEEPALIVE_TIMEOUT`, `HTTP_HEADERS_TIMEOUT`
- `HTTP_MAX_CONNECTIONS`, `HTTP_MAX_HEADERS_COUNT`

### Step 5 — Timing metrics

Read `lib/util/timing-metrics-store.js`:
- What metrics are collected
- How they're surfaced (endpoint, log, etc.)

Read `lib/util/scraper-performance.js`:
- How scraper performance is tracked

### Step 6 — Produce audit report

Output a structured report with current values and recommendations:

```
## Performance Audit Report
Date: <today>

### Rate Limiters
| Service | Req/Min | Req/Sec | Concurrency | Queue | Token Refill |
|---------|---------|---------|-------------|-------|--------------|
| Real-Debrid | <value> | - | <value> | <value> | <interval> |
| All-Debrid  | <value> | <value> | <value> | <value> | <interval> |

Recommendations:
- <any tuning suggestions based on typical usage patterns>

### Timeouts
| Setting | Current | Recommended | Notes |
|---------|---------|-------------|-------|
| SERVICE_TIMEOUT_MS | <value> | 15000–20000 | Increase if scrapers frequently timeout |
| HTTP_STREAMING_TIMEOUT_MS | <value> | 10000–15000 | MKVDrama needs up to 90s |
| EARLY_RETURN_TIMEOUT_MS | <value> | 2500 | Lower = faster responses, fewer results |
| RESOLVE_CACHE_TTL_MS | <value> | 300000 (5min) | Avoids redundant resolution |

### Cache Configuration
| Cache | TTL | Max Size | Status |
|-------|-----|----------|--------|
| Scraper results (movies) | <value>min | <value> | <ok/warning> |
| Scraper results (series) | <value>min | <value> | <ok/warning> |
| HTTP streams | <value>days | - | <ok/warning> |
| SQLite/Postgres | <value>days | - | <ok/warning> |
| Resolve cache | <value>ms | - | <ok/warning> |

### Clustering
Workers: <value> (recommended: number of CPU cores)
UV_THREADPOOL_SIZE: <value> (recommended: 16–32 for I/O-heavy workloads)
HTTP Keep-Alive: <value>ms

### Key Bottlenecks Identified
<numbered list of identified bottlenecks with specific recommendations>

### Quick Wins
<list of easy configuration changes that would improve performance, with exact env var names and values>
```

### Common performance issues to flag:

1. **`UV_THREADPOOL_SIZE` too low** — default is 4, but with many concurrent SQLite queries it should be 16–32
2. **Early return disabled** — `DISABLE_EARLY_RETURN=true` means users wait for all sources even when results are available early; consider enabling
3. **Scraper cache TTL too short** — series results < 30 min means frequent re-scraping for binge watchers
4. **No adaptive timeout** — if `adaptive-timeout.js` is not connected, services don't learn from historical latency
5. **Single worker mode** — if `MAX_WORKERS=1`, the addon can't handle concurrent users efficiently
6. **Rate limiter queue too deep** — if `MAX_QUEUE_SIZE` is very large, requests queue silently instead of failing fast
7. **`RESOLVE_CACHE_TTL_MS` too low** — causes repeated resolution of the same URL within a session
