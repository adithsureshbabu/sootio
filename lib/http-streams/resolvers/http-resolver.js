/**
 * HTTP Stream URL Resolver
 * Resolves redirect URLs to final streaming links
 * Handles lazy-load mode for 4KHDHub, HDHub4u, and UHDMovies
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import crypto from 'crypto';
import * as config from '../../config.js';
import { getRedirectLinks, processExtractorLinkWithAwait } from '../providers/4khdhub/extraction.js';
import { validateSeekableUrl } from '../utils/validation.js';
import { makeRequest } from '../utils/http.js';
import { tryDecodeBase64 } from '../utils/encoding.js';
import { getResolutionFromName } from '../utils/parsing.js';

const FAST_SEEK_TIMEOUT_MS = parseInt(process.env.HTTP_STREAM_SEEK_TIMEOUT_MS, 10) || 1500;
const MAX_PARALLEL_VALIDATIONS = parseInt(process.env.HTTP_STREAM_MAX_PARALLEL, 10) || 2;
const RESOLVE_CACHE_TTL = parseInt(process.env.HTTP_STREAM_RESOLVE_CACHE_TTL, 10) || (5 * 60 * 1000); // 5 minutes

const resolveCache = new Map(); // key -> { promise, value, ts }
const DIRECT_HOST_HINTS = ['workers.dev', 'hubcdn.fans', 'r2.dev'];
const OUO_HOSTS = ['ouo.io', 'ouo.press'];
const OUO_BUTTON_ID = 'btn-main';
const DEFAULT_HTTP_STREAM_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const OUO_USER_AGENT = config.HTTP_STREAM_USER_AGENT || DEFAULT_HTTP_STREAM_USER_AGENT;
const VIEWCRATE_HOSTS = ['viewcrate.cc'];
const PIXELDRAIN_HOSTS = ['pixeldrain.com', 'pixeldrain.net', 'pixeldrain.dev'];
const GOFILE_HOSTS = ['gofile.io'];
const FLARESOLVERR_URL = config.FLARESOLVERR_URL || '';
const FLARESOLVERR_TIMEOUT = parseInt(process.env.HTTP_FLARESOLVERR_TIMEOUT, 10) || 65000;
const OUO_COOKIE = config.OUO_COOKIE || '';
const VIEWCRATE_COOKIE = config.VIEWCRATE_COOKIE || '';
const FLARE_SESSION_TTL = 10 * 60 * 1000;
const flareSessionCache = new Map(); // domain -> { sessionId, ts }
const GOFILE_TOKEN_TTL_MS = parseInt(process.env.GOFILE_TOKEN_TTL_MS, 10) || (10 * 60 * 1000);
const GOFILE_TOKEN_CACHE_MAX = parseInt(process.env.GOFILE_TOKEN_CACHE_MAX, 10) || 500;
const GOFILE_REQUEST_TIMEOUT_MS = parseInt(process.env.GOFILE_REQUEST_TIMEOUT_MS, 10) || 15000;
const gofileTokenCache = new Map(); // url -> { token, ts }

const VIDEO_EXTENSIONS = new Set([
    '.mp4',
    '.mkv',
    '.avi',
    '.webm',
    '.mov',
    '.m4v',
    '.ts',
    '.m3u8'
]);

const NON_VIDEO_EXTENSIONS = new Set([
    '.zip',
    '.rar',
    '.7z',
    '.iso',
    '.exe',
    '.tar',
    '.gz',
    '.bz2',
    '.xz',
    '.js',
    '.css',
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.webp',
    '.svg',
    '.ico',
    '.woff',
    '.woff2',
    '.ttf',
    '.eot',
    '.map',
    '.json'
]);

const VIDEO_EXTENSION_LIST = Array.from(VIDEO_EXTENSIONS);
const NON_VIDEO_EXTENSION_LIST = Array.from(NON_VIDEO_EXTENSIONS);

const TRUSTED_VIDEO_HOST_HINTS = [
    'pixeldrain',
    'workers.dev',
    'hubcdn.fans',
    'r2.dev',
    'googleusercontent.com'
];

const VIDEO_TYPE_HINTS = ['mp4', 'mkv', 'webm', 'm3u8', 'avi', 'mov', 'ts', 'm4v'];

function isAssetUrl(candidate) {
    if (!candidate) return true;
    const lower = candidate.toLowerCase();
    return /\.(?:js|css|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|eot|map|json)(?:$|[?#])/.test(lower);
}

function normalizeAbsoluteUrl(href, baseUrl) {
    if (!href) return null;
    try {
        return new URL(href, baseUrl).toString();
    } catch {
        return null;
    }
}

function extractCookies(setCookieHeader) {
    if (!setCookieHeader) return [];
    const values = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
    return values.map(cookie => cookie.split(';')[0].trim()).filter(Boolean);
}

function mergeCookieHeader(existing, setCookieHeader) {
    const cookieMap = new Map();
    if (existing) {
        existing.split(';').forEach(cookie => {
            const [name, ...rest] = cookie.trim().split('=');
            if (!name || rest.length === 0) return;
            cookieMap.set(name, rest.join('='));
        });
    }
    extractCookies(setCookieHeader).forEach(cookie => {
        const [name, ...rest] = cookie.split('=');
        if (!name || rest.length === 0) return;
        cookieMap.set(name, rest.join('='));
    });
    return Array.from(cookieMap.entries())
        .map(([name, value]) => `${name}=${value}`)
        .join('; ');
}

function extractRedirectCandidates(body = '', document = null, baseUrl = '') {
    const candidates = [];

    if (document) {
        const refresh = document('meta[http-equiv=\"refresh\"]').attr('content') || '';
        const refreshMatch = refresh.match(/url=([^;]+)/i);
        if (refreshMatch?.[1]) {
            const resolved = normalizeAbsoluteUrl(refreshMatch[1].trim(), baseUrl);
            if (resolved) candidates.push(resolved);
        }

        document('a[href]').each((_, el) => {
            const href = document(el).attr('href');
            const resolved = normalizeAbsoluteUrl(href, baseUrl);
            if (resolved) candidates.push(resolved);
        });
    }

    const scriptMatches = body.match(/location\.(?:href|replace|assign)\s*(?:\(\s*)?['"]([^'"]+)['"]\s*\)?/i);
    if (scriptMatches?.[1]) {
        const resolved = normalizeAbsoluteUrl(scriptMatches[1], baseUrl);
        if (resolved) candidates.push(resolved);
    }

    const windowOpenMatch = body.match(/window\.open\(\s*['"]([^'"]+)['"]/i);
    if (windowOpenMatch?.[1]) {
        const resolved = normalizeAbsoluteUrl(windowOpenMatch[1], baseUrl);
        if (resolved) candidates.push(resolved);
    }

    const urlMatches = body.match(/https?:\/\/[^\s"'<>]+/gi) || [];
    urlMatches.forEach(match => {
        const resolved = normalizeAbsoluteUrl(match, baseUrl);
        if (resolved) candidates.push(resolved);
    });

    const base64Matches = body.match(/[A-Za-z0-9+/=]{40,}/g) || [];
    base64Matches.forEach(raw => {
        const decoded = tryDecodeBase64(raw);
        if (decoded && decoded.startsWith('http')) {
            const resolved = normalizeAbsoluteUrl(decoded.trim(), baseUrl);
            if (resolved) candidates.push(resolved);
        }
    });

    return candidates;
}

function pickFirstExternalCandidate(candidates, baseUrl, allowedHosts = []) {
    const baseHost = (() => {
        try {
            return new URL(baseUrl).hostname.toLowerCase();
        } catch {
            return '';
        }
    })();
    const normalizedAllowed = (allowedHosts || []).filter(Boolean).map(host => host.toLowerCase());

    for (const candidate of candidates) {
        if (!candidate) continue;
        const lower = candidate.toLowerCase();
        if (OUO_HOSTS.some(host => lower.includes(host))) continue;
        if (baseHost && lower.includes(baseHost)) continue;
        if (isAssetUrl(candidate)) continue;
        if (normalizedAllowed.length && !normalizedAllowed.some(host => lower.includes(host))) continue;
        return candidate;
    }
    return null;
}

function pickPixeldrainCandidate(candidates) {
    return candidates.find(candidate =>
        candidate && PIXELDRAIN_HOSTS.some(host => candidate.toLowerCase().includes(host))
    ) || null;
}

function parseStreamHints(rawUrl) {
    if (!rawUrl || !rawUrl.includes('#')) {
        return { baseUrl: rawUrl, hints: {} };
    }

    const [baseUrl, hash] = rawUrl.split('#', 2);
    const params = new URLSearchParams(hash || '');
    return {
        baseUrl,
        hints: {
            episode: params.get('ep') || null,
            resolution: params.get('res') || null,
            host: params.get('host') || null
        }
    };
}

function normalizePixeldrainUrl(url) {
    if (!url) return null;
    try {
        const parsed = new URL(url);
        if (!PIXELDRAIN_HOSTS.includes(parsed.hostname)) {
            return url;
        }
        if (parsed.pathname.startsWith('/api/file/')) {
            return parsed.toString();
        }
        const match = parsed.pathname.match(/\/u\/([^/]+)/);
        if (match?.[1]) {
            return `https://pixeldrain.com/api/file/${match[1]}?download`;
        }
        return parsed.toString();
    } catch {
        return url;
    }
}

function collectViewcrateEntries(document, baseUrl) {
    const candidates = [];
    const seen = new Set();

    if (!document) return candidates;

    const blockSelectors = [
        { selector: '.z_qmnyt', episodeAttr: 'data-8wg7v' },
        { selector: '.z_w78ax', episodeAttr: 'data-rjcoq' },
        { selector: '.z_26tgx', episodeAttr: 'data-pirz6' },
        { selector: '[data-8wg7v]', episodeAttr: 'data-8wg7v' },
        { selector: '[data-rjcoq]', episodeAttr: 'data-rjcoq' },
        { selector: '[data-pirz6]', episodeAttr: 'data-pirz6' }
    ];

    blockSelectors.forEach(({ selector, episodeAttr }) => {
        document(selector).each((_, block) => {
            const $block = document(block);
            const episodeKey = $block.attr(episodeAttr) ||
                $block.find('h2').first().text().trim();

            $block.find('.y_u5qme, .y_tpl1j, .y_vbmuk, [data-ogehf], [data-7kuiu], [data-s5t96]').each((__, entry) => {
                const $entry = document(entry);
                const hostAttr = $entry.attr('data-ogehf') || $entry.attr('data-7kuiu') || $entry.attr('data-s5t96') || '';
                let host = hostAttr.toLowerCase();
                if (!host) {
                    const hostText = $entry.find('.w_po9rr, .w_4vj7h, .w_t2b66').first().text().trim();
                    host = hostText.toLowerCase();
                }

                const filename = $entry.find('.x_qwwj2, .x_i29qt, .x_aegdv').first().text().trim() ||
                    $entry.find('span').first().text().trim();
                const resolution = getResolutionFromName(filename);
                const opener = $entry.find('.v_wldd7, .v_65zvr, [onclick*="/get/"]').attr('onclick') || '';
                const getMatch = opener.match(/\/get\/[A-Za-z0-9]+/);
                const getPath = getMatch ? getMatch[0] : null;
                const getUrl = normalizeAbsoluteUrl(getPath, baseUrl);

                if (!getUrl) return;
                const key = `${episodeKey || ''}|${host || ''}|${getUrl}`;
                if (seen.has(key)) return;
                seen.add(key);

                candidates.push({
                    episodeKey,
                    host,
                    filename,
                    resolution,
                    getUrl
                });
            });
        });
    });

    return candidates;
}

function parseViewcrateEncryptedPayload(body = '') {
    if (!body) return null;

    const extract = (key) => {
        // Fix: use correct escaping for RegExp constructor
        // \\.  -> \.  in regex (matches literal dot)
        // \\s  -> \s  in regex (matches whitespace)
        const pattern = new RegExp(`window\\.${key}\\s*=\\s*["']([^"']+)["']`);
        const match = body.match(pattern);
        return match?.[1] || null;
    };

    const encodedKey = extract('_k');
    const encodedIv = extract('_i');
    const encodedCiphertext = extract('_c');

    if (!encodedKey || !encodedIv || !encodedCiphertext) {
        console.log('[HTTP-RESOLVE] ViewCrate encrypted payload missing keys', {
            hasKey: Boolean(encodedKey),
            hasIv: Boolean(encodedIv),
            hasCiphertext: Boolean(encodedCiphertext)
        });
        return null;
    }

    try {
        const key = Buffer.from(encodedKey, 'base64');
        const iv = Buffer.from(encodedIv, 'base64');
        const data = Buffer.from(encodedCiphertext, 'base64');
        if (key.length !== 32) {
            console.log(`[HTTP-RESOLVE] ViewCrate key length unexpected: ${key.length}`);
        }
        if (iv.length < 12) {
            console.log(`[HTTP-RESOLVE] ViewCrate IV length unexpected: ${iv.length}`);
        }
        if (data.length <= 16) {
            return null;
        }

        const tag = data.slice(data.length - 16);
        const ciphertext = data.slice(0, data.length - 16);
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
        return JSON.parse(decrypted);
    } catch (error) {
        console.log(`[HTTP-RESOLVE] ViewCrate decrypt failed: ${error.message}`);
        return null;
    }
}

function collectViewcrateEncryptedEntries(body, baseUrl) {
    const payload = parseViewcrateEncryptedPayload(body);
    if (!payload || !Array.isArray(payload.d)) {
        return [];
    }

    const candidates = [];

    payload.d.forEach(entry => {
        const episodeKey = entry?.t || null;
        const links = Array.isArray(entry?.l) ? entry.l : [];
        links.forEach(link => {
            const filename = link?.n || '';
            const host = (link?.h || '').toLowerCase();
            const token = link?.u || '';
            if (!token) return;

            const getPath = token.startsWith('/get/')
                ? token
                : `/get/${token.replace(/^\/+/, '')}`;
            const getUrl = normalizeAbsoluteUrl(getPath, baseUrl);
            if (!getUrl) return;

            candidates.push({
                episodeKey,
                host,
                filename,
                resolution: getResolutionFromName(filename),
                getUrl
            });
        });
    });

    return candidates;
}

function normalizeHostHint(host) {
    if (!host) return null;
    const lower = host.toLowerCase();
    if (lower.includes('pixeldrain')) return 'pixeldrain';
    if (lower.includes('gofile')) return 'gofile';
    return lower;
}

function candidateMatchesHost(candidate, hostHint) {
    if (!hostHint || !candidate?.host) return false;
    const host = candidate.host.toLowerCase();
    if (hostHint === 'pixeldrain') return host.includes('pixeldrain');
    if (hostHint === 'gofile') return host.includes('gofile');
    return host.includes(hostHint);
}

function orderViewcrateCandidates(candidates, hints = {}) {
    if (!candidates.length) return [];

    let filtered = candidates;

    if (hints.episode) {
        filtered = filtered.filter(candidate => candidate.episodeKey === hints.episode);
    }

    if (hints.resolution) {
        const normalizedResolution = hints.resolution === '4k' ? '2160p' : hints.resolution;
        filtered = filtered.filter(candidate => candidate.resolution === normalizedResolution);
    }

    const hostHint = normalizeHostHint(hints.host || null);
    if (hostHint) {
        const hostFiltered = filtered.filter(candidate => candidateMatchesHost(candidate, hostHint));
        if (hostFiltered.length) {
            filtered = hostFiltered;
        }
    }

    if (!filtered.length) {
        if (hostHint) {
            const hostFallback = candidates.filter(candidate => candidateMatchesHost(candidate, hostHint));
            filtered = hostFallback.length ? hostFallback : candidates;
        } else {
            filtered = candidates;
        }
    }

    const preferredHost = normalizeHostHint(hints.host || 'pixeldrain.com');
    const matchesHost = (candidate) => {
        if (!preferredHost || !candidate?.host) return false;
        const host = candidate.host.toLowerCase();
        if (preferredHost === 'pixeldrain') return host.includes('pixeldrain');
        if (preferredHost === 'gofile') return host.includes('gofile');
        return host.includes(preferredHost);
    };

    const preferred = filtered.filter(matchesHost);
    const fallback = filtered.filter(candidate => !matchesHost(candidate));
    return [...preferred, ...fallback];
}

async function resolveViewcrateGetLink(getUrl, referer) {
    if (!getUrl) return null;
    const resolved = await fetchWithCloudflare(getUrl, {
        timeout: 12000,
        allowRedirects: false,
        headers: {
            'User-Agent': OUO_USER_AGENT,
            'Referer': referer || getUrl,
            ...(VIEWCRATE_COOKIE ? { 'Cookie': VIEWCRATE_COOKIE } : {})
        }
    });

    let directUrl = null;
    const status = resolved?.statusCode || null;
    if (status && [301, 302, 307, 308].includes(status) && resolved.headers?.location) {
        directUrl = normalizeAbsoluteUrl(resolved.headers.location, getUrl);
        if (directUrl) {
            console.log(`[HTTP-RESOLVE] ViewCrate get redirected to ${directUrl.substring(0, 80)}...`);
        }
    }

    if (!directUrl) {
        const candidates = extractRedirectCandidates(resolved.body, resolved.document, getUrl);
        directUrl = pickPixeldrainCandidate(candidates) || resolved.url;
    }

    // Check if it's a GoFile URL
    if (GOFILE_HOSTS.some(host => directUrl?.toLowerCase().includes(host))) {
        console.log('[HTTP-RESOLVE] ViewCrate redirected to GoFile');
        return resolveGofileDownload(directUrl);
    }

    const normalized = normalizePixeldrainUrl(directUrl);
    if (!normalized) return null;

    // If not a Pixeldrain URL, return as-is (might be another host)
    if (!PIXELDRAIN_HOSTS.some(host => normalized.toLowerCase().includes(host))) {
        // Check if it's GoFile in the normalized URL
        if (GOFILE_HOSTS.some(host => normalized.toLowerCase().includes(host))) {
            return resolveGofileDownload(normalized);
        }
        return normalized;
    }

    return resolvePixeldrainDownload(normalized);
}

function normalizeGofileTokenEntry(token) {
    if (!token) return null;
    if (typeof token === 'string') {
        return { accountToken: token, websiteToken: null };
    }
    if (token.accountToken) {
        return {
            accountToken: token.accountToken,
            websiteToken: token.websiteToken || null
        };
    }
    if (token.token) {
        return { accountToken: token.token, websiteToken: token.websiteToken || null };
    }
    return null;
}

function getConfiguredGofileTokens() {
    const accountToken = process.env.GOFILE_ACCOUNT_TOKEN || null;
    const websiteToken = process.env.GOFILE_WEBSITE_TOKEN || null;
    if (!accountToken) return null;
    return { accountToken, websiteToken };
}

function cacheGofileToken(url, token) {
    if (!url || !token) return;
    const entry = normalizeGofileTokenEntry(token);
    if (!entry?.accountToken) return;
    const now = Date.now();
    gofileTokenCache.set(url, { ...entry, ts: now });

    if (gofileTokenCache.size <= GOFILE_TOKEN_CACHE_MAX) {
        return;
    }

    let oldestKey = null;
    let oldestTs = Infinity;
    for (const [key, value] of gofileTokenCache.entries()) {
        if (value.ts < oldestTs) {
            oldestTs = value.ts;
            oldestKey = key;
        }
    }
    if (oldestKey) {
        gofileTokenCache.delete(oldestKey);
    }
}

export function getGofileTokenForUrl(url) {
    if (!url) return null;
    const cached = gofileTokenCache.get(url);
    if (!cached) return null;
    if (Date.now() - cached.ts > GOFILE_TOKEN_TTL_MS) {
        gofileTokenCache.delete(url);
        return null;
    }
    return cached.accountToken;
}

async function fetchGofileGuestToken() {
    const configured = getConfiguredGofileTokens();
    if (configured) {
        console.log('[HTTP-RESOLVE] GoFile: Using configured token');
        return configured;
    }
    try {
        const accountResponse = await makeRequest('https://api.gofile.io/accounts', {
            method: 'POST',
            timeout: GOFILE_REQUEST_TIMEOUT_MS,
            serviceName: 'gofile',
            headers: {
                'User-Agent': OUO_USER_AGENT,
                'Origin': 'https://gofile.io',
                'Referer': 'https://gofile.io/'
            }
        });
        const accountData = JSON.parse(accountResponse.body);
        if (accountData.status === 'ok' && accountData.data?.token) {
            console.log('[HTTP-RESOLVE] GoFile: Got guest token');
            const accountToken = accountData.data.token;
            let websiteToken = null;

            try {
                const websiteResponse = await makeRequest('https://api.gofile.io/accounts/website', {
                    method: 'GET',
                    timeout: GOFILE_REQUEST_TIMEOUT_MS,
                    serviceName: 'gofile',
                    headers: {
                        'User-Agent': OUO_USER_AGENT,
                        'Accept': '*/*',
                        'Authorization': `Bearer ${accountToken}`,
                        'Origin': 'https://gofile.io',
                        'Referer': 'https://gofile.io/'
                    }
                });
                const websiteData = JSON.parse(websiteResponse.body);
                if (websiteData.status === 'ok') {
                    websiteToken = websiteData.data?.token ||
                        websiteData.data?.websiteToken ||
                        websiteData.data?.website ||
                        null;
                    if (websiteToken) {
                        console.log('[HTTP-RESOLVE] GoFile: Got website token');
                    }
                }
            } catch (e) {
                console.log(`[HTTP-RESOLVE] GoFile: Failed to get website token: ${e.message}`);
            }

            return { accountToken, websiteToken };
        }
    } catch (e) {
        console.log(`[HTTP-RESOLVE] GoFile: Failed to get guest token: ${e.message}`);
    }
    return null;
}

