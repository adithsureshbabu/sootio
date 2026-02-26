/**
 * NetflixMirror search helpers
 * Provides bypass, search, and content loading for netflixmirror sites
 * Based on CSX NetflixMirrorProvider implementation
 */

import { makeRequest } from '../../utils/http.js';

// Configuration - domains may change (net20→net22, net51→net52 as of Feb 2026)
const MAIN_URL = process.env.NETFLIXMIRROR_MAIN_URL || 'https://net22.cc';
const STREAM_URL = process.env.NETFLIXMIRROR_STREAM_URL || 'https://net52.cc';
const IMG_CDN = 'https://imgcdn.kim';
const BYPASS_PATHS = (process.env.NETFLIXMIRROR_BYPASS_PATHS || '/p.php')
    .split(',')
    .map(path => path.trim())
    .filter(Boolean);
const BYPASS_COOKIE_NAMES = ['t_hash_t', 't_hash'];
const STREAM_BYPASS_PATHS = ['/tv/p.php', '/p.php'];
const DEFAULT_NETFLIXMIRROR_USER_TOKEN = process.env.NETFLIXMIRROR_USER_TOKEN || '233123f803cf02184bf6c67e149cdd50';

// Cookie cache with 15-hour TTL (same as CSX implementation)
let cachedCookie = null;
let cachedCookieName = 't_hash_t';
let cookieTimestamp = 0;
let cachedStreamCookies = null;
let streamCookieTimestamp = 0;
const COOKIE_TTL_MS = 54_000_000; // 15 hours

function extractAllCookiesFromHeaders(headers = {}) {
    const setCookie = headers['set-cookie'] || headers['Set-Cookie'];
    const cookieHeaders = Array.isArray(setCookie) ? setCookie : (setCookie ? [setCookie] : []);
    const cookies = {};

    for (const cookieHeader of cookieHeaders) {
        const match = String(cookieHeader).match(/^([^=;\s]+)=([^;]+)/);
        if (!match?.[1]) continue;
        cookies[match[1].toLowerCase()] = match[2];
    }

    return cookies;
}

function extractBypassCookieFromHeaders(headers = {}) {
    const setCookie = headers['set-cookie'];
    const cookieHeaders = Array.isArray(setCookie) ? setCookie : (setCookie ? [setCookie] : []);

    for (const cookieHeader of cookieHeaders) {
        const match = cookieHeader.match(/(t_hash_t|t_hash)=([^;]+)/i);
        if (match?.[1] && match?.[2]) {
            return {
                name: match[1].toLowerCase(),
                value: match[2]
            };
        }
    }

    return null;
}

function extractBypassCookieFromBody(text = '') {
    if (!text) return null;

    try {
        const json = JSON.parse(text);
        for (const cookieName of BYPASS_COOKIE_NAMES) {
            if (typeof json[cookieName] === 'string' && json[cookieName]) {
                return {
                    name: cookieName,
                    value: json[cookieName]
                };
            }
        }
    } catch {
        // Ignore non-JSON responses
    }

    return null;
}

function extractCookiesFromBody(text = '') {
    if (!text) return {};
    try {
        const json = JSON.parse(text);
        const cookies = {};
        for (const cookieName of BYPASS_COOKIE_NAMES) {
            if (typeof json[cookieName] === 'string' && json[cookieName]) {
                cookies[cookieName] = json[cookieName];
            }
        }
        return cookies;
    } catch {
        return {};
    }
}

/**
 * Bypass protection and get auth cookie
 * Makes repeated POST requests until we get a valid response
 */
