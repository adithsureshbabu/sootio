import axios from 'axios';
import * as cheerio from 'cheerio';
import * as config from '../../config.js';
import { getHashFromMagnet, sizeToBytes } from '../../common/torrent-utils.js';
import { exec } from 'child_process';
import { promisify } from 'util';

// Import scraper utilities
import { createTimerLabel } from '../utils/timing.js';
import { detectSimpleLangs } from '../utils/filtering.js';
import { processAndDeduplicate } from '../utils/deduplication.js';
import { handleScraperError } from '../utils/error-handling.js';
import { generateScraperCacheKey } from '../utils/cache.js';
import * as SqliteCache from '../../util/cache-store.js';

// Keep a stable reference to env config for fallbacks when user config is partial
const ENV = config;

const execPromise = promisify(exec);
const inFlightRequests = new Map();

// Session cache for FlareSolverr - reuses browser sessions to avoid TLS fingerprint issues
const sessionCache = new Map();
const SESSION_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// Cookie cache - persists cf_clearance cookie to SQLite to avoid FlareSolverr on every request
// Cloudflare cookies typically last 15-30 minutes
const COOKIE_CACHE_SERVICE = 'cf_cookie';
const COOKIE_CACHE_TTL = 25 * 60 * 1000; // 25 minutes (conservative)

/**
 * Get or create a FlareSolverr session for a domain
 * @param {string} flareSolverrUrl - FlareSolverr URL
 * @param {string} domain - Domain to get session for
 * @param {string} logPrefix - Log prefix
 * @returns {Promise<string|null>} - Session ID or null
 */
async function getOrCreateSession(flareSolverrUrl, domain, logPrefix) {
    // Use a deterministic session ID so all workers share the same FlareSolverr browser
    const sessionId = `sootio_extto_${domain.replace(/\./g, '_')}`;

    const cached = sessionCache.get(domain);
    if (cached && (Date.now() - cached.timestamp) < SESSION_CACHE_TTL) {
        return cached.sessionId;
    }

    // Check if session already exists on FlareSolverr (created by another worker)
    try {
        const listResponse = await axios.post(`${flareSolverrUrl}/v1`, {
            cmd: 'sessions.list'
        }, {
            timeout: 10000,
            headers: { 'Content-Type': 'application/json' }
        });

        if (listResponse.data?.sessions?.includes(sessionId)) {
            // Session exists, cache it locally and reuse
            sessionCache.set(domain, { sessionId, timestamp: Date.now() });
            console.log(`[${logPrefix} SCRAPER] ExtTo reusing existing FlareSolverr session: ${sessionId}`);
            return sessionId;
        }
    } catch (error) {
        // Ignore list errors, try to create
    }

    // Create new session
    try {
        const response = await axios.post(`${flareSolverrUrl}/v1`, {
            cmd: 'sessions.create',
            session: sessionId
        }, {
            timeout: 30000,
            headers: { 'Content-Type': 'application/json' }
        });

        if (response.data?.status === 'ok') {
            sessionCache.set(domain, { sessionId, timestamp: Date.now() });
            console.log(`[${logPrefix} SCRAPER] ExtTo created FlareSolverr session: ${sessionId}`);
            return sessionId;
        }
    } catch (error) {
        // Session might already exist (race with another worker), check if we can use it
        if (error.response?.data?.message?.includes('already exists')) {
            sessionCache.set(domain, { sessionId, timestamp: Date.now() });
            console.log(`[${logPrefix} SCRAPER] ExtTo using existing FlareSolverr session: ${sessionId}`);
            return sessionId;
        }
        console.log(`[${logPrefix} SCRAPER] ExtTo failed to create session: ${error.message}`);
    }
    return null;
}

/**
 * Destroy a FlareSolverr session
 * @param {string} flareSolverrUrl - FlareSolverr URL
 * @param {string} sessionId - Session ID to destroy
 */
