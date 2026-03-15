/**
 * MKVDrama search helpers
 * Provides search and post parsing utilities for mkvdrama.net
 */

import * as cheerio from 'cheerio';
import axios from 'axios';
import crypto from 'crypto';
import fs from 'fs';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { cleanTitle } from '../../utils/parsing.js';
import * as config from '../../../config.js';
import * as SqliteCache from '../../../util/cache-store.js';
import flaresolverrManager from '../../../util/flaresolverr-manager.js';
import socks5ProxyRotator from '../../../util/socks5-proxy-rotator.js';

const BASE_URL = 'https://mkvdrama.net';
// ouo.io is the primary short link service, oii.la/ouo.press appear on some pages
const OUO_HOSTS = ['ouo.io', 'ouo.press', 'oii.la'];
// filecrypt.cc is the new download link container service (as of 2025)
const FILECRYPT_HOSTS = ['filecrypt.cc', 'filecrypt.co'];
const MKVDRAMA_COOKIE = config.MKVDRAMA_COOKIE || process.env.MKVDRAMA_COOKIE || '';
const FLARESOLVERR_URL = config.FLARESOLVERR_URL || process.env.FLARESOLVERR_URL || '';
const FLARESOLVERR_PROXY_URL = config.FLARESOLVERR_PROXY_URL || process.env.FLARESOLVERR_PROXY_URL || '';
const BYPARR_URL = process.env.BYPARR_URL || config.BYPARR_URL || (
    FLARESOLVERR_URL.includes(':8191')
        ? FLARESOLVERR_URL.replace(':8191', ':8192')
        : ''
);
const MKVDRAMA_DIRECT_PROXY_URL = process.env.MKVDRAMA_DIRECT_PROXY_URL || FLARESOLVERR_PROXY_URL || '';
const BYPARR_PROXY_URL = process.env.BYPARR_PROXY_URL ||
    process.env.DEBRID_HTTP_PROXY ||
    MKVDRAMA_DIRECT_PROXY_URL ||
    FLARESOLVERR_PROXY_URL ||
    '';
const MKVDRAMA_DISCOVERY_ALLOW_BYPARR = process.env.MKVDRAMA_DISCOVERY_ALLOW_BYPARR !== 'false';
const MKVDRAMA_BYPARR_TIMEOUT_MS = Math.max(
    20000,
    parseInt(
        process.env.MKVDRAMA_BYPARR_TIMEOUT_MS ||
        process.env.HTTP_BYPARR_TIMEOUT ||
        process.env.HTTP_FLARESOLVERR_TIMEOUT ||
        '90000',
        10
    ) || 90000
);
const MKVDRAMA_DIRECT_PROXY_TIMEOUT_MS = Math.max(
    5000,
    parseInt(process.env.MKVDRAMA_DIRECT_PROXY_TIMEOUT_MS || '15000', 10) || 15000
);
const MKVDRAMA_DIRECT_PROXY_REMOTE_DNS = process.env.MKVDRAMA_DIRECT_PROXY_REMOTE_DNS !== 'false'; // default true
const MKVDRAMA_SOCKS5_ROTATION_ENABLED = process.env.MKVDRAMA_SOCKS5_ROTATION_ENABLED !== 'false'; // default true — use rotating free SOCKS5 proxies
const MKVDRAMA_SOCKS5_MAX_RETRIES = Math.max(1, parseInt(process.env.MKVDRAMA_SOCKS5_MAX_RETRIES || '5', 10) || 5);
const MKVDRAMA_API_SOCKS5_MAX_RETRIES = Math.max(
    1,
    parseInt(process.env.MKVDRAMA_API_SOCKS5_MAX_RETRIES || '1', 10) || 1
);
const MKVDRAMA_FORCE_FLARESOLVERR = process.env.MKVDRAMA_FORCE_FLARESOLVERR === 'true';
const MKVDRAMA_FLARESOLVERR_ENABLED = process.env.MKVDRAMA_FLARESOLVERR_ENABLED !== 'false'; // default true
const MKVDRAMA_DISCOVERY_ALLOW_FLARESOLVERR = process.env.MKVDRAMA_DISCOVERY_ALLOW_FLARESOLVERR === 'true';
// Search fanout is huge (query variants). Default to NOT using FlareSolverr for search pages.
// Enable explicitly if you want higher hit rate at the cost of CPU.
const MKVDRAMA_SEARCH_ALLOW_FLARESOLVERR = process.env.MKVDRAMA_SEARCH_ALLOW_FLARESOLVERR === 'true';
const FLARESOLVERR_V2 = config.FLARESOLVERR_V2 || process.env.FLARESOLVERR_V2 === 'true';
const MKVDRAMA_CACHE_DISABLED = process.env.MKVDRAMA_CACHE_DISABLED === 'true';
const MKVDRAMA_MAX_SLUG_PATTERNS = Math.max(
    1,
    parseInt(process.env.MKVDRAMA_MAX_SLUG_PATTERNS || '2', 10) || 2
);
const MKVDRAMA_SLUG_FALLBACK_ENABLED = process.env.MKVDRAMA_SLUG_FALLBACK_ENABLED !== 'false'; // default true, bounded by MKVDRAMA_MAX_SLUG_PATTERNS
const MKVDRAMA_SLUG_FALLBACK_TIMEOUT_MS = Math.max(
    1000,
    parseInt(process.env.MKVDRAMA_SLUG_FALLBACK_TIMEOUT_MS || '10000', 10) || 10000
);
const MKVDRAMA_FLARESOLVERR_LOCK_WAIT_MS = Math.max(
    500,
    parseInt(process.env.MKVDRAMA_FLARESOLVERR_LOCK_WAIT_MS || '2500', 10) || 2500
);
const MKVDRAMA_FLARESOLVERR_SLOT_WAIT_MS = Math.max(
    1000,
    parseInt(process.env.MKVDRAMA_FLARESOLVERR_SLOT_WAIT_MS || '8000', 10) || 8000
);
// Discovery/browser fallback is expensive under high search fanout.
// Keep it opt-in so regular stream-list generation stays HTTP-only.
const MKVDRAMA_DISCOVERY_BROWSER_FALLBACK_ENABLED =
    process.env.MKVDRAMA_DISCOVERY_BROWSER_FALLBACK_ENABLED === 'true' ||
    process.env.MKVDRAMA_BROWSER_FALLBACK_ENABLED === 'true';
const MKVDRAMA_BROWSER_FALLBACK_TIMEOUT_MS = Math.max(
    15000,
    parseInt(process.env.MKVDRAMA_BROWSER_FALLBACK_TIMEOUT_MS || '45000', 10) || 45000
);
const MKVDRAMA_RESULT_CACHE_ENABLED = process.env.MKVDRAMA_RESULT_CACHE_ENABLED === 'true';
const MKVDRAMA_WAF_BLOCK_TTL_MS = Math.max(
    0,
    parseInt(process.env.MKVDRAMA_WAF_BLOCK_TTL_MS || '300000', 10) || 300000
);

// Warmup SOCKS5 proxy pool on module load (fire-and-forget)
// Always warmup when rotation is enabled — even with a fixed proxy, we fall back to rotation on CF challenge
if (MKVDRAMA_SOCKS5_ROTATION_ENABLED) {
    socks5ProxyRotator.warmup().catch(() => {});
}

// Cache configuration
const CF_COOKIE_CACHE_TTL = parseInt(process.env.MKVDRAMA_CF_COOKIE_TTL, 10) || 0; // 0 = reuse until denied
const SQLITE_SERVICE_KEY = 'mkvdrama';
const SQLITE_CF_COOKIE_PREFIX = 'cf_cookie:';
const CF_COOKIE_CACHE = new Map(); // domain -> { cookies, userAgent } (in-memory fallback)
const FLARESOLVERR_LOCKS = new Map(); // domain -> Promise (prevents thundering herd)
const WAF_BLOCKED_UNTIL = new Map(); // domain -> timestamp
const LAST_BLOCK = new Map(); // domain -> { reason, ts }
let mkvDramaDirectProxyAgent = null;
let mkvDramaDirectProxyAgentUrl = '';
let fixedProxyBlockedUntil = 0; // Skip fixed proxy entirely when recently blocked
const FIXED_PROXY_BLOCK_TTL_MS = 5 * 60 * 1000; // 5 minutes
let mkvDramaStealthPuppeteerPromise = null;
let mkvDramaStealthPluginApplied = false;
const MKVDRAMA_BROWSER_EXECUTABLE_CANDIDATES = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    process.env.GOOGLE_CHROME_BIN,
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium'
].filter(Boolean);
let mkvDramaResolvedBrowserExecutable = undefined; // undefined = unresolved, null = not found

function recordLastBlock(domain, reason) {
    if (!domain || !reason) return;
    LAST_BLOCK.set(domain, { reason, ts: Date.now() });
}

function isWafBlockedHtml(lower = '') {
    const body = String(lower || '');
    if (!body) return false;
    // Wordfence block page. FlareSolverr cannot solve it and calling it repeatedly is wasted CPU.
    if (body.includes('your access to this site has been limited by the site owner')) return true;
    if (body.includes('generated by wordfence')) return true;
    if (body.includes('wordfence') && body.includes('site owner') && body.includes('limited')) return true;
    if (body.includes('sorry, you have been blocked')) return true;
    return false;
}

function isWafCooldownActive(domain) {
    if (!domain || MKVDRAMA_WAF_BLOCK_TTL_MS <= 0) return false;
    const until = WAF_BLOCKED_UNTIL.get(domain) || 0;
    if (!until) return false;
    if (Date.now() < until) return true;
    WAF_BLOCKED_UNTIL.delete(domain);
    return false;
}

function markWafCooldown(domain, reason = '') {
    if (!domain || MKVDRAMA_WAF_BLOCK_TTL_MS <= 0) return;
    const until = Date.now() + MKVDRAMA_WAF_BLOCK_TTL_MS;
    WAF_BLOCKED_UNTIL.set(domain, until);
    recordLastBlock(domain, 'wordfence');
    console.log(`[MKVDrama] WAF block detected for ${domain}${reason ? ` (${reason})` : ''}, skipping FlareSolverr for ${MKVDRAMA_WAF_BLOCK_TTL_MS}ms`);
}

export function getMkvDramaLastBlock(domain = 'mkvdrama.net') {
    const entry = LAST_BLOCK.get(domain);
    if (!entry) return null;
    // Keep "last block" informative but not sticky forever.
    if (Date.now() - entry.ts > Math.max(MKVDRAMA_WAF_BLOCK_TTL_MS, 5 * 60 * 1000)) {
        LAST_BLOCK.delete(domain);
        return null;
    }
    return entry;
}

function normalizeSocksProxyUrl(proxyUrl = '') {
    const raw = String(proxyUrl || '').trim();
    if (!raw) return '';
    if (!MKVDRAMA_DIRECT_PROXY_REMOTE_DNS) return raw;
    // Match curl --socks5-hostname behavior: resolve hostnames through the proxy.
    if (raw.toLowerCase().startsWith('socks5://')) return `socks5h://${raw.slice('socks5://'.length)}`;
    return raw;
}

function normalizeByparrProxyUrl(proxyUrl = '') {
    const raw = String(proxyUrl || '').trim();
    if (!raw) return '';
    if (raw.toLowerCase().startsWith('socks5h://')) {
        return `socks5://${raw.slice('socks5h://'.length)}`;
    }
    return raw;
}

function getByparrProxyHeaders() {
    const normalized = normalizeByparrProxyUrl(BYPARR_PROXY_URL);
    if (!normalized) return {};
    try {
        const parsed = new URL(normalized);
        const protocol = parsed.protocol.replace(/:$/, '').toLowerCase();
        if (!['socks5', 'http', 'https'].includes(protocol)) {
            return {};
        }
        const host = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
        const headers = {
            'X-Proxy-Server': `${protocol}://${host}`
        };
        const username = decodeURIComponent(parsed.username || '');
        const password = decodeURIComponent(parsed.password || '');
        if (username) headers['X-Proxy-Username'] = username;
        if (password) headers['X-Proxy-Password'] = password;
        return headers;
    } catch {
        return {};
    }
}

function resolveMkvDramaBrowserExecutablePath() {
    if (mkvDramaResolvedBrowserExecutable !== undefined) {
        return mkvDramaResolvedBrowserExecutable;
    }

    for (const candidate of MKVDRAMA_BROWSER_EXECUTABLE_CANDIDATES) {
        try {
            if (candidate && fs.existsSync(candidate)) {
                mkvDramaResolvedBrowserExecutable = candidate;
                console.log(`[MKVDrama] Browser fallback using executable: ${candidate}`);
                return candidate;
            }
        } catch {
            // Ignore invalid candidate paths.
        }
    }

    mkvDramaResolvedBrowserExecutable = null;
    return null;
}

function getMkvDramaBrowserLaunchOptions() {
    const options = {
        headless: 'new',
        args: ['--no-sandbox', '--disable-dev-shm-usage']
    };

    const executablePath = resolveMkvDramaBrowserExecutablePath();
    if (executablePath) {
        options.executablePath = executablePath;
    }

    return options;
}

