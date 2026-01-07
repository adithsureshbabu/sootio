/**
 * MKVDrama search helpers
 * Provides search and post parsing utilities for mkvdrama.net
 */

import * as cheerio from 'cheerio';
import axios from 'axios';
import { makeRequest } from '../../utils/http.js';
import { cleanTitle } from '../../utils/parsing.js';
import * as config from '../../../config.js';
import * as SqliteCache from '../../../util/cache-store.js';

const BASE_URL = 'https://mkvdrama.net';
const OUO_HOSTS = ['ouo.io'];
const FLARESOLVERR_URL = config.FLARESOLVERR_URL || '';
const FLARESOLVERR_TIMEOUT = parseInt(process.env.HTTP_FLARESOLVERR_TIMEOUT, 10) || 65000;
const FLARE_SESSION_TTL = 10 * 60 * 1000; // 10 minutes
const flareSessionCache = new Map(); // domain -> { sessionId, ts }

// Cookie cache - persists cf_clearance cookie to SQLite to avoid FlareSolverr on every request
const COOKIE_CACHE_SERVICE = 'cf_cookie';
const COOKIE_CACHE_TTL = 25 * 60 * 1000; // 25 minutes

/**
 * Get cached Cloudflare cookie from SQLite
 */
async function getCachedCookie(domain) {
    try {
        const cacheKey = `${domain}_cf_cookie`;
        const result = await SqliteCache.getCachedRecord(COOKIE_CACHE_SERVICE, cacheKey);
        if (result?.data && result.data.cfClearance && result.data.userAgent) {
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
 */
function extractCfClearance(cookies) {
    if (!Array.isArray(cookies)) return null;
    const cfCookie = cookies.find(c => c.name === 'cf_clearance');
    return cfCookie?.value || null;
}

/**
 * Check if response indicates a Cloudflare challenge
 */
function isCloudflareChallenge(body = '', statusCode = null) {
    if (statusCode && (statusCode === 403 || statusCode === 503)) return true;
    const lower = body.toLowerCase();
    return lower.includes('cf-mitigated') ||
        lower.includes('just a moment') ||
        lower.includes('cf_chl') ||
        lower.includes('cf_clearance') ||
        (lower.includes('challenge-platform') && lower.includes('cf_chl')) ||
        lower.includes('cf-turnstile') ||
        lower.includes('verify_turnstile') ||
        (lower.includes('security check') && lower.includes('cloudflare'));
}

/**
 * Get or create a FlareSolverr session for a domain
 */
async function getOrCreateFlareSession(domain) {
    if (!FLARESOLVERR_URL || !domain) return null;

    const cached = flareSessionCache.get(domain);
    if (cached && (Date.now() - cached.ts) < FLARE_SESSION_TTL) {
        return cached.sessionId;
    }

    const sessionId = `sootio_mkvdrama_${domain.replace(/\./g, '_')}`;

    // Check if session already exists
    try {
        const list = await axios.post(`${FLARESOLVERR_URL}/v1`, { cmd: 'sessions.list' }, {
            timeout: 10000,
            headers: { 'Content-Type': 'application/json' }
        });
        if (list.data?.sessions?.includes(sessionId)) {
            flareSessionCache.set(domain, { sessionId, ts: Date.now() });
            console.log(`[MKVDrama] Reusing existing FlareSolverr session: ${sessionId}`);
            return sessionId;
        }
    } catch {
        // Ignore list errors
    }

    // Create new session
    try {
        const create = await axios.post(`${FLARESOLVERR_URL}/v1`, {
            cmd: 'sessions.create',
            session: sessionId
        }, {
            timeout: 30000,
            headers: { 'Content-Type': 'application/json' }
        });
        if (create.data?.status === 'ok') {
            flareSessionCache.set(domain, { sessionId, ts: Date.now() });
            console.log(`[MKVDrama] Created new FlareSolverr session: ${sessionId}`);
            return sessionId;
        }
    } catch (error) {
        if (error.response?.data?.message?.includes('already exists')) {
            flareSessionCache.set(domain, { sessionId, ts: Date.now() });
            return sessionId;
        }
        console.error(`[MKVDrama] FlareSolverr session create failed: ${error.message}`);
    }

    return null;
}

/**
 * Fetch using FlareSolverr to bypass Cloudflare
 */
async function fetchWithFlareSolverr(url, options = {}) {
    if (!FLARESOLVERR_URL) return null;

    const domain = (() => {
        try { return new URL(url).hostname; } catch { return null; }
    })();
    const sessionId = await getOrCreateFlareSession(domain);

    const timeout = sessionId
        ? Math.max(options.timeout || 0, 30000)
        : Math.max((options.timeout || 0) * 4, 60000);

    const requestBody = {
        cmd: 'request.get',
        url,
        maxTimeout: timeout
    };

    if (sessionId) {
        requestBody.session = sessionId;
    }

    try {
        const response = await axios.post(`${FLARESOLVERR_URL}/v1`, requestBody, {
            timeout: timeout + 5000,
            headers: { 'Content-Type': 'application/json' }
        });

        if (response.data?.status === 'ok' && response.data?.solution?.response) {
            const body = response.data.solution.response;

            // Extract and save cf_clearance cookie for future requests
            if (domain) {
                const cfClearance = extractCfClearance(response.data.solution.cookies);
                const userAgent = response.data.solution.userAgent;
                if (cfClearance && userAgent) {
                    await saveCookie(domain, cfClearance, userAgent);
                    console.log(`[MKVDrama] Saved cf_clearance cookie for ${domain}`);
                }
            }

            return {
                body,
                document: cheerio.load(body),
                statusCode: response.data.solution.status
            };
        }
        console.log(`[MKVDrama] FlareSolverr response: ${response.data?.status} - ${response.data?.message || 'n/a'}`);

        // Invalidate session on failure
        if (sessionId && domain) {
            flareSessionCache.delete(domain);
        }
    } catch (error) {
        console.error(`[MKVDrama] FlareSolverr error: ${error.message}`);
        if (sessionId && domain) {
            flareSessionCache.delete(domain);
        }
    }

    return null;
}

/**
 * Fetch a page - tries cached cookie first, then direct request, then FlareSolverr
 */
async function fetchPage(url, signal = null) {
    const domain = (() => {
        try { return new URL(url).hostname; } catch { return null; }
    })();

    // Strategy: Try cached cookie first (fast), then FlareSolverr (slow but saves new cookie)

    // 1. Try with cached cf_clearance cookie first
    const cachedCookie = await getCachedCookie(domain);
    if (cachedCookie) {
        try {
            console.log(`[MKVDrama] Trying cached cf_clearance cookie for ${url}`);
            const response = await makeRequest(url, {
                parseHTML: true,
                signal,
                timeout: 12000,
                headers: {
                    'Cookie': `cf_clearance=${cachedCookie.cfClearance}`,
                    'User-Agent': cachedCookie.userAgent
                }
            });

            if (!isCloudflareChallenge(response.body || '', response.statusCode)) {
                console.log(`[MKVDrama] Cached cookie worked for ${url}`);
                return response.document || null;
            }
            console.log(`[MKVDrama] Cached cookie expired for ${domain}`);
        } catch (error) {
            console.log(`[MKVDrama] Cached cookie request failed: ${error.message}`);
        }
    }

    // 2. Try direct request without cookie (in case Cloudflare is not active)
    try {
        const response = await makeRequest(url, { parseHTML: true, signal, timeout: 12000 });

        if (!isCloudflareChallenge(response.body || '', response.statusCode)) {
            console.log(`[MKVDrama] Direct request succeeded for ${url}`);
            return response.document || null;
        }

        console.log(`[MKVDrama] Cloudflare challenge detected (status: ${response.statusCode}), will try FlareSolverr...`);
    } catch (error) {
        console.error(`[MKVDrama] Direct request failed for ${url}: ${error.message}`);
    }

    // 3. Use FlareSolverr (will save new cookie on success)
    if (!FLARESOLVERR_URL) {
        console.error(`[MKVDrama] FlareSolverr URL not configured - cannot bypass Cloudflare`);
        return null;
    }

    console.log(`[MKVDrama] Attempting FlareSolverr bypass for ${url}`);
    const flareResponse = await fetchWithFlareSolverr(url);
    if (flareResponse?.document) {
        console.log(`[MKVDrama] FlareSolverr succeeded for ${url}`);
        return flareResponse.document;
    }
    console.error(`[MKVDrama] FlareSolverr failed for ${url}`);

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

function parseEpisodeRange(label = '') {
    const normalized = label || '';
    const match = normalized.match(/(?:episode|ep)\s*(\d{1,3})(?:\s*(?:-|to)\s*(\d{1,3}))?/i);
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

    return null;
}

function parseSeasonNumber(label = '') {
    const normalized = label || '';
    const match = normalized.match(/season\s*(\d{1,2})/i) || normalized.match(/\bS(\d{1,2})E\d{1,3}\b/i);
    if (!match) return null;
    const season = parseInt(match[1], 10);
    return Number.isNaN(season) ? null : season;
}

function isOuoLink(url) {
    if (!url) return false;
    return OUO_HOSTS.some(host => url.toLowerCase().includes(host));
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
                const absolute = normalizeUrl(href, BASE_URL);
                if (!absolute || !isOuoLink(absolute)) return;

                addLink({
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
    });

    return downloadLinks;
}

function collectLooseOuoLinks($, scope, fallbackLabel = '') {
    const downloadLinks = [];
    const seen = new Set();

    scope.find('a[href]').each((_, link) => {
        const href = $(link).attr('href');
        const absolute = normalizeUrl(href, BASE_URL);
        if (!absolute || !isOuoLink(absolute) || seen.has(absolute)) return;
        seen.add(absolute);

        const container = $(link).closest('li, p, div').first();
        const label = cleanText(
            container.find('h1, h2, h3, h4, h5, strong, b').first().text()
        ) || fallbackLabel;
        const quality = cleanText(container.find('strong, b').first().text());
        const episodeRange = parseEpisodeRange(label);
        const season = parseSeasonNumber(label);

        downloadLinks.push({
            url: absolute,
            label,
            quality,
            linkText: cleanText($(link).text()),
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
 * Try to fetch a direct slug URL and extract page info
 */
async function tryDirectSlugUrl(query, signal = null) {
    const slug = toSlug(query);
    if (!slug) return null;

    const directUrl = `${BASE_URL}/${slug}/`;
    console.log(`[MKVDrama] Trying direct slug URL: ${directUrl}`);

    try {
        const $ = await fetchPage(directUrl, signal);
        if (!$) return null;

        // Check if this is a valid content page (has a title and content)
        let title = cleanText($('h1.entry-title').text()) || cleanText($('title').text()) || '';
        title = title.replace(/\s*\|\s*MkvDrama.*$/i, '').trim();

        if (!title) return null;

        // Check for download links or content indicators
        const hasContent = $('.soraddlx, .soraddl, .soradd, .entry-content').length > 0;
        if (!hasContent) return null;

        const yearMatch = title.match(/\b(19|20)\d{2}\b/);
        const poster = $('img.wp-post-image').attr('data-lazy-src') ||
                       $('img.wp-post-image').attr('src') ||
                       $('.thumb img').attr('data-lazy-src') ||
                       $('.thumb img').attr('src') || null;

        console.log(`[MKVDrama] Found content via direct slug: "${title}"`);

        return {
            title,
            url: directUrl,
            year: yearMatch ? parseInt(yearMatch[0], 10) : null,
            poster,
            normalizedTitle: cleanTitle(title)
        };
    } catch (error) {
        console.log(`[MKVDrama] Direct slug URL failed: ${error.message}`);
        return null;
    }
}

export async function scrapeMkvDramaSearch(query, signal = null) {
    if (!query) return [];

    const cleanQuery = query.replace(/:/g, '').replace(/\s+/g, ' ').trim();
    const searchUrl = `${BASE_URL}/?s=${encodeURIComponent(cleanQuery)}`;

    console.log(`[MKVDrama] Search query: "${cleanQuery}", URL: ${searchUrl}`);

    try {
        const $ = await fetchPage(searchUrl, signal);
        if (!$) {
            console.log(`[MKVDrama] fetchPage returned null for search, trying direct slug...`);
            // Search page failed, try direct slug as fallback
            const directResult = await tryDirectSlugUrl(cleanQuery, signal);
            console.log(`[MKVDrama] Direct slug result: ${directResult ? directResult.title : 'null'}`);
            return directResult ? [directResult] : [];
        }
        const results = [];

        const articles = $('article');
        console.log(`[MKVDrama] Found ${articles.length} article elements in search results`);

        articles.each((_, el) => {
            const anchor = $(el).find('.bsx a').first();
            const title = cleanText(anchor.attr('title') || anchor.text());
            const url = normalizeUrl(anchor.attr('href'));

            if (!title || !url) return;

            const yearMatch = title.match(/\b(19|20)\d{2}\b/);
            const poster = $(el).find('img').attr('data-lazy-src') || $(el).find('img').attr('src') || null;

            results.push({
                title,
                url,
                year: yearMatch ? parseInt(yearMatch[0], 10) : null,
                poster,
                normalizedTitle: cleanTitle(title)
            });
        });

        console.log(`[MKVDrama] Parsed ${results.length} results from search page`);

        // If search returned no results, try direct slug URL as fallback
        if (results.length === 0) {
            console.log(`[MKVDrama] Search returned no results, trying direct slug URL...`);
            const directResult = await tryDirectSlugUrl(cleanQuery, signal);
            if (directResult) {
                console.log(`[MKVDrama] Direct slug found: "${directResult.title}" at ${directResult.url}`);
                results.push(directResult);
            } else {
                console.log(`[MKVDrama] Direct slug also returned no results`);
            }
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

    try {
        const $ = await fetchPage(postUrl, signal);
        if (!$) {
            return { title: '', downloadLinks: [] };
        }
        let title = cleanText($('h1.entry-title').text()) || cleanText($('title').text()) || '';
        title = title.replace(/\s*\|\s*MkvDrama.*$/i, '').trim();

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
                    const absolute = normalizeUrl(href, BASE_URL);
                    if (!absolute || !isOuoLink(absolute)) return;

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

        if (downloadLinks.length === 0 && options?.episode && depth < 1) {
            const episodePost = findEpisodePost($, options?.season, options?.episode);
            if (episodePost?.url && episodePost.url !== postUrl) {
                const nested = await loadMkvDramaContent(episodePost.url, signal, {
                    ...options,
                    depth: depth + 1
                });
                if (nested.downloadLinks.length) {
                    return nested;
                }
                if (nested.title && !title) {
                    title = nested.title;
                }
                downloadLinks = nested.downloadLinks;
            }
        }

        if (downloadLinks.length === 0) {
            downloadLinks = collectLooseOuoLinks($, $('article, .entry-content, .post-content, body'), title);
        }

        return { title, downloadLinks };
    } catch (error) {
        console.error(`[MKVDrama] Failed to load post ${postUrl}: ${error.message}`);
        return { title: '', downloadLinks: [] };
    }
}