export async function ensureGofileTokenForUrl(url) {
    const cached = getGofileTokenForUrl(url);
    if (cached) return cached;
    const configured = getConfiguredGofileTokens();
    if (configured) {
        cacheGofileToken(url, configured);
        return configured.accountToken;
    }
    const token = await fetchGofileGuestToken();
    if (token && url) {
        cacheGofileToken(url, token);
    }
    return token?.accountToken || null;
}

async function resolvePixeldrainDownload(pixeldrainUrl) {
    if (!pixeldrainUrl) return null;
    const normalized = normalizePixeldrainUrl(pixeldrainUrl);

    if (normalized && normalized.includes('/api/file/')) {
        return normalized;
    }

    const response = await makeRequest(pixeldrainUrl, {
        parseHTML: true,
        timeout: 12000,
        headers: { 'User-Agent': OUO_USER_AGENT, 'Referer': pixeldrainUrl }
    });

    const direct = pickPixeldrainCandidate(
        extractRedirectCandidates(response.body, response.document, response.url || pixeldrainUrl)
    ) || response.url;

    return normalizePixeldrainUrl(direct);
}

/**
 * Resolve GoFile download link
 * Uses API with guest token and X-Website-Token header to get direct download link
 */
async function resolveGofileDownload(gofileUrl) {
    if (!gofileUrl) return null;

    try {
        // Extract content ID from URL (e.g., PyEEOi from https://gofile.io/d/PyEEOi)
        const contentIdMatch = gofileUrl.match(/gofile\.io\/d\/([A-Za-z0-9]+)/);
        if (!contentIdMatch) {
            console.log('[HTTP-RESOLVE] GoFile: Could not extract content ID from URL');
            return null;
        }
        const contentId = contentIdMatch[1];
        console.log(`[HTTP-RESOLVE] GoFile: Resolving content ID ${contentId}`);

        // Step 1: Create guest account to get token
        const tokens = await fetchGofileGuestToken();
        const guestToken = tokens?.accountToken || null;
        const websiteToken = tokens?.websiteToken || null;

        // Step 2: Get content with X-Website-Token header
        const contentUrl = new URL(`https://api.gofile.io/contents/${contentId}`);
        contentUrl.searchParams.set('cache', 'true');
        contentUrl.searchParams.set('sortField', 'createTime');
        contentUrl.searchParams.set('sortDirection', '1');
        try {
            const baseHeaders = {
                'User-Agent': OUO_USER_AGENT,
                'Accept': '*/*',
                'Origin': 'https://gofile.io',
                'Referer': 'https://gofile.io/'
            };

            const fetchContent = async (headers) => {
                const response = await makeRequest(contentUrl.toString(), {
                    timeout: GOFILE_REQUEST_TIMEOUT_MS,
                    serviceName: 'gofile',
                    headers
                });
                return JSON.parse(response.body);
            };

            let contentData = null;
            if (guestToken) {
                const authHeaders = {
                    ...baseHeaders,
                    'Authorization': `Bearer ${guestToken}`,
                    'Cookie': `accountToken=${guestToken}`,
                    'X-Website-Token': websiteToken || '4fd6sg89d7s6'
                };
                contentData = await fetchContent(authHeaders);

                if (contentData.status === 'error-notPremium' && websiteToken) {
                    console.log('[HTTP-RESOLVE] GoFile: Retry with fallback website token');
                    contentData = await fetchContent({
                        ...baseHeaders,
                        'Authorization': `Bearer ${guestToken}`,
                        'Cookie': `accountToken=${guestToken}`,
                        'X-Website-Token': '4fd6sg89d7s6'
                    });
                }
            } else {
                console.log('[HTTP-RESOLVE] GoFile: No token available, trying unauthenticated content request');
            }

            if (!contentData || contentData.status === 'error-notPremium') {
                contentData = await fetchContent({
                    ...baseHeaders,
                    'X-Website-Token': '4fd6sg89d7s6'
                });
            }

            if (contentData.status === 'ok' && contentData.data) {
                const data = contentData.data;
                if (data.passwordStatus && data.passwordStatus !== 'passwordOk') {
                    console.log('[HTTP-RESOLVE] GoFile: Password required or invalid');
                    return null;
                }

                if (data.type && data.type !== 'folder' && data.link) {
                    console.log(`[HTTP-RESOLVE] GoFile: Found file "${data.name || 'unknown'}"`);
                    if (guestToken) {
                        cacheGofileToken(data.link, { accountToken: guestToken, websiteToken });
                    }
                    return data.link;
                }

                if (data.children) {
                    const items = Object.values(data.children)
                        .filter(item => item?.type === 'file' && item.link);

                    const preferred = items.find(item => {
                        const extension = getFileExtension(item.name || item.link || '').toLowerCase();
                        return extension && VIDEO_EXTENSIONS.has(extension);
                    }) || items[0];

                    if (preferred) {
                        console.log(`[HTTP-RESOLVE] GoFile: Found file "${preferred.name || 'unknown'}"`);
                        if (guestToken) {
                            cacheGofileToken(preferred.link, { accountToken: guestToken, websiteToken });
                        }
                        return preferred.link;
                    }
                }

                console.log('[HTTP-RESOLVE] GoFile: No files found in content');
            } else {
                console.log(`[HTTP-RESOLVE] GoFile: API status: ${contentData.status}`);
            }
        } catch (e) {
            console.log(`[HTTP-RESOLVE] GoFile: API error: ${e.message}`);
        }

        return null;
    } catch (error) {
        console.log(`[HTTP-RESOLVE] GoFile: Error resolving: ${error.message}`);
        return null;
    }
}

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