function getMkvDramaDirectProxyAgent() {
    if (!MKVDRAMA_DIRECT_PROXY_URL) return null;
    const normalizedUrl = normalizeSocksProxyUrl(MKVDRAMA_DIRECT_PROXY_URL);
    const scheme = normalizedUrl.toLowerCase();
    if (!(scheme.startsWith('socks') || scheme.startsWith('http://') || scheme.startsWith('https://'))) {
        return null;
    }
    if (!mkvDramaDirectProxyAgent || mkvDramaDirectProxyAgentUrl !== normalizedUrl) {
        if (scheme.startsWith('socks')) {
            mkvDramaDirectProxyAgent = new SocksProxyAgent(normalizedUrl);
        } else {
            mkvDramaDirectProxyAgent = new HttpsProxyAgent(normalizedUrl);
        }
        mkvDramaDirectProxyAgentUrl = normalizedUrl;
    }
    return mkvDramaDirectProxyAgent;
}


// Helper to get from SQLite/Postgres cache
async function getDbCached(hashKey, ttl) {
    if (MKVDRAMA_CACHE_DISABLED) return null;
    if (!SqliteCache.isEnabled()) return null;
    try {
        const cached = await SqliteCache.getCachedRecord(SQLITE_SERVICE_KEY, hashKey);
        if (!cached?.data) return null;
        const updatedAt = cached.updatedAt || cached.createdAt;
        if (updatedAt && (!ttl || ttl <= 0)) {
            return cached.data;
        }
        if (updatedAt) {
            const age = Date.now() - new Date(updatedAt).getTime();
            if (age <= ttl) return cached.data;
        }
    } catch (error) {
        console.error(`[MKVDrama] Failed to read db cache: ${error.message}`);
    }
    return null;
}

// Helper to write to SQLite/Postgres cache
async function setDbCache(hashKey, data, ttlMs) {
    if (MKVDRAMA_CACHE_DISABLED) return;
    if (!SqliteCache.isEnabled()) return;
    try {
        await SqliteCache.upsertCachedMagnet({
            service: SQLITE_SERVICE_KEY,
            hash: hashKey,
            data,
            releaseKey: 'mkvdrama-http-streams'
        }, { ttlMs });
    } catch (error) {
        console.error(`[MKVDrama] Failed to write db cache: ${error.message}`);
    }
}

// Get CF cookies - check SQLite first (persists across restarts), then in-memory
async function getCachedCfCookies(domain) {
    if (!domain) return null;
    if (MKVDRAMA_CACHE_DISABLED) return null;

    // Check in-memory cache first (fastest)
    const memCached = CF_COOKIE_CACHE.get(domain);
    if (memCached) return memCached;

    // Check SQLite/Postgres cache (survives restarts)
    try {
        const dbCached = await getDbCached(`${SQLITE_CF_COOKIE_PREFIX}${domain}`, CF_COOKIE_CACHE_TTL);
        if (dbCached?.cookies) {
            // Populate in-memory cache for future requests
            CF_COOKIE_CACHE.set(domain, dbCached);
            console.log(`[MKVDrama] Restored CF cookies from DB for ${domain}`);
            return dbCached;
        }
    } catch (error) {
        console.error(`[MKVDrama] Failed to get CF cookie from DB: ${error.message}`);
    }

    return null;
}

// Cache CF cookies to both in-memory and SQLite (for persistence)
async function cacheCfCookies(domain, cookies, userAgent) {
    if (!domain || !Array.isArray(cookies) || cookies.length === 0) return;
    if (MKVDRAMA_CACHE_DISABLED) return;

    // Cache ALL cookies from FlareSolverr, not just CF ones
    // This allows reuse of session cookies even when no CF challenge was present
    const cookieString = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
    if (!cookieString) return;

    const cookieData = {
        cookies: cookieString,
        userAgent: userAgent || USER_AGENTS[0]
    };

    // Save to in-memory cache
    CF_COOKIE_CACHE.set(domain, cookieData);

    // Persist to SQLite/Postgres (survives restarts)
    const cookieNames = cookies.map(c => c.name).join(', ');
    try {
        await setDbCache(`${SQLITE_CF_COOKIE_PREFIX}${domain}`, cookieData, CF_COOKIE_CACHE_TTL);
        console.log(`[MKVDrama] Cached cookies for ${domain} (memory + DB): ${cookieNames}`);
    } catch (error) {
        console.error(`[MKVDrama] Failed to persist cookie to DB: ${error.message}`);
        console.log(`[MKVDrama] Cached cookies for ${domain} (memory only): ${cookieNames}`);
    }
}

function clearCachedCfCookies(domain) {
    if (!domain) return;
    if (MKVDRAMA_CACHE_DISABLED) return;
    CF_COOKIE_CACHE.delete(domain);
    // Also clear from DB
    setDbCache(`${SQLITE_CF_COOKIE_PREFIX}${domain}`, null, 0).catch(() => {});
}

/**
 * Fetch a page from mkvdrama.net using direct requests
 * FlareSolverr is only used for ouo.io links in http-resolver.js
 * If MKVDRAMA_COOKIE is set, it will be used for requests (for Cloudflare bypass)
 */
// Common browser User-Agents to try
// Use the same user agent as HubCloud for consistency
const HUBCLOUD_USER_AGENT = process.env.HUBCLOUD_USER_AGENT || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0';
const USER_AGENTS = [
    HUBCLOUD_USER_AGENT,
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
];

async function fetchPage(url, signal = null, options = {}) {
    const domain = (() => {
        try { return new URL(url).hostname; } catch { return null; }
    })();

    const forceFlareSolverr = (
        options.forceFlareSolverr ||
        (MKVDRAMA_FORCE_FLARESOLVERR && options?.skipFlareSolverr !== true)
    );

    // If forceFlareSolverr is set (or globally forced via env), skip direct requests.
    if (forceFlareSolverr) {
        if (isWafCooldownActive(domain)) return null;
        const headers = {
            'User-Agent': USER_AGENTS[0],
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5'
        };

        const canUseFlareSolverr = (
            FLARESOLVERR_URL &&
            MKVDRAMA_FLARESOLVERR_ENABLED &&
            MKVDRAMA_DISCOVERY_ALLOW_FLARESOLVERR
        );

        if (canUseFlareSolverr) {
            console.log(`[MKVDrama] Force solver requested for ${url} (Solvearr primary)`);
            const firstTry = await fetchWithFlareSolverr(url, headers);
            if (firstTry) return firstTry;

            // fetchWithFlareSolverr can intentionally return null while waiting on an existing
            // in-flight request for the same domain. If cookies were populated by that request,
            // do a second Solvearr call so this caller doesn't fail the search pipeline.
            const cached = await getCachedCfCookies(domain);
            if (cached?.cookies) {
                console.log(`[MKVDrama] Retrying forced Solvearr request for ${url} using freshly cached cookies`);
                await new Promise(resolve => setTimeout(resolve, 150));
                const retry = await fetchWithFlareSolverr(url, headers);
                if (retry) return retry;
            }
        }

        // Fallback to Byparr only if Solvearr is unavailable/failed.
        if (options?.skipByparr !== true) {
            const byparrResult = await fetchWithByparr(url, headers, signal);
            if (byparrResult) return byparrResult;
        }

        return null;
    }

    try {
        const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
        const headers = {
            'User-Agent': userAgent,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1'
        };
        let usedCachedCookie = false;
        if (MKVDRAMA_COOKIE) {
            headers['Cookie'] = MKVDRAMA_COOKIE;
            console.log(`[MKVDrama] Using configured cookie for ${url}`);
        } else {
            const cached = await getCachedCfCookies(domain);
            if (cached?.cookies) {
                headers['Cookie'] = cached.cookies;
                headers['User-Agent'] = cached.userAgent || headers['User-Agent'];
                usedCachedCookie = true;
                console.log(`[MKVDrama] Using cached CF cookies for ${url}`);
            }
        }
        const requestPrimary = async (requestHeaders) => {
            if (MKVDRAMA_DIRECT_PROXY_URL && Date.now() >= fixedProxyBlockedUntil) {
                try {
                    const axiosConfig = {
                        method: 'GET',
                        url,
                        headers: requestHeaders,
                        timeout: Math.min(MKVDRAMA_DIRECT_PROXY_TIMEOUT_MS, 5000), // Quick check — don't waste time on broken proxy
                        maxRedirects: 5,
                        validateStatus: () => true,
                        signal
                    };

                    const proxyAgent = getMkvDramaDirectProxyAgent();
                    if (proxyAgent) {
                        axiosConfig.httpAgent = proxyAgent;
                        axiosConfig.httpsAgent = proxyAgent;
                        axiosConfig.proxy = false;
                    }

                    const proxiedResponse = await axios.request(axiosConfig);
                    const body = typeof proxiedResponse.data === 'string'
                        ? proxiedResponse.data
                        : JSON.stringify(proxiedResponse.data || {});

                    // Check if fixed proxy returned a blocked/error response
                    const bodyLower = body.toLowerCase();
                    const isFixedProxyCfBlocked =
                        bodyLower.includes('just a moment') ||
                        bodyLower.includes('checking your browser') ||
                        bodyLower.includes('cf-browser-verification');
                    const isFixedProxyBlocked = isFixedProxyCfBlocked ||
                        proxiedResponse.status === 403 ||
                        proxiedResponse.status === 429 ||
                        proxiedResponse.status === 503;

                    if (isFixedProxyBlocked && MKVDRAMA_SOCKS5_ROTATION_ENABLED) {
                        // Cache the blocked state so subsequent requests skip the fixed proxy entirely
                        fixedProxyBlockedUntil = Date.now() + FIXED_PROXY_BLOCK_TTL_MS;
                        console.warn(`[MKVDrama] Fixed proxy ${MKVDRAMA_DIRECT_PROXY_URL} returned ${isFixedProxyCfBlocked ? 'Cloudflare challenge' : `status ${proxiedResponse.status}`} for ${url}, skipping for ${FIXED_PROXY_BLOCK_TTL_MS / 1000}s, falling back to SOCKS5 rotation`);
                        // Fall through to SOCKS5 rotation below
                    } else {
                        return {
                            statusCode: proxiedResponse.status,
                            body,
                            document: cheerio.load(body),
                            headers: proxiedResponse.headers || {}
                        };
                    }
                } catch (fixedProxyError) {
                    // Fixed proxy failed — fall through to SOCKS5 rotation if enabled
                    if (MKVDRAMA_SOCKS5_ROTATION_ENABLED) {
                        fixedProxyBlockedUntil = Date.now() + FIXED_PROXY_BLOCK_TTL_MS;
                        console.warn(`[MKVDrama] Fixed proxy ${MKVDRAMA_DIRECT_PROXY_URL} failed for ${url}: ${fixedProxyError.message}, skipping for ${FIXED_PROXY_BLOCK_TTL_MS / 1000}s, falling back to SOCKS5 rotation`);
                    } else {
                        throw fixedProxyError;
                    }
                }
            }

            // Use rotating SOCKS5 proxies if enabled (default), as primary or fallback from fixed proxy
            if (MKVDRAMA_SOCKS5_ROTATION_ENABLED) {
                const axiosConfig = {
                    method: 'GET',
                    url,
                    headers: requestHeaders,
                    timeout: MKVDRAMA_DIRECT_PROXY_TIMEOUT_MS,
                    maxRedirects: 5,
                    signal
                };

                const { response: proxiedResponse } = await socks5ProxyRotator.requestWithRotation(
                    axiosConfig,
                    { maxRetries: MKVDRAMA_SOCKS5_MAX_RETRIES }
                );
                const body = typeof proxiedResponse.data === 'string'
                    ? proxiedResponse.data
                    : JSON.stringify(proxiedResponse.data || {});
                return {
                    statusCode: proxiedResponse.status,
                    body,
                    document: cheerio.load(body),
                    headers: proxiedResponse.headers || {}
                };
            }

            // Never use direct connection for MKVDrama — always require a proxy
            throw new Error('No proxy available for MKVDrama (fixed proxy down and SOCKS5 rotation disabled)');
        };

        let response;
        try {
            response = await requestPrimary(headers);
        } catch (requestError) {
            console.warn(`[MKVDrama] Primary request failed for ${url}${MKVDRAMA_DIRECT_PROXY_URL ? ` via ${MKVDRAMA_DIRECT_PROXY_URL}` : ''}: ${requestError.message}`);

            if (
                options?.skipFlareSolverr !== true &&
                FLARESOLVERR_URL &&
                MKVDRAMA_FLARESOLVERR_ENABLED &&
                MKVDRAMA_DISCOVERY_ALLOW_FLARESOLVERR &&
                !isWafCooldownActive(domain)
            ) {
                const flareResult = await fetchWithFlareSolverr(url, headers);
                if (flareResult) return flareResult;
            }

            if (options?.skipByparr !== true) {
                const byparrResult = await fetchWithByparr(url, headers, signal);
                if (byparrResult) return byparrResult;
            }

            return null;
        }

        const body = response.body || '';
        const lower = body.toLowerCase();
        const isWafBlocked = isWafBlockedHtml(lower);
        const isCloudflare =
            lower.includes('just a moment') ||
            lower.includes('checking your browser') ||
            lower.includes('cf-browser-verification');

        // Only treat as Cloudflare blocked if we see actual challenge markers in HTML
        const isCloudflareBlocked = isCloudflare;
        if (isCloudflareBlocked && domain) {
            recordLastBlock(domain, 'cloudflare');
        }
        if (isWafBlocked && domain) {
            // Always record the reason, even if the caller requested skipFlareSolverr.
            recordLastBlock(domain, 'wordfence');
        }

        // Clear cached cookies if they didn't work (got 403/429/503 or CF challenge)
        const gotBlocked = isCloudflareBlocked ||
            isWafBlocked ||
            response.statusCode === 403 ||
            response.statusCode === 429 ||
            response.statusCode === 503;
        if (gotBlocked && usedCachedCookie) {
            console.log(`[MKVDrama] Cached cookies failed (status ${response.statusCode}), clearing for ${domain}`);
            clearCachedCfCookies(domain);
        }

        let needsFlareSolverr = isCloudflareBlocked ||
            isWafBlocked ||
            response.statusCode === 403 ||
            response.statusCode === 429 ||
            response.statusCode === 503;

        // Cached cookies can expire. Retry once without them before using FlareSolverr.
        if (gotBlocked && usedCachedCookie) {
            const retryHeaders = { ...headers };
            delete retryHeaders['Cookie'];
            retryHeaders['User-Agent'] = USER_AGENTS[0];
            console.log(`[MKVDrama] Retrying ${url} without cached cookies before FlareSolverr`);
            try {
                const retryResponse = await requestPrimary(retryHeaders);
                const retryBody = retryResponse.body || '';
                const retryLower = retryBody.toLowerCase();
                const retryCloudflare = retryLower.includes('just a moment') ||
                    retryLower.includes('checking your browser') ||
                    retryLower.includes('cf-browser-verification');
                const retryBlocked = retryCloudflare ||
                    retryResponse.statusCode === 403 ||
                    retryResponse.statusCode === 429 ||
                    retryResponse.statusCode === 503;
                if (!retryBlocked && retryResponse.statusCode < 400) {
                    console.log(`[MKVDrama] Retry without cached cookies succeeded for ${url}`);
                    return retryResponse.document || null;
                }
                needsFlareSolverr = retryBlocked;
            } catch (retryErr) {
                console.log(`[MKVDrama] Retry without cached cookies failed for ${url}: ${retryErr.message}`);
                needsFlareSolverr = true;
            }
        }

        // If the page loaded successfully (not blocked), return it now
        if (!needsFlareSolverr && response.statusCode < 400) {
            console.log(`[MKVDrama] Successfully fetched ${url} (status: ${response.statusCode}, body length: ${body.length})`);
            return response.document || null;
        }

        let solvearrAttempted = false;
        if (
            needsFlareSolverr &&
            options?.skipFlareSolverr !== true &&
            MKVDRAMA_FLARESOLVERR_ENABLED &&
            MKVDRAMA_DISCOVERY_ALLOW_FLARESOLVERR &&
            FLARESOLVERR_URL
        ) {
            solvearrAttempted = true;
            if (isWafBlocked && domain) {
                // If we already see a Wordfence-like block page via direct fetch, FlareSolverr won't help.
                markWafCooldown(domain, 'wordfence');
                return null;
            }
            if (isWafCooldownActive(domain)) return null;
            const flare = await fetchWithFlareSolverr(url, headers);
            if (flare) return flare;

            // FlareSolverr returned null - maybe we waited for another request that got cookies
            // Check if we now have cached cookies and retry via proxy (never direct)
            const newCached = await getCachedCfCookies(domain);
            if (newCached?.cookies && newCached.cookies !== headers['Cookie']) {
                console.log(`[MKVDrama] Retrying with fresh CF cookies for ${url}`);
                headers['Cookie'] = newCached.cookies;
                headers['User-Agent'] = newCached.userAgent || headers['User-Agent'];
                try {
                    const retryResponse = await requestPrimary(headers);
                    if (retryResponse.statusCode < 400) {
                        console.log(`[MKVDrama] Retry successful for ${url}`);
                        return retryResponse.document || null;
                    }
                } catch (retryErr) {
                    console.log(`[MKVDrama] Retry failed for ${url}: ${retryErr.message}`);
                }
            }
        }

        // Fallback to Byparr only when Solvearr failed or was skipped.
        if (needsFlareSolverr && options?.skipByparr !== true) {
            const byparrResult = await fetchWithByparr(url, headers, signal);
            if (byparrResult) return byparrResult;
        }

        if (options?.skipFlareSolverr === true && !solvearrAttempted) {
            // Caller explicitly requested no FlareSolverr (useful for search pages; slug fallback can handle most titles).
            return null;
        }

        if (isCloudflare) {
            console.error(`[MKVDrama] Cloudflare challenge detected for ${url} - set MKVDRAMA_COOKIE with cf_clearance`);
            return null;
        }

        if (response.statusCode >= 400) {
            console.error(`[MKVDrama] Request failed for ${url}: status ${response.statusCode}`);
            return null;
        }

        console.log(`[MKVDrama] Successfully fetched ${url} (status: ${response.statusCode}, body length: ${body.length})`);
        return response.document || null;
    } catch (error) {
        console.error(`[MKVDrama] Request failed for ${url}: ${error.message}`);
        return null;
    }
}

