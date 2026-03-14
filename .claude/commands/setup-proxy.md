Audit and guide proxy configuration for debrid services and scrapers.

Arguments: $ARGUMENTS (optional)
Format: `[service]` — e.g. `realdebrid`, `btdig`, or omit for all services
Examples:
  `/setup-proxy` — show all proxy config
  `/setup-proxy realdebrid` — focus on Real-Debrid proxy
  `/setup-proxy btdig` — focus on BTDigg proxy

## Instructions

Do NOT modify any files. Produce a proxy configuration audit with validation and guidance.

### Step 1 — Read proxy implementation files

Read `lib/util/debrid-proxy.js` in full. Extract:
- The list of service names that support per-service proxies (the service map / switch cases)
- The proxy URL format expected for each service
- How `DEBRID_PER_SERVICE_PROXIES` is parsed (syntax: `servicename:proxyurl,servicename2:proxyurl2`)
- How `DEBRID_HTTP_PROXY` is used as a global fallback
- How scrapers get their proxy config (`getScraperAxiosConfig`)

Read `lib/util/proxy-manager.js` in full. Extract:
- Which scrapers use free proxy rotation (BTDigg, others)
- How `BTDIG_USE_PROXIES` / `BTDIG_PROXY_URL` work
- How `MAGNETDL_PROXY` works
- The free proxy fetching logic (ProxyScrape URL)

### Step 2 — Read current proxy config

Read `.env` (preferred) or `.env.example`. Extract:
- `DEBRID_HTTP_PROXY` — global proxy for all debrid services
- `DEBRID_PER_SERVICE_PROXIES` — per-service proxy overrides
- `DEBRID_PROXY_SERVICES` — which services use the proxy
- `BTDIG_USE_PROXIES` — BTDigg free proxy rotation
- `BTDIG_PROXY_URL` — BTDigg specific proxy
- `MAGNETDL_PROXY` — MagnetDL proxy
- `MKVDRAMA_DIRECT_PROXY_URL` — MKVDrama SOCKS5 proxy
- `MKVDRAMA_SOCKS5_ROTATION_ENABLED` — MKVDrama proxy rotation

### Step 3 — Validate proxy formats

For each configured proxy URL, validate the format:

**Valid formats:**
- `socks5://host:port`
- `socks5://user:pass@host:port`
- `http://host:port`
- `http://user:pass@host:port`
- `https://host:port`

**For `DEBRID_PER_SERVICE_PROXIES`:**
Validate the syntax: comma-separated `servicename:proxyurl` pairs.
The service names must match what `debrid-proxy.js` expects (list the valid names from Step 1).

Example valid value:
```
DEBRID_PER_SERVICE_PROXIES="realdebrid:socks5://user:pass@proxy.example.com:1080,torbox:http://proxy2.example.com:3128"
```

If the format is wrong, show the correct format with the actual service names from the codebase.

### Step 4 — Connectivity test (if proxy URLs are configured)

For each configured proxy URL, test connectivity using Bash:
```bash
curl -s --max-time 5 --proxy <PROXY_URL> https://api.real-debrid.com/rest/1.0/time -o /dev/null -w "%{http_code}"
```

If the proxy is not reachable or returns an error, report it as ❌.
If not configured, skip the test.

**Note:** For SOCKS5 proxies with credentials, the URL format in curl must use `--proxy socks5h://user:pass@host:port`.

### Step 5 — Produce proxy audit report

```
## Proxy Configuration Report

### Global Proxy
DEBRID_HTTP_PROXY: <value (masked: show host:port only) or NOT SET>
Status: [✅ valid format / ❌ invalid format / ⏭ not configured]
Connectivity: [✅ reachable / ❌ failed / ⏭ not tested]

### Per-Service Proxies
DEBRID_PER_SERVICE_PROXIES: <set/not set>
<If set, list each service:proxy pair with validation status>

### Scraper Proxies
BTDIG_USE_PROXIES: <value>
BTDIG_PROXY_URL: <masked or NOT SET>
MAGNETDL_PROXY: <masked or NOT SET>

### MKVDrama Proxy
MKVDRAMA_DIRECT_PROXY_URL: <masked or NOT SET>
MKVDRAMA_SOCKS5_ROTATION_ENABLED: <value>

### Valid Service Names for DEBRID_PER_SERVICE_PROXIES
<list from debrid-proxy.js>

### Issues Found
<numbered list of format errors, connectivity failures>

### Configuration Guide

**To route all debrid traffic through a single proxy:**
```
DEBRID_HTTP_PROXY=socks5://user:pass@your-proxy.com:1080
```

**To use different proxies per service:**
```
DEBRID_PER_SERVICE_PROXIES="realdebrid:socks5://proxy1.com:1080,alldebrid:socks5://proxy2.com:1080"
```

**For BTDigg (often geo-blocked):**
```
BTDIG_USE_PROXIES=true
# Optional: use a specific proxy instead of free rotation:
BTDIG_PROXY_URL=socks5://proxy.com:1080
```

**For MKVDrama (Cloudflare-protected):**
```
MKVDRAMA_DIRECT_PROXY_URL=socks5://proxy.com:1080
MKVDRAMA_DIRECT_PROXY_REMOTE_DNS=true
MKVDRAMA_SOCKS5_ROTATION_ENABLED=false
```

### Recommendations
<specific suggestions based on what's configured or missing>
```