async function fetchWithUndici(url, { method = 'GET', headers = {}, timeout = 12000, body = null } = {}) {
    if (typeof fetch !== 'function') return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
        const response = await fetch(url, {
            method,
            headers,
            body,
            redirect: 'follow',
            signal: controller.signal
        });
        const text = await response.text();
        return {
            body: text,
            url: response.url || url,
            document: cheerio.load(text),
            statusCode: response.status,
            headers: Object.fromEntries(response.headers.entries())
        };
    } catch (error) {
        console.log(`[HTTP-RESOLVE] Undici fetch error: ${error.message}`);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

async function getOrCreateFlareSession(domain) {
    if (!FLARESOLVERR_URL || !domain) return null;
    const cached = flareSessionCache.get(domain);
    if (cached && (Date.now() - cached.ts) < FLARE_SESSION_TTL) {
        return cached.sessionId;
    }

    const sessionId = `sootio_http_${domain.replace(/\./g, '_')}`;

    try {
        const list = await axios.post(`${FLARESOLVERR_URL}/v1`, { cmd: 'sessions.list' }, {
            timeout: 10000,
            headers: { 'Content-Type': 'application/json' }
        });
        if (list.data?.sessions?.includes(sessionId)) {
            flareSessionCache.set(domain, { sessionId, ts: Date.now() });
            return sessionId;
        }
    } catch {
        // ignore list errors
    }

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
            return sessionId;
        }
    } catch (error) {
        if (error.response?.data?.message?.includes('already exists')) {
            flareSessionCache.set(domain, { sessionId, ts: Date.now() });
            return sessionId;
        }
        console.log(`[HTTP-RESOLVE] FlareSolverr session create failed: ${error.message}`);
    }

    return null;
}