// Internal function that actually calls FlareSolverr
async function _doFlareSolverrRequest(url, headers = {}) {
    // Check if FlareSolverr is available (not overloaded)
    if (!flaresolverrManager.isAvailable()) {
        const status = flaresolverrManager.getStatus();
        console.warn(`[MKVDrama] FlareSolverr unavailable: circuit=${status.circuitOpen}, queue=${status.queueDepth}`);
        return { success: false, body: null, overloaded: true };
    }

    // Acquire rate limit slot
    const slot = await flaresolverrManager.acquireSlot(MKVDRAMA_FLARESOLVERR_SLOT_WAIT_MS);
    if (!slot.acquired) {
        console.warn(`[MKVDrama] Could not acquire FlareSolverr slot: ${slot.reason}`);
        return { success: false, body: null, overloaded: true };
    }

    const flareTimeout = Math.max(30000, 15000 * 3);
    const domain = (() => {
        try { return new URL(url).hostname; } catch { return null; }
    })();
    try {
        const requestBody = {
            cmd: 'request.get',
            url,
            maxTimeout: flareTimeout
        };
        if (FLARESOLVERR_PROXY_URL) {
            requestBody.proxy = { url: FLARESOLVERR_PROXY_URL };
        }
        const response = await axios.post(`${FLARESOLVERR_URL}/v1`, requestBody, {
            timeout: flareTimeout + 5000
        });
        let solution = response?.data?.solution;
        // Follow redirects (Solvearr does not follow them automatically)
        const redirectStatus = solution?.status;
        if (redirectStatus && redirectStatus >= 300 && redirectStatus < 400) {
            const location = solution.headers?.Location || solution.headers?.location;
            if (location) {
                const redirectUrl = new URL(location, url).toString();
                console.log(`[MKVDrama] FlareSolverr got ${redirectStatus} redirect to ${redirectUrl}`);
                const redirectBody = { cmd: 'request.get', url: redirectUrl, maxTimeout: flareTimeout };
                if (FLARESOLVERR_PROXY_URL) redirectBody.proxy = { url: FLARESOLVERR_PROXY_URL };
                const redirectResponse = await axios.post(`${FLARESOLVERR_URL}/v1`, redirectBody, { timeout: flareTimeout + 5000 });
                solution = redirectResponse?.data?.solution;
            }
        }
        if (!solution?.response) {
            console.log(`[MKVDrama] FlareSolverr returned no response for ${url}`);
            flaresolverrManager.reportFailure();
            return { success: false, body: null };
        }
        const body = solution.response;
        const lower = String(body).toLowerCase();
        if (lower.includes('just a moment') || lower.includes('checking your browser') || lower.includes('cf-browser-verification')) {
            console.log(`[MKVDrama] FlareSolverr still blocked for ${url}`);
            return { success: false, body: null };
        }
        if (isWafBlockedHtml(lower)) {
            if (domain) markWafCooldown(domain, 'wordfence');
            console.log(`[MKVDrama] FlareSolverr returned WAF block page for ${url}`);
            flaresolverrManager.reportFailure();
            return { success: false, body: null };
        }
        // Detect browser-level "site can't be reached" errors — FlareSolverr returns 200
        // but the underlying browser failed to connect (e.g. proxy DNS failure, timeout).
        if (lower.includes('this site can\u2019t be reached') || lower.includes('this site can\'t be reached') ||
            lower.includes('main-frame-error') || lower.includes('err_')) {
            console.log(`[MKVDrama] FlareSolverr returned browser error page for ${url} (site unreachable via proxy)`);
            flaresolverrManager.reportFailure();
            return { success: false, body: null };
        }
        if (domain && solution.cookies) {
            await cacheCfCookies(domain, solution.cookies, solution.userAgent || headers['User-Agent']);
        }
        console.log(`[MKVDrama] FlareSolverr success for ${url} (status: ${solution.status || 'n/a'})`);
        return { success: true, body };
    } catch (error) {
        console.log(`[MKVDrama] FlareSolverr error for ${url}: ${error.message}`);
        // Report timeout to manager to help circuit breaker
        if (error.message.includes('timeout') || error.code === 'ECONNABORTED') {
            flaresolverrManager.reportTimeout();
        } else {
            flaresolverrManager.reportFailure();
        }
        return { success: false, body: null };
    } finally {
        slot.release(); // Always release the rate limit slot
    }
}

// Wrapper that prevents thundering herd - only one FlareSolverr call per domain at a time
async function fetchWithFlareSolverr(url, headers = {}) {
    if (!FLARESOLVERR_URL) return null;

    const domain = (() => {
        try { return new URL(url).hostname; } catch { return null; }
    })();

    // If there's already a FlareSolverr request in progress for this domain, wait for it
    const existingLock = domain ? FLARESOLVERR_LOCKS.get(domain) : null;
    if (existingLock) {
        console.log(`[MKVDrama] Waiting up to ${MKVDRAMA_FLARESOLVERR_LOCK_WAIT_MS}ms for existing FlareSolverr request for ${domain}...`);
        const lockCompleted = await Promise.race([
            existingLock.then(() => true).catch(() => false),
            new Promise(resolve => setTimeout(() => resolve(false), MKVDRAMA_FLARESOLVERR_LOCK_WAIT_MS))
        ]);
        if (lockCompleted) {
            // After waiting, check if we now have cached cookies
            const cached = await getCachedCfCookies(domain);
            if (cached?.cookies) {
                console.log(`[MKVDrama] Using cookies from completed FlareSolverr request for ${domain}`);
                return null; // Return null to signal caller should retry with cached cookies
            }
        } else {
            console.log(`[MKVDrama] Existing FlareSolverr request for ${domain} still running after ${MKVDRAMA_FLARESOLVERR_LOCK_WAIT_MS}ms, continuing with a new attempt`);
        }
    }

    // Create a lock for this domain
    let resolveLock;
    const lockPromise = new Promise(resolve => { resolveLock = resolve; });
    if (domain) {
        FLARESOLVERR_LOCKS.set(domain, lockPromise);
    }

    try {
        const result = await _doFlareSolverrRequest(url, headers);
        if (result.success && result.body) {
            return cheerio.load(result.body);
        }
        return null;
    } finally {
        // Release the lock
        if (domain) {
            FLARESOLVERR_LOCKS.delete(domain);
        }
        resolveLock?.();
    }
}