export async function bypass(mainUrl = MAIN_URL) {
    // Check cached cookie
    const now = Date.now();
    if (cachedCookie && (now - cookieTimestamp < COOKIE_TTL_MS)) {
        console.log(`[NetflixMirror] Using cached cookie (${cachedCookieName}, age: ${Math.floor((now - cookieTimestamp) / 1000)}s)`);
        return cachedCookie;
    }

    console.log(`[NetflixMirror] Getting new bypass cookie from ${mainUrl}`);

    try {
        let attempts = 0;
        const maxAttempts = 10;
        let lastError = null;
        const paths = BYPASS_PATHS.length > 0 ? BYPASS_PATHS : ['/p.php', '/tv/p.php'];

        while (attempts < maxAttempts) {
            attempts++;
            for (const path of paths) {
                try {
                    const response = await makeRequest(`${mainUrl}${path}`, {
                        method: 'POST',
                        headers: {
                            'X-Requested-With': 'XMLHttpRequest',
                            'Content-Type': 'application/x-www-form-urlencoded',
                            'Accept': 'application/json, text/plain, */*',
                            'Origin': mainUrl,
                            'Referer': `${mainUrl}/`
                        },
                        timeout: 10000
                    });

                    const text = response.body || '';
                    const snippet = text.replace(/\s+/g, ' ').trim().substring(0, 100);
                    console.log(`[NetflixMirror] Bypass attempt ${attempts} (${path}): ${snippet}`);

                    const responseLooksValid = text.includes('"r":"n"') || text.includes('"r": "n"');
                    const parsedCookie = extractBypassCookieFromHeaders(response.headers) || extractBypassCookieFromBody(text);

                    if (parsedCookie) {
                        cachedCookie = parsedCookie.value;
                        cachedCookieName = parsedCookie.name;
                        cookieTimestamp = Date.now();
                        const mode = responseLooksValid ? 'validated' : 'header-only';
                        console.log(`[NetflixMirror] Got bypass cookie (${cachedCookieName}, ${mode}): ${cachedCookie.substring(0, 10)}...`);
                        return cachedCookie;
                    }
                } catch (error) {
                    lastError = error;
                    console.log(`[NetflixMirror] Bypass attempt ${attempts} (${path}) failed: ${error.message}`);
                }
            }

            // Small delay between attempts
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        console.error(`[NetflixMirror] Failed to get bypass cookie after ${maxAttempts} attempts (paths: ${paths.join(', ')})`);
        if (lastError) {
            console.error(`[NetflixMirror] Last bypass error: ${lastError.message}`);
        }
        return null;
    } catch (error) {
        console.error(`[NetflixMirror] Bypass error: ${error.message}`);
        cachedCookie = null;
        cachedCookieName = 't_hash_t';
        cookieTimestamp = 0;
        return null;
    }
}

async function bypassStreamCookies(signal = null) {
    const now = Date.now();
    if (cachedStreamCookies && (now - streamCookieTimestamp < COOKIE_TTL_MS)) {
        console.log(`[NetflixMirror] Using cached stream cookies (age: ${Math.floor((now - streamCookieTimestamp) / 1000)}s)`);
        return { ...cachedStreamCookies };
    }

    console.log(`[NetflixMirror] Getting stream bypass cookies from ${STREAM_URL}`);

    let attempts = 0;
    const maxAttempts = 6;
    let lastError = null;

    while (attempts < maxAttempts) {
        attempts++;
        for (const path of STREAM_BYPASS_PATHS) {
            try {
                const response = await makeRequest(`${STREAM_URL}${path}`, {
                    method: 'POST',
                    headers: {
                        'X-Requested-With': 'XMLHttpRequest',
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Accept': 'application/json, text/plain, */*',
                        'Origin': STREAM_URL,
                        'Referer': `${STREAM_URL}/`
                    },
                    timeout: 10000,
                    signal
                });

                const headerCookies = extractAllCookiesFromHeaders(response.headers);
                const bodyCookies = extractCookiesFromBody(response.body || '');
                const merged = { ...headerCookies, ...bodyCookies };

                const hasStreamCookie = Boolean(merged.t_hash_t || merged.t_hash);
                const snippet = (response.body || '').replace(/\s+/g, ' ').slice(0, 80);
                console.log(`[NetflixMirror] Stream bypass attempt ${attempts} (${path}): ${snippet}`);

                if (hasStreamCookie) {
                    cachedStreamCookies = merged;
                    streamCookieTimestamp = Date.now();
                    console.log(`[NetflixMirror] Got stream cookies: ${Object.keys(merged).join(', ')}`);
                    return { ...merged };
                }
            } catch (error) {
                lastError = error;
                console.log(`[NetflixMirror] Stream bypass attempt ${attempts} (${path}) failed: ${error.message}`);
            }
        }

        await new Promise(resolve => setTimeout(resolve, 500));
    }

    if (lastError) {
        console.log(`[NetflixMirror] Stream bypass failed: ${lastError.message}`);
    } else {
        console.log('[NetflixMirror] Stream bypass failed: no cookies returned');
    }
    return null;
}

/**
 * Get common cookies for requests
 */
function getCookies(hashCookie, overrides = {}) {
    const cookies = { ...overrides };

    if (hashCookie) {
        if (!cookies.t_hash) cookies.t_hash = hashCookie;
        if (!cookies.t_hash_t) cookies.t_hash_t = hashCookie;
    }

    if (!cookies.user_token) cookies.user_token = DEFAULT_NETFLIXMIRROR_USER_TOKEN;
    if (!cookies.ott) cookies.ott = 'nf';
    if (!cookies.hd) cookies.hd = 'on';

    return cookies;
}

/**
 * Format cookies for header
 */
function formatCookieHeader(cookies) {
    return Object.entries(cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');
}

async function getNetflixMirrorVideoToken(id, cookie, signal = null) {
    if (!id || !cookie) return null;

    try {
        const streamBypassCookies = await bypassStreamCookies(signal);
        const playInitCookies = getCookies(cookie, {
            ...(streamBypassCookies?.t_hash_t ? { t_hash_t: streamBypassCookies.t_hash_t } : {})
        });

        const playInit = await makeRequest(`${MAIN_URL}/play.php`, {
            method: 'POST',
            headers: {
                'X-Requested-With': 'XMLHttpRequest',
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'Cookie': formatCookieHeader(playInitCookies),
                'Referer': `${MAIN_URL}/`,
                'Origin': MAIN_URL
            },
            body: `id=${encodeURIComponent(id)}`,
            timeout: 15000,
            signal
        });

        const playInitJson = JSON.parse(playInit.body || '{}');
        const hQuery = playInitJson?.h;
        if (!hQuery || typeof hQuery !== 'string') {
            console.log('[NetflixMirror] play.php init did not return h token query');
            return null;
        }

        const iframeCookies = getCookies(streamBypassCookies?.t_hash || cookie, streamBypassCookies || {});
        const iframeResponse = await makeRequest(`${STREAM_URL}/play.php?id=${encodeURIComponent(id)}&${hQuery}`, {
            headers: {
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-GB,en;q=0.9',
                'Cookie': formatCookieHeader(iframeCookies),
                'Connection': 'keep-alive',
                'Referer': `${MAIN_URL}/`,
                'Sec-Fetch-Dest': 'iframe',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'cross-site',
                'Sec-Fetch-User': '?1',
                'Upgrade-Insecure-Requests': '1',
                'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
            },
            timeout: 15000,
            signal
        });

        const body = iframeResponse.body || '';
        const bodyToken = body.match(/<body[^>]*\bdata-h=["']([^"']+)["']/i)?.[1]
            || body.match(/\bdata-h=["']([^"']+)["']/i)?.[1];

        if (!bodyToken) {
            console.log('[NetflixMirror] Could not extract data-h token from play iframe');
            return null;
        }

        return bodyToken;
    } catch (error) {
        console.log(`[NetflixMirror] Video token fetch failed: ${error.message}`);
        return null;
    }
}

/**
 * Search for content
 * @param {string} query - Search query
 * @returns {Promise<Array>} Search results
 */
export async function searchNetflixMirror(query, signal = null) {
    if (!query) return [];

    const cookie = await bypass();
    if (!cookie) {
        console.error(`[NetflixMirror] No bypass cookie available for search`);
        return [];
    }

    const unixTime = Math.floor(Date.now() / 1000);
    const searchUrl = `${MAIN_URL}/search.php?s=${encodeURIComponent(query)}&t=${unixTime}`;

    console.log(`[NetflixMirror] Searching: ${searchUrl}`);

    try {
        const response = await makeRequest(searchUrl, {
            headers: {
                'X-Requested-With': 'XMLHttpRequest',
                'Cookie': formatCookieHeader(getCookies(cookie)),
                'Referer': `${MAIN_URL}/home`
            },
            timeout: 15000,
            signal
        });

        const data = JSON.parse(response.body);

        if (!data.searchResult || !Array.isArray(data.searchResult)) {
            console.log(`[NetflixMirror] No search results found`);
            return [];
        }

        const results = data.searchResult.map(item => ({
            id: item.id,
            title: item.t,
            poster: `${IMG_CDN}/poster/v/${item.id}.jpg`,
            type: data.type === 1 ? 'series' : 'movie'
        }));

        console.log(`[NetflixMirror] Found ${results.length} search results`);
        return results;
    } catch (error) {
        console.error(`[NetflixMirror] Search failed: ${error.message}`);
        return [];
    }
}

/**
 * Load content details (metadata and episodes)
 * For movies: skip post.php (broken) and use search ID directly with playlist
 * For series: attempt post.php, fall back to direct episode construction
 * @param {string} id - Content ID
 * @param {string} searchTitle - Title from search results
 * @param {string} searchType - Type from search results ('movie' or 'series')
 * @returns {Promise<Object>} Content details
 */
export async function loadNetflixMirrorContent(id, signal = null, searchTitle = '', searchType = 'movie') {
    if (!id) return null;

    // For movies, we can skip post.php entirely and use the ID directly
    // The playlist endpoint accepts the content ID for movies
    if (searchType === 'movie') {
        console.log(`[NetflixMirror] Movie detected, using search ID directly (skipping post.php)`);
        return {
            id,
            title: searchTitle,
            type: 'movie',
            poster: `${IMG_CDN}/poster/v/${id}.jpg`,
            backdrop: `${IMG_CDN}/poster/h/${id}.jpg`,
            episodes: [{ id, title: searchTitle, episode: null, season: null }]
        };
    }

    // For series, try post.php first then fall back
    const cookie = await bypass();
    if (!cookie) {
        console.error(`[NetflixMirror] No bypass cookie available for load`);
        return null;
    }

    const unixTime = Math.floor(Date.now() / 1000);
    const postUrl = `${MAIN_URL}/post.php?id=${id}&t=${unixTime}`;

    console.log(`[NetflixMirror] Loading content: ${postUrl}`);

    try {
        const response = await makeRequest(postUrl, {
            headers: {
                'X-Requested-With': 'XMLHttpRequest',
                'Cookie': formatCookieHeader(getCookies(cookie)),
                'Referer': `${MAIN_URL}/home`
            },
            timeout: 15000,
            signal
        });

        const data = JSON.parse(response.body);

        if (!data || typeof data !== 'object' || data.status === 'n' || data.error) {
            console.log(`[NetflixMirror] post.php rejected (${data?.error || 'unknown'}), falling back to direct playlist for series`);
            // Fallback: treat it like a movie - use content ID directly
            // The playlist endpoint may still work with the show ID
            return {
                id,
                title: searchTitle,
                type: 'series',
                poster: `${IMG_CDN}/poster/v/${id}.jpg`,
                episodes: [{ id, title: searchTitle, episode: null, season: null }]
            };
        }

        if (!Array.isArray(data.episodes)) {
            console.log(`[NetflixMirror] Content payload missing episodes array`);
            return null;
        }

        const content = {
            id,
            title: data.title,
            description: data.desc,
            year: data.year,
            poster: `${IMG_CDN}/poster/v/${id}.jpg`,
            backdrop: `${IMG_CDN}/poster/h/${id}.jpg`,
            type: data.episodes[0] === null ? 'movie' : 'series',
            episodes: []
        };

        if (data.episodes[0] !== null) {
            content.episodes = data.episodes
                .filter(ep => ep !== null)
                .map(ep => ({
                    id: ep.id,
                    title: ep.t,
                    episode: ep.ep ? parseInt(ep.ep.replace('E', ''), 10) : null,
                    season: ep.s ? parseInt(ep.s.replace('S', ''), 10) : null,
                    runtime: ep.time ? parseInt(ep.time.replace('m', ''), 10) : null,
                    poster: `${IMG_CDN}/epimg/150/${ep.id}.jpg`
                }));

            if (data.nextPageShow === 1 && data.nextPageSeason) {
                const moreEpisodes = await getMoreEpisodes(id, data.nextPageSeason, 2, cookie, signal);
                content.episodes.push(...moreEpisodes);
            }

            if (data.season && data.season.length > 1) {
                for (const season of data.season.slice(0, -1)) {
                    const seasonEpisodes = await getMoreEpisodes(id, season.id, 1, cookie, signal);
                    content.episodes.push(...seasonEpisodes);
                }
            }
        } else {
            content.episodes = [{ id, title: data.title, episode: null, season: null }];
        }

        console.log(`[NetflixMirror] Loaded content: "${content.title}" with ${content.episodes.length} episodes`);
        return content;
    } catch (error) {
        console.error(`[NetflixMirror] Load content failed: ${error.message}, using direct fallback`);
        return {
            id,
            title: searchTitle,
            type: searchType,
            poster: `${IMG_CDN}/poster/v/${id}.jpg`,
            episodes: [{ id, title: searchTitle, episode: null, season: null }]
        };
    }
}

/**
 * Get more episodes for pagination
 */
async function getMoreEpisodes(contentId, seasonId, startPage, cookie, signal = null) {
    const episodes = [];
    let page = startPage;

    while (true) {
        const unixTime = Math.floor(Date.now() / 1000);
        const url = `${MAIN_URL}/episodes.php?s=${seasonId}&series=${contentId}&t=${unixTime}&page=${page}`;

        try {
            const response = await makeRequest(url, {
                headers: {
                    'X-Requested-With': 'XMLHttpRequest',
                    'Cookie': formatCookieHeader(getCookies(cookie)),
                    'Referer': `${MAIN_URL}/home`
                },
                timeout: 15000,
                signal
            });

            const data = JSON.parse(response.body);

            if (data.episodes) {
                for (const ep of data.episodes) {
                    episodes.push({
                        id: ep.id,
                        title: ep.t,
                        episode: ep.ep ? parseInt(ep.ep.replace('E', ''), 10) : null,
                        season: ep.s ? parseInt(ep.s.replace('S', ''), 10) : null,
                        runtime: ep.time ? parseInt(ep.time.replace('m', ''), 10) : null,
                        poster: `${IMG_CDN}/epimg/150/${ep.id}.jpg`
                    });
                }
            }

            if (data.nextPageShow === 0) break;
            page++;
        } catch (error) {
            console.error(`[NetflixMirror] Failed to get episodes page ${page}: ${error.message}`);
            break;
        }
    }

    return episodes;
}

/**
 * Get playlist (streams) for an episode/movie
 * @param {string} id - Episode or movie ID
 * @param {string} title - Content title
 * @returns {Promise<Object>} Playlist with sources and subtitles
 */
export async function getNetflixMirrorPlaylist(id, title, signal = null) {
    if (!id) return null;

    const cookie = await bypass();
    if (!cookie) {
        console.error(`[NetflixMirror] No bypass cookie available for playlist`);
        return null;
    }
    const streamBypassCookies = await bypassStreamCookies(signal);
    const streamRequestCookies = getCookies(streamBypassCookies?.t_hash || cookie, streamBypassCookies || {});

    const unixTime = Math.floor(Date.now() / 1000);
    // Try both /playlist.php and /tv/playlist.php. Some titles require an h token.
    const playlistPaths = ['/playlist.php', '/tv/playlist.php'];
    let playlist = null;
    const hToken = await getNetflixMirrorVideoToken(id, cookie, signal);
    if (hToken) {
        console.log('[NetflixMirror] Got video token for playlist request');
    }

    for (const path of playlistPaths) {
        const tokenParam = hToken ? `&h=${encodeURIComponent(hToken)}` : '';
        const playlistUrl = `${STREAM_URL}${path}?id=${id}&t=${encodeURIComponent(title || '')}${tokenParam}&tm=${unixTime}`;
        console.log(`[NetflixMirror] Getting playlist: ${playlistUrl}`);

        try {
            const response = await makeRequest(playlistUrl, {
                headers: {
                    'X-Requested-With': 'XMLHttpRequest',
                    'Cookie': formatCookieHeader(streamRequestCookies),
                    'Referer': `${MAIN_URL}/`
                },
                timeout: 15000,
                signal
            });

            const data = JSON.parse(response.body);

            if (!Array.isArray(data) || data.length === 0) {
                console.log(`[NetflixMirror] No playlist data from ${path}`);
                continue;
            }

            playlist = {
                sources: [],
                subtitles: [],
                requestHeaders: getStreamHeaders(formatCookieHeader(streamRequestCookies))
            };

            for (const item of data) {
                if (item.sources && Array.isArray(item.sources)) {
                    for (const source of item.sources) {
                        let streamUrl = source.file;
                        if (streamUrl.startsWith('/')) {
                            streamUrl = `${STREAM_URL}${streamUrl}`;
                        }

                        playlist.sources.push({
                            url: streamUrl,
                            label: source.label || 'Auto',
                            type: source.type || 'hls',
                            quality: source.label || 'Auto'
                        });
                    }
                }

                if (item.tracks && Array.isArray(item.tracks)) {
                    for (const track of item.tracks) {
                        if (track.kind === 'captions' && track.file) {
                            let subUrl = track.file;
                            if (!subUrl.startsWith('http')) {
                                subUrl = `https:${subUrl}`;
                            }
                            playlist.subtitles.push({
                                url: subUrl,
                                lang: track.label || 'Unknown',
                                label: track.label || 'Unknown'
                            });
                        }
                    }
                }
            }

            if (playlist.sources.length > 0) {
                console.log(`[NetflixMirror] Got ${playlist.sources.length} sources, ${playlist.subtitles.length} subtitles`);
                break;
            }
        } catch (error) {
            console.log(`[NetflixMirror] Playlist fetch failed for ${path}: ${error.message}`);
        }
    }

    if (!playlist || playlist.sources.length === 0) {
        console.log(`[NetflixMirror] No playlist sources found`);
        return null;
    }

    return playlist;
}

export function getStreamHeaders(cookieHeader = null) {
    return {
        'User-Agent': 'Mozilla/5.0 (Android) ExoPlayer',
        'Accept': '*/*',
        'Accept-Encoding': 'identity',
        'Connection': 'keep-alive',
        'Cookie': cookieHeader || 'hd=on; ott=nf',
        'Referer': `${STREAM_URL}/`
    };
}

export async function getNetflixMirrorProxyHeaders(signal = null) {
    const mainCookie = await bypass();
    const streamBypassCookies = await bypassStreamCookies(signal);
    const cookieHeader = formatCookieHeader(
        getCookies(streamBypassCookies?.t_hash || mainCookie, streamBypassCookies || {})
    );
    return getStreamHeaders(cookieHeader);
}

export { MAIN_URL, STREAM_URL, IMG_CDN };