async function fetchWithFlareSolverr(url, { method = 'GET', postData = null, headers = {}, timeout = FLARESOLVERR_TIMEOUT } = {}) {
    if (!FLARESOLVERR_URL) return null;

    const domain = (() => {
        try { return new URL(url).hostname; } catch { return null; }
    })();
    const sessionId = await getOrCreateFlareSession(domain);
    const hasSession = Boolean(sessionId);

    const flareTimeout = hasSession
        ? Math.max(timeout || 0, 30000)
        : Math.max((timeout || 0) * 4, 60000);

    const requestBody = {
        cmd: method === 'POST' ? 'request.post' : 'request.get',
        url,
        maxTimeout: flareTimeout,
        headers
    };

    const userAgent = headers['User-Agent'] || headers['user-agent'];
    if (userAgent) {
        requestBody.userAgent = userAgent;
    }

    if (sessionId) {
        requestBody.session = sessionId;
    }
    if (postData) {
        requestBody.postData = postData;
    }

    try {
        const response = await axios.post(`${FLARESOLVERR_URL}/v1`, requestBody, {
            timeout: flareTimeout + 5000,
            headers: { 'Content-Type': 'application/json' }
        });

        if (response.data?.status === 'ok' && response.data?.solution?.response) {
            const body = response.data.solution.response;
            const finalUrl = response.data.solution.url || url;
            const statusCode = response.data.solution.status;
            const responseHeaders = response.data.solution.headers || {};
            return {
                body,
                url: finalUrl,
                document: cheerio.load(body),
                statusCode,
                headers: responseHeaders
            };
        }

        console.log(`[HTTP-RESOLVE] FlareSolverr response status: ${response.data?.status} message: ${response.data?.message || 'n/a'}`);
        if (hasSession && domain) {
            flareSessionCache.delete(domain);
        }
    } catch (error) {
        console.log(`[HTTP-RESOLVE] FlareSolverr error: ${error.message}`);
        if (hasSession && domain) {
            flareSessionCache.delete(domain);
        }
    }

    return null;
}