async function fetchWithByparr(url, headers = {}, signal = null) {
    if (!BYPARR_URL || !MKVDRAMA_DISCOVERY_ALLOW_BYPARR) return null;
    const domain = (() => {
        try { return new URL(url).hostname; } catch { return null; }
    })();

    const requestBody = {
        cmd: 'request.get',
        url,
        // Byparr's schema uses seconds.
        max_timeout: Math.max(30, Math.ceil(MKVDRAMA_BYPARR_TIMEOUT_MS / 1000))
    };

    // Avoid forwarding stale direct-request cookies/headers into Byparr.
    // Let its browser session negotiate fresh anti-bot state.
    const byparrRequestHeaders = {};
    if (headers?.['Accept-Language']) {
        byparrRequestHeaders['Accept-Language'] = headers['Accept-Language'];
    }
    if (Object.keys(byparrRequestHeaders).length > 0) {
        requestBody.headers = byparrRequestHeaders;
    }

    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            const response = await axios.post(`${BYPARR_URL}/v1`, requestBody, {
                timeout: MKVDRAMA_BYPARR_TIMEOUT_MS + 5000,
                signal,
                validateStatus: () => true,
                headers: {
                    'Content-Type': 'application/json',
                    ...getByparrProxyHeaders()
                }
            });

            const solution = response?.data?.solution || null;
            if (response.status >= 400 || !solution?.response) {
                const message = String(response?.data?.message || '').trim();
                console.log(`[MKVDrama] Byparr non-ok response for ${url}: status=${response.status}${message ? `, message=${message}` : ''} (attempt ${attempt}/${maxAttempts})`);
                if (attempt < maxAttempts) {
                    await new Promise(resolve => setTimeout(resolve, 400 * attempt));
                    continue;
                }
                return null;
            }

            const statusCode = solution?.status || response.status;
            const body = String(solution.response || '');
            const lower = body.toLowerCase();
            const isCloudflare =
                lower.includes('just a moment') ||
                lower.includes('checking your browser') ||
                lower.includes('cf-browser-verification');
            const isWafBlocked = isWafBlockedHtml(lower);
            const isBlockedStatus = statusCode === 403 || statusCode === 429 || statusCode === 503;

            if (isCloudflare && domain) {
                recordLastBlock(domain, 'cloudflare');
            }
            if (isWafBlocked && domain) {
                markWafCooldown(domain, 'wordfence');
            }

            // Byparr can return browser transport errors with HTTP 200.
            const browserError = lower.includes('this site can\u2019t be reached') ||
                lower.includes('this site can\'t be reached') ||
                lower.includes('main-frame-error') ||
                lower.includes('err_');
            if (browserError || isCloudflare || isWafBlocked || isBlockedStatus) {
                console.log(`[MKVDrama] Byparr blocked/error response for ${url} (status: ${statusCode}, attempt ${attempt}/${maxAttempts})`);
                if (attempt < maxAttempts) {
                    await new Promise(resolve => setTimeout(resolve, 400 * attempt));
                    continue;
                }
                return null;
            }

            if (domain && Array.isArray(solution.cookies) && solution.cookies.length > 0) {
                await cacheCfCookies(
                    domain,
                    solution.cookies,
                    solution.userAgent || headers['User-Agent'] || USER_AGENTS[0]
                );
            }

            console.log(`[MKVDrama] Byparr success for ${url} (status: ${statusCode})`);
            return cheerio.load(body);
        } catch (error) {
            console.log(`[MKVDrama] Byparr error for ${url}: ${error.message} (attempt ${attempt}/${maxAttempts})`);
            if (attempt < maxAttempts) {
                await new Promise(resolve => setTimeout(resolve, 400 * attempt));
                continue;
            }
            return null;
        }
    }

    return null;
}

function normalizeUrl(href, base = BASE_URL) {
    if (!href) return null;
    try {
        return new URL(href, base).toString();
    } catch {
        return null;
    }
}

function cleanText(text = '') {
    return text.replace(/\s+/g, ' ').trim();
}

function tryParseJsonPayload(value = '') {
    const raw = String(value || '').trim();
    if (!raw || (!raw.startsWith('{') && !raw.startsWith('['))) return null;
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

function extractJsonPayloadFromDocument($) {
    if (!$) return null;
    const rootText = $('body').text()?.trim() || $.root().text()?.trim() || '';
    return tryParseJsonPayload(rootText);
}

function normalizePosterUrl(url = '') {
    const raw = String(url || '').trim();
    if (!raw) return null;
    if (/^https?:\/\//i.test(raw)) return raw;
    return normalizeUrl(raw, BASE_URL);
}

function isMkvDramaNotFoundDetail(detail = '') {
    const lower = String(detail || '').toLowerCase();
    if (!lower) return false;
    return lower.includes('not found')
        || lower.includes('invalid api key')
        || lower.includes('taxonomy model');
}

function isMkvDramaNotFoundTitle(title = '') {
    const lower = String(title || '').toLowerCase();
    if (!lower) return false;
    return lower.includes('page not found')
        || lower === '404'
        || lower.startsWith('404 ')
        || lower.includes('not found');
}

function extractSlugResultFromJsonPayload(payload, url) {
    if (!payload || typeof payload !== 'object') return null;
    if (isMkvDramaNotFoundDetail(payload.detail || payload.message)) return null;

    const series = payload.series && typeof payload.series === 'object' ? payload.series : null;
    const title = cleanText(series?.title || payload?.title || '');
    if (!title || isMkvDramaNotFoundTitle(title)) return null;

    const yearSource = series?.release_date || series?.published_at || '';
    const yearMatch = String(yearSource || '').match(/\b(19|20)\d{2}\b/);
    const slug = String(series?.slug || '').trim();
    const normalizedUrl = slug ? normalizeUrl(`/${slug}`, BASE_URL) : url;
    const poster = normalizePosterUrl(series?.cover_url || series?.big_cover_url || '');

    return {
        title,
        url: normalizedUrl || url,
        year: yearMatch ? parseInt(yearMatch[0], 10) : null,
        poster,
        normalizedTitle: cleanTitle(title)
    };
}

function hasMkvDramaDownloadMarkers($) {
    if (!$) return false;
    const structured = $('.soraddlx, .soraddl, .soradd').length > 0;
    const directLinks = $('a[href*="ouo."], a[href*="oii.la"], a[href*="filecrypt."], a[href*="pixeldrain"], a[href*="viewcrate"], a[href*="/_c/"]').length > 0;
    // New MKVDrama pages may hide links behind dynamic API attributes and render
    // link blocks client-side (no static anchor markers in initial HTML).
    const dynamicApiMarkers = $('[data-k][data-k3], [data-k][data-k2][data-k3]').length > 0;
    return structured || directLinks || dynamicApiMarkers;
}

function decodeMkvDramaToken(token = '') {
    if (!token) return null;
    try {
        const decoded = Buffer.from(String(token), 'base64').toString('utf8').trim();
        return decoded || null;
    } catch {
        return null;
    }
}

function decodeMkvDramaDataUrl($, element) {
    if (!element) return null;
    try {
        const token = $(element).attr('data-kp2v') || $(element).attr('data-kp') || '';
        const decoded = decodeMkvDramaToken(token);
        if (!decoded) return null;
        // Some pages store full OUO/filecrypt URLs in base64.
        // Example: data-kp2v="aHR0cHM6Ly9vdW8uaW8vWGNEU21D" -> https://ouo.io/XcDSmC
        if (decoded.startsWith('http://') || decoded.startsWith('https://')) return decoded;
        return null;
    } catch {
        return null;
    }
}

function isLikelyPasswordCandidate(raw = '') {
    const text = cleanText(String(raw || ''));
    if (!text || text.length < 2 || text.length > 48) return false;
    if (/https?:\/\//i.test(text)) return false;
    if (/[\r\n]/.test(String(raw || ''))) return false;
    if (/[.,!?;:()[\]{}<>/@\\]/.test(text)) return false;

    const words = text.split(/\s+/).filter(Boolean);
    if (words.length > 4) return false;
    if (words.some(word => word.length > 20)) return false;

    if (/^\d{3,8}$/.test(text)) return true;
    if (/^[A-Za-z0-9_-]{3,32}$/.test(text)) return true;
    if (/^[A-Za-z0-9]+(?: [A-Za-z0-9]+){1,3}$/.test(text)) return true;

    return false;
}

function extractCommentPasswordCandidates($) {
    if (!$) return [];

    const candidates = [];
    const seen = new Set();

    $('.fe-comments-list li.fe-comment-item').each((_, item) => {
        const comment = $(item);
        const rawBody = comment.find('.fe-comment-text[data-raw-body]').first().attr('data-raw-body')
            || comment.find('.fe-comment-text').first().text()
            || '';
        const text = cleanText(rawBody);
        if (!isLikelyPasswordCandidate(text)) return;

        const author = cleanText(comment.find('.fe-comment-author').first().text()).toLowerCase();
        const role = cleanText(comment.find('.fe-role-badge').first().text()).toLowerCase();
        const isVerified = comment.find('.fe-comment-verified-badge').length > 0;
        const isAdmin = author.includes('admin');

        let score = 0;
        if (isAdmin) score += 100;
        if (isVerified) score += 40;
        if (role.includes('moderator')) score += 30;
        if (/^\d{3,8}$/.test(text)) score += 35;
        if (/^[A-Za-z0-9_-]{3,32}$/.test(text)) score += 20;
        if (/\s/.test(text)) score -= 5;

        const key = text.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        candidates.push({ text, score });
    });

    return candidates
        .sort((a, b) => b.score - a.score || a.text.localeCompare(b.text))
        .map(candidate => candidate.text)
        .slice(0, 6);
}

function attachPasswordCandidates(downloadLinks = [], passwordCandidates = []) {
    if (!downloadLinks.length || !passwordCandidates.length) return downloadLinks;
    return downloadLinks.map(entry => ({
        ...entry,
        passwords: passwordCandidates
    }));
}

function collectPasswordCandidates(downloadLinks = []) {
    const values = [];
    const seen = new Set();
    for (const entry of downloadLinks) {
        if (!Array.isArray(entry?.passwords)) continue;
        for (const candidate of entry.passwords) {
            const normalized = cleanText(String(candidate || ''));
            if (!normalized) continue;
            const key = normalized.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            values.push(normalized);
        }
    }
    return values;
}

function buildMkvDramaTokenUrl(token = '') {
    if (!token) return null;
    return `${BASE_URL}/?mkv_token=${encodeURIComponent(token)}`;
}

function normalizeHostName(text = '') {
    const normalized = cleanText(text).toLowerCase();
    if (!normalized) return null;
    if (normalized.includes('pixeldrain')) return 'pixeldrain.com';
    if (normalized.includes('gofile')) return 'gofile.io';
    if (normalized.includes('mega')) return 'mega.nz';
    if (normalized.includes('send.now')) return 'send.now';
    if (normalized.includes('send.cm')) return 'send.cm';
    return normalized.includes('.') ? normalized : null;
}

function getHostFromElement($, element) {
    if (!element) return null;
    const hostAttr = $(element)
        .closest('[data-oc2le],[data-07cgr]')
        .attr('data-oc2le') || $(element).closest('[data-07cgr]').attr('data-07cgr');
    return normalizeHostName(hostAttr || '');
}

function collectEncodedLinks($, scope, fallbackLabel = '') {
    const downloadLinks = [];
    const seen = new Set();

    scope.find('[data-riwjd]').each((_, el) => {
        const tokenRaw = $(el).attr('data-riwjd');
        const decoded = decodeMkvDramaToken(tokenRaw);
        const url = buildMkvDramaTokenUrl(decoded);
        if (!url || seen.has(url)) return;
        seen.add(url);

        const container = $(el).closest('div');
        const episodeContainer = $(el).closest('[data-4xptf]');
        const episodeLabel = cleanText(
            episodeContainer.attr('data-4xptf') ||
            episodeContainer.find('h2').first().text() ||
            fallbackLabel
        );
        const label = cleanText(container.find('span').first().text()) || episodeLabel || fallbackLabel;
        const quality = label;
        const host = getHostFromElement($, el) || normalizeHostName(container.find('span').eq(1).text());
        const episodeRange = parseEpisodeRange(episodeLabel);
        const season = parseSeasonNumber(episodeLabel);

        downloadLinks.push({
            url,
            label: episodeLabel || label,
            quality,
            linkText: label,
            host,
            episodeStart: episodeRange?.start ?? null,
            episodeEnd: episodeRange?.end ?? null,
            season
        });
    });

    return downloadLinks;
}

function parseEpisodeRange(label = '') {
    const normalized = label || '';
    // Match "Episode 12", "Episodes 1-13", "Ep. 12", "Eps 1 to 13", etc.
    const match = normalized.match(/(?:episode|episodes|ep|eps)\.?\s*(\d{1,3})(?:\s*(?:-|to|–|—|&|and)\s*(\d{1,3}))?/i);
    if (match) {
        const start = parseInt(match[1], 10);
        const end = match[2] ? parseInt(match[2], 10) : start;
        if (Number.isNaN(start)) return null;
        return { start, end };
    }

    const seMatch = normalized.match(/\bS(\d{1,2})E(\d{1,3})\b/i);
    if (seMatch) {
        const episode = parseInt(seMatch[2], 10);
        if (!Number.isNaN(episode)) return { start: episode, end: episode };
    }

    const eMatch = normalized.match(/\bE(\d{1,3})\b/i);
    if (eMatch) {
        const episode = parseInt(eMatch[1], 10);
        if (!Number.isNaN(episode)) return { start: episode, end: episode };
    }

    // Match standalone number ranges like "1-13", "01-13" (common in mkvdrama labels)
    // Only match when the label is primarily a number range (not embedded in other text)
    const rangeMatch = normalized.match(/^\s*0*(\d{1,3})\s*(?:-|–|—)\s*0*(\d{1,3})\s*$/);
    if (rangeMatch) {
        const start = parseInt(rangeMatch[1], 10);
        const end = parseInt(rangeMatch[2], 10);
        if (!Number.isNaN(start) && !Number.isNaN(end) && end >= start) {
            return { start, end };
        }
    }

    return null;
}

function parseSeasonNumber(label = '') {
    const normalized = label || '';
    const match = normalized.match(/season\s*(\d{1,2})/i) ||
        normalized.match(/\bS(\d{1,2})E\d{1,3}\b/i) ||
        normalized.match(/\bS(\d{1,2})\b/i);
    if (!match) return null;
    const season = parseInt(match[1], 10);
    return Number.isNaN(season) ? null : season;
}

function isOuoLink(url) {
    if (!url) return false;
    return OUO_HOSTS.some(host => url.toLowerCase().includes(host));
}

function isFilecryptLink(url) {
    if (!url) return false;
    return FILECRYPT_HOSTS.some(host => url.toLowerCase().includes(host));
}

function isMkvDramaProtectedLink(url) {
    if (!url) return false;
    try {
        const parsed = new URL(url, BASE_URL);
        return parsed.hostname.includes('mkvdrama.net') && /\/_c\//.test(parsed.pathname || '');
    } catch {
        return false;
    }
}

// Check if URL is a valid download link (ouo/filecrypt or mkvdrama protected _c links)
function isDownloadLink(url) {
    return isOuoLink(url) || isFilecryptLink(url) || isMkvDramaProtectedLink(url);
}

/**
 * Extract download token and API path from the rendered HTML page.
 * The new MKVDrama site (2025+) stores downloads behind an encrypted API
 * instead of embedding links directly in the HTML.
 */
function extractDownloadApiInfo($) {
    const article = $('article[data-download-token][data-download-api-path]');
    if (!article.length) return null;
    const token = article.attr('data-download-token');
    const apiPath = article.attr('data-download-api-path');
    if (!token || !apiPath) return null;
    return { token, apiPath };
}

/**
 * Extract download token and API path from raw HTML string (no cheerio needed).
 */
function extractDownloadApiInfoFromHtml(html) {
    if (!html) return null;
    const tokenMatch = html.match(/data-download-token="([^"]+)"/);
    const apiPathMatch = html.match(/data-download-api-path="([^"]+)"/);
    if (!tokenMatch?.[1] || !apiPathMatch?.[1]) return null;
    return { token: tokenMatch[1], apiPath: apiPathMatch[1] };
}

/**
 * Extract CSRF token from the page HTML.
 */
function extractCsrfToken(html) {
    if (!html) return null;
    const match = html.match(/name="csrf-token" content="([^"]+)"/);
    return match?.[1] || null;
}