async function destroySession(flareSolverrUrl, sessionId) {
    try {
        await axios.post(`${flareSolverrUrl}/v1`, {
            cmd: 'sessions.destroy',
            session: sessionId
        }, {
            timeout: 10000,
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (error) {
        // Ignore destroy errors
    }
}

/**
 * Get cached Cloudflare cookie from SQLite
 * @param {string} domain - Domain to get cookie for
 * @returns {Promise<{cfClearance: string, userAgent: string}|null>}
 */
async function getCachedCookie(domain) {
    try {
        const cacheKey = `${domain}_cf_cookie`;
        const result = await SqliteCache.getCachedRecord(COOKIE_CACHE_SERVICE, cacheKey);
        if (result?.data && result.data.cfClearance && result.data.userAgent) {
            // Check if cookie is still valid (within TTL)
            const age = Date.now() - (result.data.timestamp || 0);
            if (age < COOKIE_CACHE_TTL) {
                return result.data;
            }
        }
    } catch (error) {
        // Ignore cache errors
    }
    return null;
}

/**
 * Save Cloudflare cookie to SQLite for reuse
 * @param {string} domain - Domain the cookie is for
 * @param {string} cfClearance - The cf_clearance cookie value
 * @param {string} userAgent - The user agent used (must match for cookie to work)
 */
async function saveCookie(domain, cfClearance, userAgent) {
    try {
        const cacheKey = `${domain}_cf_cookie`;
        await SqliteCache.upsertCachedMagnet({
            service: COOKIE_CACHE_SERVICE,
            hash: cacheKey,
            data: {
                cfClearance,
                userAgent,
                timestamp: Date.now()
            }
        });
    } catch (error) {
        // Ignore cache errors
    }
}

/**
 * Extract cf_clearance cookie from FlareSolverr response cookies
 * @param {Array} cookies - Array of cookie objects from FlareSolverr
 * @returns {string|null} - cf_clearance value or null
 */
function extractCfClearance(cookies) {
    if (!Array.isArray(cookies)) return null;
    const cfCookie = cookies.find(c => c.name === 'cf_clearance');
    return cfCookie?.value || null;
}

/**
 * Fetch a page using FlareSolverr with session reuse
 * First request solves the challenge, subsequent requests reuse the session (fast)
 * Also extracts and saves cf_clearance cookie for future curl requests
 * @param {string} url - The URL to fetch
 * @param {string} flareSolverrUrl - The FlareSolverr service URL
 * @param {number} timeout - Request timeout in ms
 * @param {string} logPrefix - Logging prefix
 * @param {string|null} sessionId - Optional session ID to reuse
 * @returns {Promise<{html: string|null, sessionId: string|null}>}
 */
async function fetchWithFlareSolverr(url, flareSolverrUrl, timeout, logPrefix, sessionId = null) {
    try {
        // For session reuse, we need less time since challenge is already solved
        const flareSolverrTimeout = sessionId
            ? Math.max(timeout, 30000)  // 30s for session reuse
            : Math.max(timeout * 4, 60000); // 60s+ for fresh solve

        const requestBody = {
            cmd: 'request.get',
            url: url,
            maxTimeout: flareSolverrTimeout
        };

        // Add session if provided
        if (sessionId) {
            requestBody.session = sessionId;
        }

        const response = await axios.post(`${flareSolverrUrl}/v1`, requestBody, {
            timeout: flareSolverrTimeout + 5000,
            headers: { 'Content-Type': 'application/json' }
        });

        if (response.data?.status === 'ok' && response.data?.solution?.response) {
            const isSessionReuse = sessionId ? ' (session reuse)' : '';
            console.log(`[${logPrefix} SCRAPER] ExtTo FlareSolverr success${isSessionReuse}`);

            // Extract and save cf_clearance cookie for future curl requests
            const domain = new URL(url).hostname;
            const cfClearance = extractCfClearance(response.data.solution.cookies);
            const userAgent = response.data.solution.userAgent;
            if (cfClearance && userAgent) {
                await saveCookie(domain, cfClearance, userAgent);
                console.log(`[${logPrefix} SCRAPER] ExtTo saved cf_clearance cookie for ${domain}`);
            }

            return {
                html: response.data.solution.response,
                sessionId: sessionId // Return the session ID for reuse
            };
        }

        console.log(`[${logPrefix} SCRAPER] ExtTo FlareSolverr returned status: ${response.data?.status}`);

        // If session failed, it might be expired - clear it
        if (sessionId && response.data?.status !== 'ok') {
            const domain = new URL(url).hostname;
            sessionCache.delete(domain);
        }

        return { html: null, sessionId: null };
    } catch (error) {
        console.log(`[${logPrefix} SCRAPER] ExtTo FlareSolverr error: ${error.message}`);

        // Clear session on error
        if (sessionId) {
            const domain = new URL(url).hostname;
            sessionCache.delete(domain);
        }

        return { html: null, sessionId: null };
    }
}

/**
 * Fetch a page using curl with browser-like headers
 * Can use saved cf_clearance cookie to bypass Cloudflare without FlareSolverr
 * @param {string} url - The URL to fetch
 * @param {number} timeout - Request timeout in ms
 * @param {string} logPrefix - Logging prefix
 * @param {object|null} cookieData - Optional cookie data {cfClearance, userAgent}
 * @returns {Promise<string|null>} - HTML content or null on failure
 */
async function fetchWithCurl(url, timeout, logPrefix, cookieData = null) {
    try {
        // Use saved user agent if we have a cookie, otherwise use default
        const userAgent = cookieData?.userAgent || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0';
        const escapedUrl = url.replace(/'/g, "'\\''");

        // Build cookie header if we have a cf_clearance cookie
        const cookieHeader = cookieData?.cfClearance
            ? `-H 'Cookie: cf_clearance=${cookieData.cfClearance}' `
            : '';

        const curlCmd = `curl -s -L --compressed \
            -H 'User-Agent: ${userAgent}' \
            -H 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' \
            -H 'Accept-Language: en-US,en;q=0.5' \
            -H 'Accept-Encoding: gzip, deflate, br' \
            -H 'Connection: keep-alive' \
            -H 'Upgrade-Insecure-Requests: 1' \
            -H 'Sec-Fetch-Dest: document' \
            -H 'Sec-Fetch-Mode: navigate' \
            -H 'Sec-Fetch-Site: none' \
            ${cookieHeader}'${escapedUrl}'`;

        const { stdout } = await execPromise(curlCmd, { timeout });

        // Check if we got a Cloudflare challenge page
        if (stdout.includes('Just a moment...') || stdout.includes('cf_clearance') || stdout.includes('challenge-platform')) {
            const withCookie = cookieData ? ' (cookie expired)' : '';
            console.log(`[${logPrefix} SCRAPER] ExtTo curl blocked by Cloudflare challenge${withCookie}`);
            return null;
        }

        return stdout;
    } catch (error) {
        console.log(`[${logPrefix} SCRAPER] ExtTo curl error: ${error.message}`);
        return null;
    }
}

/**
 * Parse ext.to search results HTML
 * ext.to stores magnet info in data-hash and data-name attributes on .search-magnet-btn elements
 * @param {string} html - The HTML content to parse
 * @param {number} limit - Maximum number of results
 * @param {string} logPrefix - Logging prefix
 * @returns {Array} - Array of torrent results
 */
function parseExtToResults(html, limit, logPrefix) {
    const $ = cheerio.load(html);
    const results = [];
    const seen = new Set();

    // ext.to uses data-hash and data-name attributes on .search-magnet-btn elements
    // The magnet links are NOT actual href="magnet:" links
    const magnetButtons = $('a.search-magnet-btn');

    console.log(`[${logPrefix} SCRAPER] ExtTo found ${magnetButtons.length} magnet buttons`);

    magnetButtons.each((i, el) => {
        if (results.length >= limit) return false;

        try {
            const btn = $(el);

            // Get hash from data-hash attribute
            const infoHash = btn.attr('data-hash');
            if (!infoHash || seen.has(infoHash.toLowerCase())) return;
            seen.add(infoHash.toLowerCase());

            // Get title from data-name attribute
            let title = btn.attr('data-name');
            if (!title) {
                // Fallback to finding title in the row
                const row = btn.closest('tr');
                title = row.find('.torrent-title-link').text().trim() || 'Unknown Title';
            }

            // Construct magnet link from hash
            const magnetLink = `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(title)}`;

            // Find the parent row to extract size, seeders, leechers
            const row = btn.closest('tr');

            // Extract size - look for pattern like "9.37 GB" in any td
            let size = 0;
            row.find('td span').each((idx, span) => {
                const text = $(span).text().trim();
                const sizeMatch = text.match(/^(\d+(?:\.\d+)?)\s*(GB|MB|KB|TB)$/i);
                if (sizeMatch && size === 0) {
                    size = sizeToBytes(text);
                }
            });

            // Extract seeders from .text-success
            const seedersText = row.find('.text-success').first().text().trim();
            const seeders = parseInt(seedersText) || 0;

            // Extract leechers from .text-danger
            const leechersText = row.find('.text-danger').first().text().trim();
            const leechers = parseInt(leechersText) || 0;

            results.push({
                Title: title,
                InfoHash: infoHash.toLowerCase(),
                Size: size,
                Seeders: seeders,
                Leechers: leechers,
                Tracker: 'ExtTo',
                Langs: detectSimpleLangs(title),
                Magnet: magnetLink
            });
        } catch (e) {
            // Skip individual parse errors
        }
    });

    return results;
}

/**
 * Search ext.to for torrents
 * @param {string} query - Search query
 * @param {AbortSignal} signal - Abort signal
 * @param {string} logPrefix - Logging prefix
 * @param {object} config - Configuration object
 * @returns {Promise<Array>} - Array of torrent results
 */
export async function searchExtTo(query, signal, logPrefix, config) {
    const scraperName = 'ExtTo';
    const sfx = (config?.Languages && config.Languages.length) ? `:${config.Languages[0]}` : ':none';
    const timerLabel = createTimerLabel(logPrefix, scraperName, sfx);
    console.time(timerLabel);

    const cacheKey = generateScraperCacheKey(scraperName, query, config);
    const cachedResult = await SqliteCache.getCachedRecord('scraper', cacheKey);
    const cached = cachedResult?.data || null;

    if (cached && Array.isArray(cached)) {
        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${cached.length} results from cache.`);
        console.timeEnd(timerLabel);
        return cached;
    }

    const existingPromise = inFlightRequests.get(cacheKey);
    if (existingPromise) {
        console.log(`[${logPrefix} SCRAPER] ${scraperName} awaiting in-flight request for ${cacheKey}`);
        try {
            return await existingPromise;
        } finally {
            console.timeEnd(timerLabel);
        }
    }

    let isOwner = false;

    const scrapePromise = (async () => {
        const limit = config?.EXTTO_LIMIT ?? ENV.EXTTO_LIMIT ?? 100;
        const maxPages = config?.EXTTO_MAX_PAGES ?? ENV.EXTTO_MAX_PAGES ?? 2;
        const base = ((config?.EXTTO_URL || ENV.EXTTO_URL) || 'https://ext.to').replace(/\/$/, '');
        // Use EXTTO_TIMEOUT which defaults to 65s for FlareSolverr compatibility
        const timeout = config?.EXTTO_TIMEOUT ?? ENV.EXTTO_TIMEOUT ?? 65000;
        const flareSolverrUrl = config?.FLARESOLVERR_URL || ENV.FLARESOLVERR_URL || '';

        // Check for abort signal
        if (signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
        }

        const allResults = [];
        const seenHashes = new Set();

        // Extract domain for session caching
        const domain = new URL(base).hostname;

        // Check for cached cf_clearance cookie first (avoids FlareSolverr entirely)
        let cachedCookie = await getCachedCookie(domain);
        let sessionId = null;

        // Fetch multiple pages
        for (let page = 1; page <= maxPages; page++) {
            if (signal?.aborted) break;
            if (allResults.length >= limit) break;

            // Build search URL - ext.to uses /browse/ for search
            // Include page_size=100 for maximum results per page and with_adult=1 to include all content
            const searchUrl = `${base}/browse/?page_size=100&q=${encodeURIComponent(query)}&with_adult=1&page=${page}`;
            console.log(`[${logPrefix} SCRAPER] ${scraperName} searching page ${page}: ${searchUrl}`);

            let html = null;

            // Strategy: Try cached cookie with curl first (fast), then FlareSolverr (slow but saves new cookie)

            // 1. Try curl with cached cf_clearance cookie (fastest - no FlareSolverr needed)
            if (cachedCookie) {
                if (page === 1) {
                    console.log(`[${logPrefix} SCRAPER] ${scraperName} trying cached cf_clearance cookie with curl`);
                }
                html = await fetchWithCurl(searchUrl, timeout, logPrefix, cachedCookie);

                // If cookie failed, clear it and fall through to FlareSolverr
                if (!html) {
                    cachedCookie = null;
                }
            }

            // 2. Use FlareSolverr if cookie didn't work (will save new cookie on success)
            if (!html && flareSolverrUrl) {
                if (page === 1 || !sessionId) {
                    // Get or create session on first FlareSolverr use
                    sessionId = await getOrCreateSession(flareSolverrUrl, domain, logPrefix);
                    console.log(`[${logPrefix} SCRAPER] ${scraperName} using FlareSolverr at ${flareSolverrUrl}${sessionId ? ' (with session)' : ''}`);
                }
                const result = await fetchWithFlareSolverr(searchUrl, flareSolverrUrl, timeout, logPrefix, sessionId);
                html = result.html;

                // If FlareSolverr succeeded, refresh our cached cookie reference for subsequent pages
                if (html) {
                    cachedCookie = await getCachedCookie(domain);
                }

                // If we got a session back, use it for subsequent pages
                if (result.sessionId && !sessionId) {
                    sessionId = result.sessionId;
                }
            }

            // 3. Last resort: try plain curl without cookie (will likely fail due to Cloudflare)
            if (!html) {
                if (page === 1) {
                    console.log(`[${logPrefix} SCRAPER] ${scraperName} trying direct curl (may fail due to Cloudflare)`);
                }
                html = await fetchWithCurl(searchUrl, timeout, logPrefix);
            }

            if (!html) {
                if (page === 1) {
                    console.log(`[${logPrefix} SCRAPER] ${scraperName} failed to fetch results. FlareSolverr is required for ext.to.`);
                    console.log(`[${logPrefix} SCRAPER] ${scraperName} Configure FLARESOLVERR_URL to enable Cloudflare bypass.`);
                }
                break;
            }

            // Parse results from this page
            const pageResults = parseExtToResults(html, limit, logPrefix);
            console.log(`[${logPrefix} SCRAPER] ${scraperName} page ${page} returned ${pageResults.length} results`);

            // Add unique results
            for (const result of pageResults) {
                if (allResults.length >= limit) break;
                if (!seenHashes.has(result.InfoHash)) {
                    seenHashes.add(result.InfoHash);
                    allResults.push(result);
                }
            }

            // Only continue to next page if current page was full (100 results = likely more available)
            if (pageResults.length < 100) {
                console.log(`[${logPrefix} SCRAPER] ${scraperName} page ${page} had ${pageResults.length} results (not full), stopping pagination`);
                break;
            }
        }

        const results = allResults;

        console.log(`[${logPrefix} SCRAPER] ${scraperName} raw results before processing: ${results.length}`);
        if (results.length > 0) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} Sample raw results:`);
            results.slice(0, 3).forEach((r, i) => {
                console.log(`  ${i+1}. ${r.Title}`);
                console.log(`     Hash: ${r.InfoHash}, Size: ${(r.Size / (1024**3)).toFixed(2)} GB, Seeders: ${r.Seeders}, Langs: [${r.Langs.join(', ')}]`);
            });
        }

        const processedResults = processAndDeduplicate(results, config);

        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${processedResults.length} results after processing (filtered from ${results.length}).`);
        if (processedResults.length > 0) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} Sample processed results:`);
            processedResults.slice(0, 3).forEach((r, i) => {
                console.log(`  ${i+1}. ${r.Title}`);
                console.log(`     Hash: ${r.InfoHash}, Size: ${(r.Size / (1024**3)).toFixed(2)} GB, Seeders: ${r.Seeders}, Langs: [${r.Langs.join(', ')}]`);
            });
        }

        return processedResults;
    })();

    inFlightRequests.set(cacheKey, scrapePromise);
    isOwner = true;

    try {
        const processedResults = await scrapePromise;

        if (isOwner && processedResults.length > 0) {
            try {
                const saved = await SqliteCache.upsertCachedMagnet({
                    service: 'scraper',
                    hash: cacheKey,
                    data: processedResults
                });
                if (saved) {
                    console.log(`[${logPrefix} SCRAPER] ${scraperName} saved ${processedResults.length} results to cache`);
                }
            } catch (cacheError) {
                console.warn(`[${logPrefix} SCRAPER] ${scraperName} failed to save to cache: ${cacheError.message}`);
            }
        }

        return processedResults;
    } catch (error) {
        handleScraperError(error, scraperName, logPrefix);
        return [];
    } finally {
        if (isOwner) {
            inFlightRequests.delete(cacheKey);
        }
        console.timeEnd(timerLabel);
    }
}