async function fetchWithCloudflare(url, options = {}) {
    const {
        preferFlareSolverr = false,
        method = 'GET',
        headers = {},
        timeout,
        body,
        ...rest
    } = options;

    const requestOptions = {
        method,
        headers,
        timeout,
        body,
        ...rest,
        parseHTML: true
    };

    const runFlareSolverr = async () => {
        const flareResponse = await fetchWithFlareSolverr(url, {
            method,
            headers,
            timeout,
            postData: body || null
        });
        if (!flareResponse) {
            return null;
        }
        if (isCloudflareChallenge(flareResponse.body || '', flareResponse.statusCode)) {
            const snippet = (flareResponse.body || '').replace(/\s+/g, ' ').slice(0, 160);
            console.log(`[HTTP-RESOLVE] FlareSolverr still blocked for ${url}: ${snippet}`);
        }
        return flareResponse;
    };

    if (FLARESOLVERR_URL && preferFlareSolverr) {
        const flareResponse = await runFlareSolverr();
        if (flareResponse && !isCloudflareChallenge(flareResponse.body || '', flareResponse.statusCode)) {
            return flareResponse;
        }
    }

    let response = null;
    try {
        response = await makeRequest(url, requestOptions);
    } catch (error) {
        if (!FLARESOLVERR_URL) {
            throw error;
        }
    }

    if (response && !isCloudflareChallenge(response.body || '', response.statusCode)) {
        return response;
    }

    if (response && isCloudflareChallenge(response.body || '', response.statusCode)) {
        const undiciResponse = await fetchWithUndici(url, { method, headers, timeout, body });
        if (undiciResponse && !isCloudflareChallenge(undiciResponse.body || '', undiciResponse.statusCode)) {
            return undiciResponse;
        }
    }

    if (!FLARESOLVERR_URL) {
        return response;
    }

    console.log('[HTTP-RESOLVE] Cloudflare challenge detected, using FlareSolverr');
    const flareResponse = await runFlareSolverr();
    if (flareResponse) {
        return flareResponse;
    }

    if (response) {
        return response;
    }

    throw new Error('FlareSolverr failed to fetch Cloudflare-protected page');
}

async function fetchOuoPage(url, options = {}) {
    return fetchWithCloudflare(url, { ...options, preferFlareSolverr: true });
}