/**
 * Decrypt the download API response.
 * The API returns { d: base64_encrypted_data, s: hex_iv }.
 * Decryption: AES-256-GCM, key = SHA-256(token), iv = hex(s), authTag = last 16 bytes of d.
 */
function decryptDownloadResponse(encData, token) {
    if (!encData?.d || !encData?.s || !token) return null;
    try {
        const key = crypto.createHash('sha256').update(token).digest();
        const iv = Buffer.from(encData.s, 'hex');
        const raw = Buffer.from(encData.d, 'base64');
        const authTag = raw.subarray(raw.length - 16);
        const ciphertext = raw.subarray(0, raw.length - 16);
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(authTag);
        const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        return JSON.parse(decrypted.toString('utf8'));
    } catch (err) {
        console.error(`[MKVDrama] Failed to decrypt download API response: ${err.message}`);
        return null;
    }
}

function mapDownloadSectionsToLinks(downloadSections = []) {
    const downloadLinks = [];

    for (const section of downloadSections) {
        const sectionTitle = section.title || '';
        const episodeRange = parseEpisodeRange(sectionTitle);
        const season = parseSeasonNumber(sectionTitle);

        for (const resolution of (section.resolutions || [])) {
            const quality = resolution.quality || '';
            for (const link of (resolution.links || [])) {
                if (!link.url || !isDownloadLink(link.url)) continue;
                downloadLinks.push({
                    url: link.url,
                    label: sectionTitle,
                    quality,
                    linkText: link.hosting_name || '',
                    episodeStart: episodeRange?.start ?? null,
                    episodeEnd: episodeRange?.end ?? null,
                    season: season ?? null,
                    host: null
                });
            }
        }
    }

    return downloadLinks;
}

async function getMkvDramaStealthPuppeteer() {
    if (!MKVDRAMA_DISCOVERY_BROWSER_FALLBACK_ENABLED) return null;
    if (!mkvDramaStealthPuppeteerPromise) {
        mkvDramaStealthPuppeteerPromise = (async () => {
            const [{ default: puppeteerExtra }, { default: StealthPlugin }] = await Promise.all([
                import('puppeteer-extra'),
                import('puppeteer-extra-plugin-stealth')
            ]);
            if (!mkvDramaStealthPluginApplied) {
                puppeteerExtra.use(StealthPlugin());
                mkvDramaStealthPluginApplied = true;
            }
            return puppeteerExtra;
        })().catch((error) => {
            mkvDramaStealthPuppeteerPromise = null;
            throw error;
        });
    }
    return mkvDramaStealthPuppeteerPromise;
}

async function fetchDownloadApiLinksWithBrowser(postUrl, signal = null) {
    if (!postUrl || !MKVDRAMA_DISCOVERY_BROWSER_FALLBACK_ENABLED) return [];
    if (signal?.aborted) return [];

    let browser = null;

    try {
        const puppeteerExtra = await getMkvDramaStealthPuppeteer();
        if (!puppeteerExtra) return [];

        browser = await puppeteerExtra.launch(getMkvDramaBrowserLaunchOptions());

        const page = await browser.newPage();
        const apiCapture = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('browser API timeout')), MKVDRAMA_BROWSER_FALLBACK_TIMEOUT_MS);

            page.on('response', async (response) => {
                const url = response.url();
                if (!url.includes('/dl/')) return;

                clearTimeout(timer);

                try {
                    const request = response.request();
                    const postData = request.postData() || '{}';
                    const payload = JSON.parse(postData);
                    const responseBody = await response.text();
                    const encrypted = JSON.parse(responseBody);
                    resolve({
                        token: payload?.t || null,
                        encrypted
                    });
                } catch (error) {
                    reject(error);
                }
            });
        });

        await page.goto(postUrl, {
            waitUntil: 'networkidle2',
            timeout: MKVDRAMA_BROWSER_FALLBACK_TIMEOUT_MS
        });

        const pageHtml = await page.content().catch(() => '');
        const passwordCandidates = pageHtml
            ? extractCommentPasswordCandidates(cheerio.load(pageHtml))
            : [];
        const captured = await apiCapture;
        const decrypted = decryptDownloadResponse(captured?.encrypted, captured?.token);
        if (!decrypted?.download_sections?.length) {
            return [];
        }

        return attachPasswordCandidates(
            mapDownloadSectionsToLinks(decrypted.download_sections),
            passwordCandidates
        );
    } catch (error) {
        console.error(`[MKVDrama] Browser API fallback failed: ${error.message}`);
        return [];
    } finally {
        if (browser) {
            await browser.close().catch(() => {});
        }
    }
}

async function fallbackDownloadApiLinks(postUrl, reason = 'unknown', signal = null) {
    if (!MKVDRAMA_DISCOVERY_BROWSER_FALLBACK_ENABLED) return [];
    console.log(`[MKVDrama] Falling back to stealth browser for download API (${reason})`);
    const links = await fetchDownloadApiLinksWithBrowser(postUrl, signal);
    if (links.length > 0) {
        console.log(`[MKVDrama] Browser fallback returned ${links.length} links`);
    }
    return links;
}

async function loadMkvDramaContentWithBrowser(postUrl, signal = null) {
    if (!postUrl || !MKVDRAMA_DISCOVERY_BROWSER_FALLBACK_ENABLED) {
        return { title: '', downloadLinks: [] };
    }
    if (signal?.aborted) {
        return { title: '', downloadLinks: [] };
    }

    let browser = null;

    try {
        const puppeteerExtra = await getMkvDramaStealthPuppeteer();
        if (!puppeteerExtra) {
            return { title: '', downloadLinks: [] };
        }

        browser = await puppeteerExtra.launch(getMkvDramaBrowserLaunchOptions());

        const page = await browser.newPage();
        const apiCapture = new Promise((resolve) => {
            const timer = setTimeout(() => resolve(null), MKVDRAMA_BROWSER_FALLBACK_TIMEOUT_MS);

            page.on('response', async (response) => {
                const url = response.url();
                if (!url.includes('/dl/')) return;

                clearTimeout(timer);

                try {
                    const request = response.request();
                    const postData = request.postData() || '{}';
                    const payload = JSON.parse(postData);
                    const responseBody = await response.text();
                    const encrypted = JSON.parse(responseBody);
                    resolve({
                        token: payload?.t || null,
                        encrypted
                    });
                } catch {
                    resolve(null);
                }
            });
        });

        await page.goto(postUrl, {
            waitUntil: 'networkidle2',
            timeout: MKVDRAMA_BROWSER_FALLBACK_TIMEOUT_MS
        });

        const pageHtml = await page.content().catch(() => '');
        const title = (await page.title().catch(() => ''))
            .replace(/\s*\|\s*MkvDrama.*$/i, '')
            .replace(/\s+Download at MkvDrama$/i, '')
            .trim();
        const passwordCandidates = pageHtml
            ? extractCommentPasswordCandidates(cheerio.load(pageHtml))
            : [];

        const captured = await apiCapture;
        const decrypted = decryptDownloadResponse(captured?.encrypted, captured?.token);
        const downloadLinks = decrypted?.download_sections?.length
            ? mapDownloadSectionsToLinks(decrypted.download_sections)
            : [];

        return {
            title,
            downloadLinks: attachPasswordCandidates(downloadLinks, passwordCandidates)
        };
    } catch (error) {
        console.error(`[MKVDrama] Browser content fallback failed: ${error.message}`);
        return { title: '', downloadLinks: [] };
    } finally {
        if (browser) {
            await browser.close().catch(() => {});
        }
    }
}

function parseMkvDramaSearchResults($) {
    const results = [];
    const seen = new Set();

    const addResult = (title, url, poster = null) => {
        if (!title || !url || seen.has(url)) return;
        seen.add(url);
        const yearMatch = title.match(/\b(19|20)\d{2}\b/);
        results.push({
            title,
            url,
            year: yearMatch ? parseInt(yearMatch[0], 10) : null,
            poster,
            normalizedTitle: cleanTitle(title)
        });
    };

    const articles = $('article');
    console.log(`[MKVDrama] Found ${articles.length} article elements in search results`);

    articles.each((_, el) => {
        const anchor = $(el).find('.bsx a').first();
        const title = cleanText(anchor.attr('title') || anchor.text());
        const url = normalizeUrl(anchor.attr('href'));
        const poster = $(el).find('img').attr('data-lazy-src') || $(el).find('img').attr('src') || null;
        addResult(title, url, poster);
    });

    if (results.length === 0) {
        const selectors = [
            'h2.entry-title a',
            'h2.post-title a',
            'h2.title a',
            'a[rel="bookmark"]'
        ];
        selectors.forEach((selector) => {
            $(selector).each((_, el) => {
                const anchor = $(el);
                const title = cleanText(anchor.attr('title') || anchor.text());
                const url = normalizeUrl(anchor.attr('href'));
                const article = anchor.closest('article');
                const poster = article.find('img').attr('data-lazy-src') || article.find('img').attr('src') || null;
                addResult(title, url, poster);
            });
        });
    }

    console.log(`[MKVDrama] Parsed ${results.length} results from search page`);
    return results;
}

async function searchMkvDramaWithBrowser(searchUrl, signal = null) {
    if (!searchUrl || !MKVDRAMA_DISCOVERY_BROWSER_FALLBACK_ENABLED || signal?.aborted) return [];

    let browser = null;

    try {
        const puppeteerExtra = await getMkvDramaStealthPuppeteer();
        if (!puppeteerExtra) return [];

        browser = await puppeteerExtra.launch(getMkvDramaBrowserLaunchOptions());

        const page = await browser.newPage();
        await page.goto(searchUrl, {
            waitUntil: 'networkidle2',
            timeout: MKVDRAMA_BROWSER_FALLBACK_TIMEOUT_MS
        });

        const html = await page.content().catch(() => '');
        if (!html) return [];

        const results = parseMkvDramaSearchResults(cheerio.load(html));
        if (results.length > 0) {
            console.log(`[MKVDrama] Browser search fallback returned ${results.length} results for ${searchUrl}`);
        }
        return results;
    } catch (error) {
        console.error(`[MKVDrama] Browser search fallback failed: ${error.message}`);
        return [];
    } finally {
        if (browser) {
            await browser.close().catch(() => {});
        }
    }
}

async function tryFetchSlugUrlWithBrowser(url, signal = null) {
    if (!url || !MKVDRAMA_DISCOVERY_BROWSER_FALLBACK_ENABLED || signal?.aborted) return null;

    let browser = null;

    try {
        const puppeteerExtra = await getMkvDramaStealthPuppeteer();
        if (!puppeteerExtra) return null;

        browser = await puppeteerExtra.launch(getMkvDramaBrowserLaunchOptions());

        const page = await browser.newPage();
        await page.goto(url, {
            waitUntil: 'networkidle2',
            timeout: MKVDRAMA_BROWSER_FALLBACK_TIMEOUT_MS
        });

        const html = await page.content().catch(() => '');
        if (!html) return null;

        const $ = cheerio.load(html);

        const jsonPayload = extractJsonPayloadFromDocument($);
        if (jsonPayload) {
            return extractSlugResultFromJsonPayload(jsonPayload, page.url() || url);
        }

        let title = cleanText($('h1.entry-title').text()) || cleanText($('title').text()) || '';
        title = title.replace(/\s*\|\s*MkvDrama.*$/i, '').trim();
        if (!title || isMkvDramaNotFoundTitle(title)) return null;

        const hasContent = hasMkvDramaDownloadMarkers($) || $('article[data-download-token]').length > 0;
        if (!hasContent) return null;

        const yearMatch = title.match(/\b(19|20)\d{2}\b/);
        const poster = $('img.wp-post-image').attr('data-lazy-src') ||
            $('img.wp-post-image').attr('src') ||
            $('.thumb img').attr('data-lazy-src') ||
            $('.thumb img').attr('src') || null;

        return {
            title,
            url: page.url() || url,
            year: yearMatch ? parseInt(yearMatch[0], 10) : null,
            poster,
            normalizedTitle: cleanTitle(title)
        };
    } catch (error) {
        console.error(`[MKVDrama] Browser slug fallback failed for ${url}: ${error.message}`);
        return null;
    } finally {
        if (browser) {
            await browser.close().catch(() => {});
        }
    }
}

/**
 * Fetch download links from the MKVDrama encrypted download API.
 * Returns download links in the same format as collectDownloadLinks().
 */
async function fetchDownloadApiLinks(postUrl, html, signal = null) {
    const apiInfo = extractDownloadApiInfoFromHtml(html);
    if (!apiInfo) return [];

    const { token, apiPath } = apiInfo;
    const csrf = extractCsrfToken(html);
    const apiUrl = `${BASE_URL}${apiPath}`;
    const passwordCandidates = html
        ? extractCommentPasswordCandidates(cheerio.load(html))
        : [];

    console.log(`[MKVDrama] Calling download API: ${apiPath}`);

    const httpAttemptPromise = (async () => {
        const axiosConfig = {
            method: 'POST',
            url: apiUrl,
            data: { t: token },
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Referer': postUrl,
                'Origin': BASE_URL,
                'User-Agent': USER_AGENTS[0]
            },
            timeout: 15000,
            validateStatus: (s) => s < 500,
            signal
        };

        if (csrf) {
            axiosConfig.headers['X-CSRF-Token'] = csrf;
        }

        const proxyAgent = getMkvDramaDirectProxyAgent();
        if (proxyAgent) {
            axiosConfig.httpAgent = proxyAgent;
            axiosConfig.httpsAgent = proxyAgent;
            axiosConfig.proxy = false;
        }

        const domain = (() => { try { return new URL(postUrl).hostname; } catch { return null; } })();
        const cached = await getCachedCfCookies(domain);
        if (cached?.cookies) {
            axiosConfig.headers['Cookie'] = cached.cookies;
            if (cached.userAgent) axiosConfig.headers['User-Agent'] = cached.userAgent;
        } else if (MKVDRAMA_COOKIE) {
            axiosConfig.headers['Cookie'] = MKVDRAMA_COOKIE;
        }

        let resp = null;
        let usedRotatingProxy = false;

        if (MKVDRAMA_DIRECT_PROXY_URL && Date.now() < fixedProxyBlockedUntil) {
            console.log(`[MKVDrama] Skipping fixed proxy for download API (cooldown active)`);
        } else if (MKVDRAMA_DIRECT_PROXY_URL) {
            try {
                const activeProxyAgent = getMkvDramaDirectProxyAgent();
                if (activeProxyAgent) {
                    resp = await axios.request({
                        ...axiosConfig,
                        httpAgent: activeProxyAgent,
                        httpsAgent: activeProxyAgent,
                        proxy: false
                    });
                }
            } catch (fixedProxyError) {
                if (MKVDRAMA_SOCKS5_ROTATION_ENABLED) {
                    fixedProxyBlockedUntil = Date.now() + FIXED_PROXY_BLOCK_TTL_MS;
                    console.warn(`[MKVDrama] Fixed proxy ${MKVDRAMA_DIRECT_PROXY_URL} failed for download API ${apiPath}: ${fixedProxyError.message}, skipping for ${FIXED_PROXY_BLOCK_TTL_MS / 1000}s`);
                } else {
                    throw fixedProxyError;
                }
            }
        }

        const shouldUseRotatingProxy = (!resp || resp.status >= 400) && MKVDRAMA_SOCKS5_ROTATION_ENABLED;
        if (shouldUseRotatingProxy) {
            const fixedProxyBlocked = resp && (resp.status === 403 || resp.status === 429 || resp.status === 503);
            if (fixedProxyBlocked && MKVDRAMA_DIRECT_PROXY_URL) {
                fixedProxyBlockedUntil = Date.now() + FIXED_PROXY_BLOCK_TTL_MS;
                console.warn(`[MKVDrama] Fixed proxy ${MKVDRAMA_DIRECT_PROXY_URL} returned ${resp.status} for download API ${apiPath}, skipping for ${FIXED_PROXY_BLOCK_TTL_MS / 1000}s`);
            }
            const rotated = await socks5ProxyRotator.requestWithRotation(
                axiosConfig,
                { maxRetries: MKVDRAMA_API_SOCKS5_MAX_RETRIES }
            );
            resp = rotated.response;
            usedRotatingProxy = true;
        }

        if (!resp) {
            // Never use direct connection for MKVDrama — always require a proxy
            throw new Error('No proxy available for MKVDrama download API (fixed proxy down and SOCKS5 rotation disabled)');
        }

        if (resp.status !== 200 || !resp.data?.d) {
            console.log(`[MKVDrama] Download API returned ${resp.status} for ${apiPath}${usedRotatingProxy ? ' via rotating proxy' : ''}`);
            return [];
        }

        const decrypted = decryptDownloadResponse(resp.data, token);
        if (!decrypted?.download_sections?.length) {
            console.log(`[MKVDrama] Download API returned no sections for ${apiPath}`);
            return [];
        }

        const downloadLinks = attachPasswordCandidates(
            mapDownloadSectionsToLinks(decrypted.download_sections),
            passwordCandidates
        );
        console.log(`[MKVDrama] Download API returned ${downloadLinks.length} links from ${decrypted.download_sections.length} sections`);
        return downloadLinks;
    })().catch((err) => {
        console.error(`[MKVDrama] Download API call failed: ${err.message}`);
        return [];
    });

    const links = await httpAttemptPromise;
    return links;
}

function mergeCookieHeader(existing = '', setCookieHeader = '') {
    const cookieMap = new Map();

    const applyCookie = (raw = '') => {
        const value = String(raw || '').split(';')[0].trim();
        if (!value) return;
        const idx = value.indexOf('=');
        if (idx <= 0) return;
        cookieMap.set(value.slice(0, idx), value.slice(idx + 1));
    };

    String(existing || '').split(';').forEach(part => applyCookie(part));
    (Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader]).forEach(part => applyCookie(part));

    return Array.from(cookieMap.entries())
        .map(([name, value]) => `${name}=${value}`)
        .join('; ');
}

function extractDynamicApiInfoFromHtml(html = '') {
    const body = String(html || '');
    if (!body) return null;

    const dataPathMatch = body.match(/data-k=["']([^"']+)["']/i);
    const guardKeyMatch = body.match(/data-k3=["']([^"']+)["']/i);
    const dataPath = dataPathMatch?.[1] || '';
    const guardKey = guardKeyMatch?.[1] || '';

    if (!dataPath || !guardKey) return null;
    return { dataPath, guardKey };
}

function buildDynamicAuthPath(dataPath = '') {
    const normalized = String(dataPath || '').trim();
    if (!normalized) return null;

    const path = normalized.startsWith('/') ? normalized : `/${normalized}`;
    if (path.endsWith('/_l_krc_uo')) {
        return `${path.slice(0, -10)}/oe_pq_invxe_l`;
    }
    if (path.endsWith('/')) return `${path}oe_pq_invxe_l`;
    return `${path}/oe_pq_invxe_l`;
}