async function resolveOuoLink(shortUrl, hints = {}) {
    let cookieHeader = OUO_COOKIE || '';
    if (cookieHeader) {
        console.log('[HTTP-RESOLVE] Using OUO cookie for resolution');
    }
    let request = { url: shortUrl, method: 'GET', body: null, referer: null };
    const visited = new Set();
    const maxSteps = 4;

    for (let step = 0; step < maxSteps; step += 1) {
        const visitKey = `${request.method}:${request.url}:${request.body || ''}`;
        if (visited.has(visitKey)) {
            console.log('[HTTP-RESOLVE] Ouo loop detected, aborting');
            return null;
        }
        visited.add(visitKey);

        const response = await fetchOuoPage(request.url, {
            method: request.method,
            body: request.body,
            headers: {
                'User-Agent': OUO_USER_AGENT,
                'Referer': request.referer || request.url,
                ...(cookieHeader ? { 'Cookie': cookieHeader } : {}),
                ...(request.method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {})
            }
        });

        cookieHeader = mergeCookieHeader(cookieHeader, response.headers?.['set-cookie']);

        const directFromPage = pickFirstExternalCandidate(
            extractRedirectCandidates(response.body, response.document, response.url || request.url),
            response.url || request.url,
            [...PIXELDRAIN_HOSTS, ...VIEWCRATE_HOSTS, ...GOFILE_HOSTS, hints.host]
        );
        if (directFromPage) {
            const directHost = normalizeHostHint(directFromPage);
            const hintHost = normalizeHostHint(hints.host || null);
            if (hintHost && directHost && directHost !== hintHost) {
                console.log(`[HTTP-RESOLVE] Skipping ${directHost} link due to host hint`);
            } else {
                return directFromPage;
            }
        }

        const viewcrateCandidates = collectViewcrateEntries(response.document, response.url || request.url);
        const orderedCandidates = orderViewcrateCandidates(viewcrateCandidates, hints);
        for (const entry of orderedCandidates) {
            if (!entry?.getUrl) continue;
            const direct = await resolveViewcrateGetLink(entry.getUrl, response.url || request.url);
            if (direct) return direct;
            if (entry.host) {
                console.log(`[HTTP-RESOLVE] ViewCrate candidate failed for host ${entry.host}`);
            }
        }

        if (response.url && !OUO_HOSTS.some(host => response.url.includes(host))) {
            return response.url;
        }

        const $ = response.document;
        const button = $ ? $(`#${OUO_BUTTON_ID}`) : null;
        let form = button && button.length ? button.closest('form') : null;
        if (!form || !form.length) {
            form = $ ? $('form').first() : null;
        }

        if (!form || !form.length) {
            const snippet = (response.body || '').replace(/\s+/g, ' ').slice(0, 160);
            console.log(`[HTTP-RESOLVE] Ouo page missing form (status ${response.statusCode || 'unknown'}): ${snippet}`);
            return null;
        }

        const actionHint = button?.attr('formaction') || null;
        const action = form.attr('action') || actionHint || request.url;
        const method = (form.attr('method') || 'POST').toUpperCase();
        const actionUrl = normalizeAbsoluteUrl(action, request.url) || request.url;

        const formData = {};
        const inputs = form.find('input[name]').length ? form.find('input[name]') : ($ ? $('input[name]') : []);
        inputs.each((_, input) => {
            const name = $(input).attr('name');
            const value = $(input).attr('value') || '';
            if (name) formData[name] = value;
        });

        const submitButton = button && button.length ? button : form.find('button[type="submit"], input[type="submit"]').first();
        if (submitButton?.length) {
            const name = submitButton.attr('name');
            const value = submitButton.attr('value') || submitButton.text().trim() || '1';
            if (name && !formData[name]) {
                formData[name] = value;
            }
        }

        if (!actionUrl || actionUrl === request.url) {
            const actionMatch = response.body?.match(/\/go\/[A-Za-z0-9]+/);
            const derived = actionMatch ? normalizeAbsoluteUrl(actionMatch[0], request.url) : null;
            if (derived) {
                request = { url: derived, method: 'GET', body: null, referer: request.url };
                continue;
            }
        }

        const body = new URLSearchParams(formData).toString();
        if (method === 'GET') {
            const connector = actionUrl.includes('?') ? '&' : '?';
            const urlWithQuery = body ? `${actionUrl}${connector}${body}` : actionUrl;
            request = { url: urlWithQuery, method: 'GET', body: null, referer: request.url };
        } else {
            request = { url: actionUrl, method: 'POST', body, referer: request.url };
        }
    }

    return null;
}

async function resolveViewcrateLink(viewcrateUrl, hints = {}) {
    if (VIEWCRATE_COOKIE) {
        console.log('[HTTP-RESOLVE] Using ViewCrate cookie for resolution');
    }
    const response = await fetchWithCloudflare(viewcrateUrl, {
        timeout: 12000,
        headers: {
            'User-Agent': OUO_USER_AGENT,
            ...(VIEWCRATE_COOKIE ? { 'Cookie': VIEWCRATE_COOKIE } : {})
        },
        // When cookie is provided, try direct request first (cookie is tied to User-Agent)
        preferFlareSolverr: !VIEWCRATE_COOKIE
    });

    const $ = response.document;
    if (!$) {
        return null;
    }

    let candidates = collectViewcrateEntries($, response.url || viewcrateUrl);
    if (candidates.length === 0) {
        candidates = collectViewcrateEncryptedEntries(response.body || '', response.url || viewcrateUrl);
        if (candidates.length) {
            console.log(`[HTTP-RESOLVE] ViewCrate decrypted ${candidates.length} entries`);
        }
    }

    if (candidates.length === 0) {
        console.log('[HTTP-RESOLVE] ViewCrate entries not found in HTML or encrypted payload');
        return null;
    }

    const ordered = orderViewcrateCandidates(candidates, hints);
    for (const entry of ordered) {
        if (!entry?.getUrl) continue;
        const direct = await resolveViewcrateGetLink(entry.getUrl, viewcrateUrl);
        if (direct) return direct;
        if (entry.host) {
            console.log(`[HTTP-RESOLVE] ViewCrate candidate failed for host ${entry.host}`);
        }
    }

    return null;
}

function getFileExtension(urlString) {
    try {
        const cleanedUrl = urlString.split('?')[0].split('#')[0];
        const lastSlash = cleanedUrl.lastIndexOf('/');
        const filename = lastSlash >= 0 ? cleanedUrl.slice(lastSlash + 1) : cleanedUrl;
        const lastDot = filename.lastIndexOf('.');
        if (lastDot === -1) {
            return '';
        }
        return filename.slice(lastDot);
    } catch {
        return '';
    }
}

function evaluateVideoCandidate(candidate) {
    if (!candidate?.url) {
        return { isVideo: false, reason: 'missing URL' };
    }

    const urlLower = candidate.url.toLowerCase();

    if (TRUSTED_VIDEO_HOST_HINTS.some(host => urlLower.includes(host))) {
        return { isVideo: true };
    }

    const extension = getFileExtension(urlLower);
    if (extension) {
        if (NON_VIDEO_EXTENSIONS.has(extension)) {
            return { isVideo: false, reason: `${extension} file` };
        }
        if (VIDEO_EXTENSIONS.has(extension)) {
            return { isVideo: true };
        }
    }

    const label = `${candidate.title || ''} ${candidate.name || ''}`.toLowerCase();
    if (label) {
        if (VIDEO_EXTENSION_LIST.some(ext => label.includes(ext))) {
            return { isVideo: true };
        }
        if (NON_VIDEO_EXTENSION_LIST.some(ext => label.includes(ext))) {
            return { isVideo: false, reason: 'non-video label' };
        }
    }

    if (candidate.type) {
        const typeLower = candidate.type.toLowerCase();
        if (VIDEO_TYPE_HINTS.some(type => typeLower.includes(type))) {
            return { isVideo: true };
        }
        if (typeLower.includes('zip') || typeLower.includes('rar')) {
            return { isVideo: false, reason: 'non-video type' };
        }
    }

    // Default to video when we can't confidently determine the file type
    return { isVideo: true };
}