function decryptDynamicPayloadToHtml(encData, dataPath = '') {
    if (!encData?.d || !encData?.s || !dataPath) return '';

    try {
        const normalizedPath = dataPath.startsWith('/') ? dataPath : `/${dataPath}`;
        const material = `access-payload:${normalizedPath}`;
        const key = crypto.createHash('sha256').update(material).digest();
        const iv = Buffer.from(encData.s, 'hex');
        const raw = Buffer.from(encData.d, 'base64');
        const authTag = raw.subarray(raw.length - 16);
        const ciphertext = raw.subarray(0, raw.length - 16);

        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(authTag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch (error) {
        console.log(`[MKVDrama] Dynamic payload decrypt failed: ${error.message}`);
        return '';
    }
}

async function fetchDynamicProtectedLinks(postUrl, html, signal = null) {
    if (!postUrl || signal?.aborted) return [];

    const fallbackApiInfo = extractDynamicApiInfoFromHtml(html);
    if (!fallbackApiInfo) return [];

    const proxyAgent = getMkvDramaDirectProxyAgent();
    if (!proxyAgent) {
        // For mkvdrama dynamic API we avoid direct (non-proxy) calls.
        return [];
    }

    const origin = (() => {
        try { return new URL(postUrl).origin; } catch { return BASE_URL; }
    })();

    const passwordCandidates = html
        ? extractCommentPasswordCandidates(cheerio.load(html))
        : [];

    try {
        const pageResp = await axios.get(postUrl, {
            headers: {
                'User-Agent': USER_AGENTS[0],
                'Accept': 'text/html,application/xhtml+xml'
            },
            timeout: 20000,
            validateStatus: () => true,
            signal,
            httpAgent: proxyAgent,
            httpsAgent: proxyAgent,
            proxy: false
        });

        if (pageResp.status >= 400) {
            return [];
        }

        let cookieHeader = mergeCookieHeader('', pageResp.headers?.['set-cookie']);
        const pageHtml = typeof pageResp.data === 'string'
            ? pageResp.data
            : JSON.stringify(pageResp.data || {});
        const apiInfo = extractDynamicApiInfoFromHtml(pageHtml) || fallbackApiInfo;
        if (!apiInfo?.dataPath || !apiInfo?.guardKey) {
            return [];
        }

        const dataPath = apiInfo.dataPath.startsWith('/') ? apiInfo.dataPath : `/${apiInfo.dataPath}`;
        const authPath = buildDynamicAuthPath(dataPath);
        const apiUrl = normalizeUrl(dataPath, BASE_URL);
        const authUrl = normalizeUrl(authPath, BASE_URL);
        if (!apiUrl || !authUrl) {
            return [];
        }

        const requestHeaders = () => ({
            'User-Agent': USER_AGENTS[0],
            'Accept': 'application/json, text/plain, */*',
            'Content-Type': 'application/json',
            'Origin': origin,
            'Referer': postUrl,
            ...(cookieHeader ? { 'Cookie': cookieHeader } : {})
        });

        const step1Payloads = [
            { r: null, i: false, w: false, [apiInfo.guardKey]: '' },
            { r: null, i: true, w: false, [apiInfo.guardKey]: '' }
        ];

        let step1Ok = false;
        for (const payload of step1Payloads) {
            const step1Resp = await axios.post(apiUrl, payload, {
                headers: requestHeaders(),
                timeout: 20000,
                validateStatus: () => true,
                signal,
                httpAgent: proxyAgent,
                httpsAgent: proxyAgent,
                proxy: false
            });
            cookieHeader = mergeCookieHeader(cookieHeader, step1Resp.headers?.['set-cookie']);
            if ([200, 201, 202, 204].includes(step1Resp.status)) {
                step1Ok = true;
                break;
            }
        }

        if (!step1Ok) {
            return [];
        }

        const step2Resp = await axios.post(authUrl, {
            r: null,
            w: false,
            [apiInfo.guardKey]: ''
        }, {
            headers: requestHeaders(),
            timeout: 20000,
            validateStatus: () => true,
            signal,
            httpAgent: proxyAgent,
            httpsAgent: proxyAgent,
            proxy: false
        });
        cookieHeader = mergeCookieHeader(cookieHeader, step2Resp.headers?.['set-cookie']);

        if (step2Resp.status !== 200 || !step2Resp.data?.d || !step2Resp.data?.s) {
            return [];
        }

        const dynamicHtml = decryptDynamicPayloadToHtml(step2Resp.data, dataPath);
        if (!dynamicHtml) {
            return [];
        }

        const dynamic$ = cheerio.load(dynamicHtml);
        let links = collectDownloadLinks(dynamic$, dynamic$('.soraddlx, .soraddl, .soradd'));
        if (links.length === 0) {
            links = collectLooseOuoLinks(dynamic$, dynamic$('article, .entry-content, .post-content, body'), '');
        }
        if (links.length === 0) {
            links = collectEncodedLinks(dynamic$, dynamic$('body'), '');
        }

        if (links.length > 0 && passwordCandidates.length > 0) {
            links = attachPasswordCandidates(links, passwordCandidates);
        }

        if (links.length > 0) {
            console.log(`[MKVDrama] Dynamic API returned ${links.length} links for ${postUrl}`);
        }
        return links;
    } catch (error) {
        console.log(`[MKVDrama] Dynamic API fetch failed for ${postUrl}: ${error.message}`);
        return [];
    }
}

/**
 * Check if the page has placeholder links (href="#" or href="javascript:")
 * This indicates the page was rendered without JavaScript and needs FlareSolverr
 */
function hasPlaceholderLinks($) {
    let placeholderCount = 0;
    let realLinkCount = 0;

    // Check links in download sections
    $('.soraddlx, .soraddl, .soradd, .soraurlx, .soraurl').find('a[href]').each((_, el) => {
        const href = $(el).attr('href') || '';
        if (href === '#' || href === '' || href.startsWith('javascript:')) {
            // Some pages embed the real shortlink in a base64 data attribute (e.g. data-kp2v).
            const decoded = decodeMkvDramaDataUrl($, el);
            if (decoded && isDownloadLink(decoded)) {
                realLinkCount++;
            } else {
                placeholderCount++;
            }
            return;
        }
        if (isDownloadLink(href)) realLinkCount++;
    });

    // Also check loose links in content area
    $('.entry-content, .post-content, article').find('a[href]').each((_, el) => {
        const href = $(el).attr('href') || '';
        if (href === '#' || href === '' || href.startsWith('javascript:')) {
            // Only count if it looks like a download button
            const text = $(el).text().toLowerCase();
            if (text.includes('download') || text.includes('pixeldrain') || text.includes('gofile')) {
                placeholderCount++;
            }
        }
    });

    // If we found placeholders but no real links, the page needs JS rendering
    const hasPlaceholders = placeholderCount > 0 && realLinkCount === 0;
    if (hasPlaceholders) {
        console.log(`[MKVDrama] Detected ${placeholderCount} placeholder links, ${realLinkCount} real links - needs FlareSolverr`);
    }
    return hasPlaceholders;
}

function collectDownloadLinks($, scope) {
    const downloadLinks = [];
    const seen = new Set();

    const addLink = (entry) => {
        if (!entry?.url || seen.has(entry.url)) return;
        seen.add(entry.url);
        downloadLinks.push(entry);
    };

    scope.each((_, el) => {
        const block = $(el);
        const episodeLabel = cleanText(block.find('.sorattlx, .sorattl, .soratt, h3, h4').first().text());
        const season = parseSeasonNumber(episodeLabel);
        const episodeRange = parseEpisodeRange(episodeLabel);

        block.find('.soraurlx, .soraurl').each((__, linkBox) => {
            const $box = $(linkBox);
            const quality = cleanText($box.find('strong, b').first().text());

            $box.find('a[href]').each((___, link) => {
                const href = $(link).attr('href');
                let absolute = normalizeUrl(href, BASE_URL);
                if (!absolute || href === '#' || href === '' || href.startsWith('javascript:')) {
                    const decoded = decodeMkvDramaDataUrl($, link);
                    if (decoded) {
                        absolute = normalizeUrl(decoded, BASE_URL);
                    }
                }
                if (!absolute || !isDownloadLink(absolute)) return;

                const host = getHostFromElement($, link) || normalizeHostName($(link).text());

                addLink({
                    url: absolute,
                    label: episodeLabel,
                    quality,
                    linkText: cleanText($(link).text()),
                    host,
                    episodeStart: episodeRange?.start ?? null,
                    episodeEnd: episodeRange?.end ?? null,
                    season
                });
            });
        });
    });

    return downloadLinks;
}

function collectLooseOuoLinks($, scope, fallbackLabel = '') {
    const downloadLinks = [];
    const seen = new Set();

    scope.find('a[href]').each((_, link) => {
        const href = $(link).attr('href') || '';
        let absolute = normalizeUrl(href, BASE_URL);
        if (!absolute || href === '#' || href === '' || href.startsWith('javascript:')) {
            const decoded = decodeMkvDramaDataUrl($, link);
            if (decoded) {
                absolute = normalizeUrl(decoded, BASE_URL);
            }
        }
        if (!absolute || !isDownloadLink(absolute) || seen.has(absolute)) return;
        seen.add(absolute);

        const container = $(link).closest('li, p, div').first();
        const label = cleanText(
            container.find('h1, h2, h3, h4, h5, strong, b').first().text()
        ) || fallbackLabel;
        const quality = cleanText(container.find('strong, b').first().text());
        const episodeRange = parseEpisodeRange(label);
        const season = parseSeasonNumber(label);
        const host = getHostFromElement($, link) || normalizeHostName($(link).text());

        downloadLinks.push({
            url: absolute,
            label,
            quality,
            linkText: cleanText($(link).text()),
            host,
            episodeStart: episodeRange?.start ?? null,
            episodeEnd: episodeRange?.end ?? null,
            season
        });
    });

    return downloadLinks;
}

function collectEpisodePostLinks($) {
    const candidates = [];
    const seen = new Set();

    const addCandidate = (title, url) => {
        if (!title || !url || seen.has(url)) return;
        seen.add(url);
        const episodeRange = parseEpisodeRange(title);
        const season = parseSeasonNumber(title);
        candidates.push({
            title,
            url,
            episodeStart: episodeRange?.start ?? null,
            episodeEnd: episodeRange?.end ?? null,
            season
        });
    };

    const selectors = [
        'h2[itemprop="headline"] a[href]',
        'h2.entry-title a[href]',
        'article h2 a[href]',
        'a[rel="bookmark"]'
    ];

    selectors.forEach((selector) => {
        $(selector).each((_, el) => {
            const anchor = $(el);
            const title = cleanText(anchor.text() || anchor.attr('title'));
            const url = normalizeUrl(anchor.attr('href'));
            addCandidate(title, url);
        });
    });

    $('.tt').each((_, el) => {
        const block = $(el);
        const title = cleanText(block.find('h2, b').first().text());
        let anchor = block.find('a[href]').first();
        if (!anchor.length) anchor = block.closest('a[href]');
        if (!anchor.length) anchor = block.parent().find('a[href]').first();
        const url = normalizeUrl(anchor.attr('href'));
        addCandidate(title, url);
    });

    return candidates;
}

function matchesEpisodeEntry(entry, season, episode) {
    if (!episode) return true;
    const seasonNumber = season ? parseInt(season, 10) : null;
    const episodeNumber = parseInt(episode, 10);
    if (Number.isNaN(episodeNumber)) return true;
    if (entry.season && seasonNumber && entry.season !== seasonNumber) return false;
    if (entry.episodeStart && entry.episodeEnd) {
        return episodeNumber >= entry.episodeStart && episodeNumber <= entry.episodeEnd;
    }
    return false;
}

function findEpisodePost($, season, episode) {
    if (!episode) return null;
    const candidates = collectEpisodePostLinks($);
    const match = candidates.find((entry) => matchesEpisodeEntry(entry, season, episode));
    if (match) return match;

    const episodeNumber = parseInt(episode, 10);
    if (Number.isNaN(episodeNumber)) return null;
    const episodeRegex = new RegExp(`\\b(ep(?:isode)?\\s*0*${episodeNumber}\\b|e0*${episodeNumber}\\b|s\\d{1,2}e0*${episodeNumber}\\b)`, 'i');
    return candidates.find((entry) => episodeRegex.test(entry.title)) || null;
}

function hasExactEpisodeMatch(downloadLinks, season, episode) {
    if (!episode) return false;
    const episodeNumber = parseInt(episode, 10);
    if (Number.isNaN(episodeNumber)) return false;
    const seasonNumber = season ? parseInt(season, 10) : null;
    return downloadLinks.some((entry) => {
        if (entry.episodeStart === null || entry.episodeEnd === null) return false;
        if (entry.episodeStart !== episodeNumber || entry.episodeEnd !== episodeNumber) return false;
        if (entry.season && seasonNumber && entry.season !== seasonNumber) return false;
        return true;
    });
}

/**
 * Convert a query string to a URL slug
 * "Burnout Syndrome" -> "burnout-syndrome"
 */
function toSlug(query) {
    return query
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '') // Remove special characters
        .replace(/\s+/g, '-')          // Replace spaces with hyphens
        .replace(/-+/g, '-')           // Collapse multiple hyphens
        .replace(/^-|-$/g, '');        // Trim leading/trailing hyphens
}

/**
 * Generate multiple URL patterns to try for a given slug
 * The mkvdrama site uses various URL formats:
 * - /{slug}/
 * - /series/{slug}/
 * - /download-{slug}/
 * - /download-drama-korea-{slug}/
 * - /download-korean-drama-{slug}/
 * - /download-kdrama-{slug}/
 * - /{slug}-korean-drama/
 * - /{slug}-kdrama/
 */
function generateSlugUrls(slug) {
    if (!slug) return [];
    return Array.from(new Set([
        `${BASE_URL}/${slug}`,
        `${BASE_URL}/${slug}/`,
        `${BASE_URL}/series/${slug}`,
        `${BASE_URL}/series/${slug}/`,
        `${BASE_URL}/titles/${slug}`,
        `${BASE_URL}/titles/${slug}/`,
        `${BASE_URL}/download-${slug}`,
        `${BASE_URL}/download-${slug}/`,
        `${BASE_URL}/download-drama-korea-${slug}`,
        `${BASE_URL}/download-drama-korea-${slug}/`,
        `${BASE_URL}/download-korean-drama-${slug}`,
        `${BASE_URL}/download-korean-drama-${slug}/`,
        `${BASE_URL}/download-kdrama-${slug}`,
        `${BASE_URL}/download-kdrama-${slug}/`,
        `${BASE_URL}/${slug}-korean-drama`,
        `${BASE_URL}/${slug}-korean-drama/`,
        `${BASE_URL}/${slug}-kdrama`,
        `${BASE_URL}/${slug}-kdrama/`
    ]));
}

/**
 * Try to fetch a single URL and validate it has content
 * Returns page info if valid, null otherwise
 */
async function tryFetchSlugUrl(url, signal = null) {
    try {
        const $ = await fetchPage(url, signal);
        if (!$) {
            return await tryFetchSlugUrlWithBrowser(url, signal);
        }

        const jsonPayload = extractJsonPayloadFromDocument($);
        if (jsonPayload) {
            if (isMkvDramaNotFoundDetail(jsonPayload.detail || jsonPayload.message)) {
                return null;
            }
            const jsonResult = extractSlugResultFromJsonPayload(jsonPayload, url);
            if (jsonResult) {
                return jsonResult;
            }
            return null;
        }

        // Check if this is a valid content page (has a title and content)
        let title = cleanText($('h1.entry-title').text()) || cleanText($('title').text()) || '';
        title = title.replace(/\s*\|\s*MkvDrama.*$/i, '').trim();

        if (!title || isMkvDramaNotFoundTitle(title)) {
            return await tryFetchSlugUrlWithBrowser(url, signal);
        }

        // Check for download links/content markers. Generic entry-content containers can be 404 templates.
        const hasContent = hasMkvDramaDownloadMarkers($);
        if (!hasContent) {
            return await tryFetchSlugUrlWithBrowser(url, signal);
        }

        const yearMatch = title.match(/\b(19|20)\d{2}\b/);
        const poster = $('img.wp-post-image').attr('data-lazy-src') ||
                       $('img.wp-post-image').attr('src') ||
                       $('.thumb img').attr('data-lazy-src') ||
                       $('.thumb img').attr('src') || null;

        return {
            title,
            url,
            year: yearMatch ? parseInt(yearMatch[0], 10) : null,
            poster,
            normalizedTitle: cleanTitle(title)
        };
    } catch (error) {
        return null;
    }
}

/**
 * Try to fetch a direct slug URL and extract page info
 * Tries multiple URL patterns that mkvdrama uses
 */
async function tryDirectSlugUrl(query, signal = null) {
    const slug = toSlug(query);
    if (!slug) return null;

    const urls = generateSlugUrls(slug);
    const urlsToTry = urls.slice(0, MKVDRAMA_MAX_SLUG_PATTERNS);
    const start = Date.now();
    console.log(`[MKVDrama] Trying ${urlsToTry.length}/${urls.length} direct slug URL patterns for "${query}" (max ${MKVDRAMA_SLUG_FALLBACK_TIMEOUT_MS}ms)`);

    for (const url of urlsToTry) {
        if (Date.now() - start >= MKVDRAMA_SLUG_FALLBACK_TIMEOUT_MS) {
            console.log(`[MKVDrama] Stopping direct slug fallback due to timeout (${MKVDRAMA_SLUG_FALLBACK_TIMEOUT_MS}ms)`);
            break;
        }
        console.log(`[MKVDrama] Trying: ${url}`);
        const result = await tryFetchSlugUrl(url, signal);
        if (result) {
            console.log(`[MKVDrama] Found content via direct slug: "${result.title}" at ${url}`);
            return result;
        }
    }

    console.log(`[MKVDrama] No content found via direct slug patterns`);
    return null;
}

// Cache TTLs for search and content
const SEARCH_CACHE_TTL = 2 * 60 * 60 * 1000; // 2 hours
const CONTENT_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

// Exported for unit testing
export { parseEpisodeRange };

export async function scrapeMkvDramaSearch(query, signal = null) {
    if (!query) return [];

    const cleanQuery = query.replace(/:/g, '').replace(/\s+/g, ' ').trim();

    // Check cache first - saves 45-90 seconds on repeat searches
    const searchCacheKey = `mkvdrama-search:${cleanQuery.toLowerCase()}`;
    if (MKVDRAMA_RESULT_CACHE_ENABLED) {
        try {
            const cached = await getDbCached(searchCacheKey, SEARCH_CACHE_TTL);
            if (cached?.results?.length > 0) {
                console.log(`[MKVDrama] Using cached search results for "${cleanQuery}" (${cached.results.length} results)`);
                return cached.results;
            }
        } catch (e) {
            // Cache miss, continue with search
        }
    }

    const searchUrl = `${BASE_URL}/search?q=${encodeURIComponent(cleanQuery)}`;

    console.log(`[MKVDrama] Search query: "${cleanQuery}", URL: ${searchUrl}`);

    try {
        const deferDirectSlugUntilNeeded = MKVDRAMA_DISCOVERY_ALLOW_BYPARR && !!BYPARR_URL;
        let directSlugPromise = (!deferDirectSlugUntilNeeded && MKVDRAMA_SLUG_FALLBACK_ENABLED)
            ? tryDirectSlugUrl(cleanQuery, signal)
            : null;
        let directSlugSettled = false;
        let directSlugResult = null;
        const resolveDirectSlug = async () => {
            if (!MKVDRAMA_SLUG_FALLBACK_ENABLED) return null;
            if (!directSlugPromise) {
                directSlugPromise = tryDirectSlugUrl(cleanQuery, signal);
            }
            if (!directSlugSettled) {
                directSlugResult = await directSlugPromise;
                directSlugSettled = true;
            }
            return directSlugResult;
        };

        // Avoid FlareSolverr for search pages when possible: search is high fanout and expensive.
        // 1) try direct (optionally via socks proxy) without FlareSolverr
        // 2) if blocked, try slug fallback patterns
        // 3) only then allow FlareSolverr for search, as a last resort
        const searchPromise = fetchPage(searchUrl, signal, {
            skipFlareSolverr: !MKVDRAMA_SEARCH_ALLOW_FLARESOLVERR
        });
        let $ = null;

        if (directSlugPromise) {
            const first = await Promise.race([
                searchPromise.then(result => ({ source: 'search', result })),
                directSlugPromise.then(result => ({ source: 'slug', result }))
            ]);

            if (first.source === 'slug') {
                directSlugSettled = true;
                directSlugResult = first.result;
                if (directSlugResult) {
                    console.log(`[MKVDrama] Direct slug won the race for "${cleanQuery}"`);
                    return [directSlugResult];
                }
                $ = await searchPromise;
            } else {
                $ = first.result;
            }
        } else {
            $ = await searchPromise;
        }

        if (!$) {
            if (MKVDRAMA_SLUG_FALLBACK_ENABLED) {
                console.log(`[MKVDrama] fetchPage returned null for search, trying direct slug...`);
                // Search page failed, try direct slug as fallback
                const directResult = await resolveDirectSlug();
                console.log(`[MKVDrama] Direct slug result: ${directResult ? directResult.title : 'null'}`);
                if (directResult) return [directResult];
            }
            if (
                MKVDRAMA_FLARESOLVERR_ENABLED &&
                MKVDRAMA_DISCOVERY_ALLOW_FLARESOLVERR &&
                MKVDRAMA_SEARCH_ALLOW_FLARESOLVERR &&
                FLARESOLVERR_URL
            ) {
                console.log(`[MKVDrama] Search + slug failed, allowing FlareSolverr for search (enabled by MKVDRAMA_SEARCH_ALLOW_FLARESOLVERR=true)...`);
                $ = await fetchPage(searchUrl, signal);
                if (!$) return [];
            } else {
                return [];
            }
        }
        const results = parseMkvDramaSearchResults($);

        // If search returned no results, try direct slug URL as fallback
        if (results.length === 0) {
            if (MKVDRAMA_SLUG_FALLBACK_ENABLED) {
                console.log(`[MKVDrama] Search returned no results, trying direct slug URL...`);
                const directResult = await resolveDirectSlug();
                if (directResult) {
                    console.log(`[MKVDrama] Direct slug found: "${directResult.title}" at ${directResult.url}`);
                    results.push(directResult);
                } else {
                    console.log(`[MKVDrama] Direct slug also returned no results`);
                }
            }
        }

        // Cache successful search results for 2 hours
        if (results.length > 0 && MKVDRAMA_RESULT_CACHE_ENABLED) {
            setDbCache(searchCacheKey, { results }, SEARCH_CACHE_TTL).catch(() => {});
        }

        return results;
    } catch (error) {
        console.error(`[MKVDrama] Search failed for "${query}": ${error.message}`);
        // Try direct slug as last resort
        const directResult = await tryDirectSlugUrl(cleanQuery, signal);
        return directResult ? [directResult] : [];
    }
}

export async function loadMkvDramaContent(postUrl, signal = null, options = {}) {
    if (!postUrl) return { title: '', downloadLinks: [] };
    const depth = options?.depth ?? 0;
    const skipFlareSolverr = options?.skipFlareSolverr ?? !MKVDRAMA_DISCOVERY_ALLOW_FLARESOLVERR;

    // Check content cache first - saves 45-90 seconds on repeat views
    let contentCacheKey;
    if (MKVDRAMA_RESULT_CACHE_ENABLED) {
        try {
            const urlPath = new URL(postUrl).pathname;
            contentCacheKey = `mkvdrama-content:${urlPath}`;
            const cached = await getDbCached(contentCacheKey, CONTENT_CACHE_TTL);
            if (cached?.downloadLinks?.length > 0) {
                const hasProtectedLinks = cached.downloadLinks.some(entry => isMkvDramaProtectedLink(entry?.url));
                if (!hasProtectedLinks) {
                    console.log(`[MKVDrama] Using cached content for ${postUrl} (${cached.downloadLinks.length} links)`);
                    return cached;
                }
                console.log(`[MKVDrama] Skipping cached protected links for ${postUrl}, refreshing live links`);
            }
        } catch (e) {
            // Cache miss, continue with fetch
        }
    }

    try {
        // Prefer direct (optionally via socks proxy) and only consider FlareSolverr if we cannot
        // extract any links and the page appears to have JS-only placeholders.
        let $ = await fetchPage(postUrl, signal, { skipFlareSolverr });
        for (let pass = 0; pass < 1; pass++) {
            if (!$) {
                const domain = (() => { try { return new URL(postUrl).hostname; } catch { return null; } })();
                const blockedReason = domain ? (getMkvDramaLastBlock(domain)?.reason || null) : null;
                return { title: '', downloadLinks: [], blockedReason };
            }

            let title = cleanText($('h1.entry-title').text()) || cleanText($('title').text()) || '';
            title = title.replace(/\s*\|\s*MkvDrama.*$/i, '').trim();
            const passwordCandidates = extractCommentPasswordCandidates($);

            let downloadLinks = collectDownloadLinks($, $('.soraddlx, .soraddl, .soradd'));

            if (downloadLinks.length === 0) {
                $('.sorattlx, .sorattl, .soratt').each((_, el) => {
                    const episodeLabel = cleanText($(el).text());
                    const season = parseSeasonNumber(episodeLabel);
                    const episodeRange = parseEpisodeRange(episodeLabel);
                    const linkBox = $(el).nextAll('.soraurlx, .soraurl').first();
                    if (!linkBox.length) return;

                    const quality = cleanText(linkBox.find('strong, b').first().text());
                    linkBox.find('a[href]').each((__, link) => {
                        const href = $(link).attr('href');
                        let absolute = normalizeUrl(href, BASE_URL);
                        if (!absolute || href === '#' || href === '' || href.startsWith('javascript:')) {
                            const decoded = decodeMkvDramaDataUrl($, link);
                            if (decoded) absolute = normalizeUrl(decoded, BASE_URL);
                        }
                        if (!absolute || !isDownloadLink(absolute)) return;

                        downloadLinks.push({
                            url: absolute,
                            label: episodeLabel,
                            quality,
                            linkText: cleanText($(link).text()),
                            episodeStart: episodeRange?.start ?? null,
                            episodeEnd: episodeRange?.end ?? null,
                            season
                        });
                    });
                });
            }

            if (downloadLinks.length > 0) {
                const titleEpisodeRange = parseEpisodeRange(title);
                const titleSeason = parseSeasonNumber(title);
                if (titleEpisodeRange || titleSeason) {
                    downloadLinks = downloadLinks.map((entry) => {
                        if (entry.episodeStart || entry.episodeEnd || entry.season) return entry;
                        return {
                            ...entry,
                            episodeStart: titleEpisodeRange?.start ?? null,
                            episodeEnd: titleEpisodeRange?.end ?? null,
                            season: titleSeason ?? null
                        };
                    });
                }
            }

            if (options?.episode && depth < 1) {
                const hasExact = hasExactEpisodeMatch(downloadLinks, options?.season, options?.episode);
                if (!hasExact) {
                    const episodePost = findEpisodePost($, options?.season, options?.episode);
                    if (episodePost?.url && episodePost.url !== postUrl) {
                        const nested = await loadMkvDramaContent(episodePost.url, signal, {
                            ...options,
                            depth: depth + 1,
                            skipFlareSolverr
                        });
                        const nestedHasExact = hasExactEpisodeMatch(nested.downloadLinks || [], options?.season, options?.episode);
                        if (nested.downloadLinks.length && (nestedHasExact || downloadLinks.length === 0)) {
                            return nested;
                        }
                        if (nested.title && !title) {
                            title = nested.title;
                        }
                        if (downloadLinks.length === 0) {
                            downloadLinks = nested.downloadLinks;
                        }
                    }
                }
            }

            if (downloadLinks.length === 0) {
                downloadLinks = collectLooseOuoLinks($, $('article, .entry-content, .post-content, body'), title);
            }

            if (downloadLinks.length === 0) {
                downloadLinks = collectEncodedLinks($, $('body'), title);
            }

            // Try dynamic protected API flow (data-k / data-k3 + encrypted HTML fragment)
            if (downloadLinks.length === 0) {
                const dynamicLinks = await fetchDynamicProtectedLinks(postUrl, $.html(), signal);
                if (dynamicLinks.length > 0) {
                    downloadLinks = dynamicLinks;
                }
            }

            // Try the encrypted download API (new MKVDrama site 2025+)
            if (downloadLinks.length === 0) {
                const apiInfo = extractDownloadApiInfo($);
                if (apiInfo) {
                    const rawHtml = $.html();
                    const apiLinks = await fetchDownloadApiLinks(postUrl, rawHtml, signal);
                    if (apiLinks.length > 0) {
                        downloadLinks = apiLinks;
                    }
                }
            }

            if (downloadLinks.length > 0 && passwordCandidates.length > 0) {
                downloadLinks = attachPasswordCandidates(downloadLinks, passwordCandidates);
            }

            const missingPasswordHints = downloadLinks.length > 0 &&
                collectPasswordCandidates(downloadLinks).length === 0;

            const result = { title, downloadLinks };

            // Cache content with download links for 24 hours
            if (downloadLinks.length > 0 && contentCacheKey && MKVDRAMA_RESULT_CACHE_ENABLED) {
                const hasProtectedLinks = downloadLinks.some(entry => isMkvDramaProtectedLink(entry?.url));
                if (!hasProtectedLinks) {
                    setDbCache(contentCacheKey, result, CONTENT_CACHE_TTL).catch(() => {});
                    console.log(`[MKVDrama] Cached content for ${postUrl} (${downloadLinks.length} links)`);
                } else {
                    console.log(`[MKVDrama] Not caching protected _c links for ${postUrl}`);
                }
            }

            return result;
        }

        const domain = (() => { try { return new URL(postUrl).hostname; } catch { return null; } })();
        const blockedReason = domain ? (getMkvDramaLastBlock(domain)?.reason || null) : null;
        return { title: '', downloadLinks: [], blockedReason };
    } catch (error) {
        console.error(`[MKVDrama] Failed to load post ${postUrl}: ${error.message}`);
        const domain = (() => { try { return new URL(postUrl).hostname; } catch { return null; } })();
        const blockedReason = domain ? (getMkvDramaLastBlock(domain)?.reason || null) : null;
        return { title: '', downloadLinks: [], blockedReason };
    }
}