async function findSeekableLink(results, { timeoutMs = FAST_SEEK_TIMEOUT_MS, maxParallel = MAX_PARALLEL_VALIDATIONS } = {}) {
    if (!Array.isArray(results) || results.length === 0) {
        return null;
    }

    const cache = new Map();

    const checkUrl = async (candidate, label) => {
        if (!candidate?.url) return false;
        if (cache.has(candidate.url)) {
            return cache.get(candidate.url);
        }

        const { isVideo, reason } = evaluateVideoCandidate(candidate);
        if (!isVideo) {
            console.log(`[HTTP-RESOLVE] Skipping ${label} link because it is not a video file${reason ? ` (${reason})` : ''}`);
            cache.set(candidate.url, false);
            return false;
        }

        try {
            const validation = await validateSeekableUrl(candidate.url, {
                requirePartialContent: true,
                timeout: timeoutMs
            });

            // Check if the extracted filename reveals this is actually a non-video file (e.g., .zip)
            // This catches cases where trusted hosts serve ZIP files with obfuscated URLs
            if (validation.filename) {
                const filenameLower = validation.filename.toLowerCase();
                const isNonVideoFile = NON_VIDEO_EXTENSION_LIST.some(ext => filenameLower.endsWith(ext));
                if (isNonVideoFile) {
                    console.log(`[HTTP-RESOLVE] Skipping ${label} link - Content-Disposition reveals non-video file: ${validation.filename}`);
                    cache.set(candidate.url, false);
                    return false;
                }
            }

            if (validation.isValid) {
                console.log(`[HTTP-RESOLVE] Selected ${label} link with confirmed 206 support`);
                cache.set(candidate.url, true);
                return true;
            }
            console.log(`[HTTP-RESOLVE] Rejected ${label} link (status: ${validation.statusCode || 'unknown'}) due to missing 206 support`);
            cache.set(candidate.url, false);
            return false;
        } catch (error) {
            console.error(`[HTTP-RESOLVE] Error validating ${label} link: ${error.message}`);
            cache.set(candidate.url, false);
            return false;
        }
    };

    // Sort by priority field from extraction (higher priority first), then deduplicate by URL
    const seen = new Set();
    const candidates = [];

    // Sort results by priority (descending) - extraction already set priority based on button labels
    const sortedResults = [...results].sort((a, b) => {
        const priorityA = a.priority ?? 0;
        const priorityB = b.priority ?? 0;
        return priorityB - priorityA; // Higher priority first
    });

    for (const candidate of sortedResults) {
        if (!candidate?.url || seen.has(candidate.url)) {
            continue;
        }

        const label = candidate.serverType || candidate.name || 'Unknown';
        candidates.push({ candidate, label });
        seen.add(candidate.url);
    }

    console.log(`[HTTP-RESOLVE] Testing ${candidates.length} candidates in priority order:`);
    candidates.forEach((entry, idx) => {
        console.log(`[HTTP-RESOLVE]   ${idx + 1}. [${entry.label}] priority=${entry.candidate.priority ?? 0}`);
    });

    // Validate candidates in small parallel batches to cut down total resolve time
    const batchSize = Math.max(1, maxParallel);
    for (let i = 0; i < candidates.length; i += batchSize) {
        const batch = candidates.slice(i, i + batchSize);
        const validationResults = await Promise.all(
            batch.map(entry => checkUrl(entry.candidate, entry.label))
        );
        const winnerIndex = validationResults.findIndex(Boolean);
        if (winnerIndex !== -1) {
            return batch[winnerIndex].candidate.url;
        }
    }

    return null;
}

/**
 * Resolve a redirect URL to its final direct streaming link
 * Handles lazy-load resolution for 4KHDHub, HDHub4u, and UHDMovies
 * This is called when the user selects a stream, providing lazy resolution
 * Steps: 1) Resolve redirect to file hosting URL, 2) Extract/decrypt to final stream URL, 3) Validate with 206 check
 * @param {string} redirectUrl - Original redirect URL that needs resolution + decryption
 * @returns {Promise<string|null>} - Final direct streaming URL with confirmed 206 support
 */
export async function resolveHttpStreamUrl(redirectUrl) {
    const decodedUrl = decodeURIComponent(redirectUrl);
    const { baseUrl, hints } = parseStreamHints(decodedUrl);
    const cacheKey = decodedUrl;

    const now = Date.now();
    const cached = resolveCache.get(cacheKey);
    if (cached) {
        if (cached.value && now - cached.ts < RESOLVE_CACHE_TTL) {
            console.log('[HTTP-RESOLVE] Using cached result');
            return cached.value;
        }
        if (cached.promise) {
            console.log('[HTTP-RESOLVE] Joining in-flight resolve');
            return cached.promise;
        }
    }

    const resolverPromise = (async () => {
        console.log('[HTTP-RESOLVE] Starting lazy resolution (on-demand extraction + validation)');
        let workingUrl = baseUrl;
        console.log('[HTTP-RESOLVE] Redirect URL:', decodedUrl.substring(0, 100) + '...');

        if (OUO_HOSTS.some(host => workingUrl.includes(host))) {
            console.log('[HTTP-RESOLVE] Ouo short link detected, resolving...');
            try {
                const resolved = await resolveOuoLink(workingUrl, hints);
                if (!resolved) {
                    console.log('[HTTP-RESOLVE] Failed to resolve Ouo link');
                    resolveCache.set(cacheKey, { value: null, ts: Date.now() });
                    return null;
                }
                workingUrl = resolved;
                console.log('[HTTP-RESOLVE] Ouo link resolved to:', workingUrl.substring(0, 100) + '...');
            } catch (err) {
                console.log(`[HTTP-RESOLVE] Ouo resolution failed: ${err.message}`);
                resolveCache.set(cacheKey, { value: null, ts: Date.now() });
                return null;
            }
        }

        if (VIEWCRATE_HOSTS.some(host => workingUrl.includes(host))) {
            console.log('[HTTP-RESOLVE] ViewCrate link detected, extracting Pixeldrain URL...');
            try {
                const resolved = await resolveViewcrateLink(workingUrl, hints);
                if (!resolved) {
                    console.log('[HTTP-RESOLVE] Failed to extract Pixeldrain link from ViewCrate');
                    resolveCache.set(cacheKey, { value: null, ts: Date.now() });
                    return null;
                }
                workingUrl = resolved;
                console.log('[HTTP-RESOLVE] ViewCrate resolved to:', workingUrl.substring(0, 100) + '...');
            } catch (err) {
                console.log(`[HTTP-RESOLVE] ViewCrate resolution failed: ${err.message}`);
                resolveCache.set(cacheKey, { value: null, ts: Date.now() });
                return null;
            }
        }

        // Handle direct GoFile content URLs (gofile.io/d/xxx)
        if (GOFILE_HOSTS.some(host => workingUrl.includes(host)) && workingUrl.includes('/d/')) {
            console.log('[HTTP-RESOLVE] GoFile content link detected, resolving...');
            try {
                const resolved = await resolveGofileDownload(workingUrl);
                if (resolved) {
                    console.log('[HTTP-RESOLVE] GoFile resolved to:', resolved.substring(0, 100) + '...');
                    resolveCache.set(cacheKey, { value: resolved, ts: Date.now() });
                    return resolved;
                }
                console.log('[HTTP-RESOLVE] Failed to resolve GoFile content');
                resolveCache.set(cacheKey, { value: null, ts: Date.now() });
                return null;
            } catch (err) {
                console.log(`[HTTP-RESOLVE] GoFile resolution failed: ${err.message}`);
                resolveCache.set(cacheKey, { value: null, ts: Date.now() });
                return null;
            }
        }

        // Detect provider type from URL
        let provider = 'Unknown';
        if (workingUrl.includes('hubcloud') || workingUrl.includes('hubdrive') || workingUrl.includes('4khdhub')) {
            provider = '4KHDHub/HDHub4u';
        } else if (workingUrl.includes('hubcdn.fans')) {
            provider = 'HDHub4u';
        }
        console.log('[HTTP-RESOLVE] Detected provider:', provider);

        // Handle gdlink.dev directly via extractor path
        if (workingUrl.includes('gdlink.dev')) {
            console.log('[HTTP-RESOLVE] gdlink.dev detected, attempting extractor resolution');
            try {
                const extracted = await processExtractorLinkWithAwait(workingUrl, 99) || [];
                const seekable = await findSeekableLink(extracted);
                resolveCache.set(cacheKey, { value: seekable, ts: Date.now() });
                return seekable;
            } catch (err) {
                console.log(`[HTTP-RESOLVE] gdlink.dev resolution failed: ${err.message}`);
                resolveCache.set(cacheKey, { value: null, ts: Date.now() });
                return null;
            }
        }

        // Handle CineDoze links (cinedoze.tv/links/xxx -> savelinks.me -> hubcloud)
        if (workingUrl.includes('cinedoze.tv/links/')) {
            console.log('[HTTP-RESOLVE] CineDoze link detected, expanding to HubCloud URL...');
            try {
                // Follow redirect to savelinks.me and extract HubCloud link
                const response = await makeRequest(workingUrl, { parseHTML: false, timeout: 12000 });
                const body = response.body || '';

                // Extract hubcloud/hubdrive links from the page
                const hubcloudMatch = body.match(/https?:\/\/[^\s"'<>]*(?:hubcloud|hubdrive|hubcdn)[^\s"'<>]*/gi);
                if (hubcloudMatch && hubcloudMatch.length > 0) {
                    const hubcloudUrl = hubcloudMatch[0];
                    console.log(`[HTTP-RESOLVE] Extracted HubCloud URL: ${hubcloudUrl.substring(0, 80)}...`);

                    // Now process the HubCloud URL through the extractor
                    const extracted = await processExtractorLinkWithAwait(hubcloudUrl, 99) || [];
                    const seekable = await findSeekableLink(extracted);
                    resolveCache.set(cacheKey, { value: seekable, ts: Date.now() });
                    return seekable;
                }
                console.log('[HTTP-RESOLVE] No HubCloud link found in CineDoze page');
                resolveCache.set(cacheKey, { value: null, ts: Date.now() });
                return null;
            } catch (err) {
                console.log(`[HTTP-RESOLVE] CineDoze resolution failed: ${err.message}`);
                resolveCache.set(cacheKey, { value: null, ts: Date.now() });
                return null;
            }
        }

        // Fast-path: direct hosts (workers/hubcdn/r2) — validate and return without extractor
        if (DIRECT_HOST_HINTS.some(h => workingUrl.includes(h))) {
            console.log('[HTTP-RESOLVE] Direct host detected, performing fast 206 validation');
            try {
                const validation = await validateSeekableUrl(workingUrl, { requirePartialContent: true, timeout: FAST_SEEK_TIMEOUT_MS });
                if (validation.isValid) {
                    resolveCache.set(cacheKey, { value: workingUrl, ts: Date.now() });
                    return workingUrl;
                }
                console.log('[HTTP-RESOLVE] Direct host failed 206 validation');
            } catch (err) {
                console.log(`[HTTP-RESOLVE] Direct host validation error: ${err.message}`);
            }
        }

        const directEvaluation = evaluateVideoCandidate({ url: workingUrl });
        if (directEvaluation.isVideo) {
            try {
                const validation = await validateSeekableUrl(workingUrl, { requirePartialContent: true, timeout: FAST_SEEK_TIMEOUT_MS });
                if (validation.isValid) {
                    resolveCache.set(cacheKey, { value: workingUrl, ts: Date.now() });
                    return workingUrl;
                }
                console.log('[HTTP-RESOLVE] Direct-looking host failed 206 validation');
            } catch (err) {
                console.log(`[HTTP-RESOLVE] Direct-looking validation error: ${err.message}`);
            }
        }

        // Step 1: Resolve redirect to file hosting URL (hubcloud/hubdrive)
        let fileHostingUrl;
        const hasRedirectParam = /[?&]id=/i.test(workingUrl);
        if (hasRedirectParam) {
            console.log('[HTTP-RESOLVE] Resolving redirect to file hosting URL...');
            fileHostingUrl = await getRedirectLinks(workingUrl);
            if (!fileHostingUrl || !fileHostingUrl.trim()) {
                console.log('[HTTP-RESOLVE] Failed to resolve redirect');
                return null;
            }
            console.log('[HTTP-RESOLVE] Resolved to file hosting URL:', fileHostingUrl.substring(0, 100) + '...');
        } else {
            // Already a direct URL
            fileHostingUrl = workingUrl;
            console.log('[HTTP-RESOLVE] URL is already a file hosting URL');
        }

        // Step 2: Decrypt file hosting URL to final streaming URL
        console.log('[HTTP-RESOLVE] Decrypting file hosting URL...');
        const result = await processExtractorLinkWithAwait(fileHostingUrl, 99);  // Get ALL results, not just 1

        if (!result || !Array.isArray(result) || result.length === 0) {
            console.log('[HTTP-RESOLVE] No valid stream found after decryption');
            return null;
        }

        // Filter out null/empty entries defensively before logging/validation
        const sanitizedResults = result.filter(r => r && r.url);
        if (sanitizedResults.length === 0) {
            console.log('[HTTP-RESOLVE] No usable streams after filtering null/empty results');
            return null;
        }

        console.log(`[HTTP-RESOLVE] Found ${sanitizedResults.length} potential stream(s), selecting best one...`);

        // Log all results for debugging
        sanitizedResults.forEach((r, idx) => {
            const type = r.url.includes('pixeldrain') ? 'Pixeldrain' :
                r.url.includes('googleusercontent') ? 'GoogleUserContent' :
                    r.url.includes('workers.dev') ? 'Workers.dev' :
                        r.url.includes('hubcdn') ? 'HubCDN' :
                            r.url.includes('r2.dev') ? 'R2' : 'Other';
            console.log(`[HTTP-RESOLVE]   ${idx + 1}. [${type}] ${r.url.substring(0, 80)}...`);
        });

        const seekableLink = await findSeekableLink(sanitizedResults);
        if (seekableLink) {
            console.log(`[HTTP-RESOLVE] Returning seekable link: ${seekableLink.substring(0, 100)}...`);
            return seekableLink;
        }

        console.log('[HTTP-RESOLVE] No links with confirmed 206 support were found');
        return null;
    })();

    resolveCache.set(cacheKey, { promise: resolverPromise, ts: now });

    const result = await resolverPromise;
    resolveCache.set(cacheKey, { value: result, ts: Date.now() });
    return result;
}
