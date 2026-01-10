/**
 * NetflixMirror search helpers
 * Provides bypass, search, and content loading for netflixmirror sites
 * Based on CSX NetflixMirrorProvider implementation
 */

import { makeRequest } from '../../utils/http.js';

// Configuration - domains may change
const MAIN_URL = 'https://net20.cc';
const STREAM_URL = 'https://net51.cc';
const IMG_CDN = 'https://imgcdn.kim';

// Cookie cache with 15-hour TTL (same as CSX implementation)
let cachedCookie = null;
let cookieTimestamp = 0;
const COOKIE_TTL_MS = 54_000_000; // 15 hours

/**
 * Bypass protection and get auth cookie
 * Makes repeated POST requests until we get a valid response
 */
export async function bypass(mainUrl = MAIN_URL) {
    // Check cached cookie
    const now = Date.now();
    if (cachedCookie && (now - cookieTimestamp < COOKIE_TTL_MS)) {
        console.log(`[NetflixMirror] Using cached cookie (age: ${Math.floor((now - cookieTimestamp) / 1000)}s)`);
        return cachedCookie;
    }

    console.log(`[NetflixMirror] Getting new bypass cookie from ${mainUrl}`);

    try {
        let attempts = 0;
        const maxAttempts = 10;

        while (attempts < maxAttempts) {
            attempts++;
            const response = await makeRequest(`${mainUrl}/tv/p.php`, {
                method: 'POST',
                headers: {
                    'X-Requested-With': 'XMLHttpRequest',
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Referer': `${mainUrl}/`
                },
                timeout: 10000
            });

            const text = response.body || '';
            console.log(`[NetflixMirror] Bypass attempt ${attempts}: ${text.substring(0, 100)}`);

            // Check for valid response containing cookie
            if (text.includes('"r":"n"') || text.includes('"r": "n"')) {
                // Extract cookie from response headers
                const setCookie = response.headers['set-cookie'];
                if (setCookie) {
                    const cookieMatch = Array.isArray(setCookie)
                        ? setCookie.find(c => c.includes('t_hash_t'))
                        : setCookie.includes('t_hash_t') ? setCookie : null;

                    if (cookieMatch) {
                        const match = cookieMatch.match(/t_hash_t=([^;]+)/);
                        if (match) {
                            cachedCookie = match[1];
                            cookieTimestamp = Date.now();
                            console.log(`[NetflixMirror] Got bypass cookie: ${cachedCookie.substring(0, 10)}...`);
                            return cachedCookie;
                        }
                    }
                }

                // Try parsing JSON response for cookie
                try {
                    const json = JSON.parse(text);
                    if (json.t_hash_t) {
                        cachedCookie = json.t_hash_t;
                        cookieTimestamp = Date.now();
                        console.log(`[NetflixMirror] Got bypass cookie from JSON: ${cachedCookie.substring(0, 10)}...`);
                        return cachedCookie;
                    }
                } catch (e) {
                    // Not JSON, continue
                }
            }

            // Small delay between attempts
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        console.error(`[NetflixMirror] Failed to get bypass cookie after ${maxAttempts} attempts`);
        return null;
    } catch (error) {
        console.error(`[NetflixMirror] Bypass error: ${error.message}`);
        cachedCookie = null;
        cookieTimestamp = 0;
        return null;
    }
}

/**
 * Get common cookies for requests
 */
function getCookies(hashCookie) {
    return {
        't_hash_t': hashCookie,
        'ott': 'nf',
        'hd': 'on'
    };
}

/**
 * Format cookies for header
 */
function formatCookieHeader(cookies) {
    return Object.entries(cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');
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
 * @param {string} id - Content ID
 * @returns {Promise<Object>} Content details
 */
export async function loadNetflixMirrorContent(id, signal = null) {
    if (!id) return null;

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

        const content = {
            id,
            title: data.title,
            description: data.desc,
            year: data.year,
            genre: data.genre ? data.genre.split(',').map(g => g.trim()) : [],
            cast: data.cast ? data.cast.split(',').map(c => c.trim()) : [],
            director: data.director,
            rating: data.match ? data.match.replace('IMDb ', '') : null,
            runtime: data.runtime,
            contentRating: data.ua,
            poster: `${IMG_CDN}/poster/v/${id}.jpg`,
            backdrop: `${IMG_CDN}/poster/h/${id}.jpg`,
            type: data.episodes?.[0] === null ? 'movie' : 'series',
            episodes: []
        };

        // Handle episodes
        if (data.episodes?.[0] !== null) {
            // It's a series
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

            // Handle pagination for more episodes
            if (data.nextPageShow === 1 && data.nextPageSeason) {
                const moreEpisodes = await getMoreEpisodes(id, data.nextPageSeason, 2, cookie, signal);
                content.episodes.push(...moreEpisodes);
            }

            // Handle other seasons
            if (data.season && data.season.length > 1) {
                for (const season of data.season.slice(0, -1)) {
                    const seasonEpisodes = await getMoreEpisodes(id, season.id, 1, cookie, signal);
                    content.episodes.push(...seasonEpisodes);
                }
            }
        } else {
            // It's a movie - use the content ID as episode ID
            content.episodes = [{
                id: id,
                title: data.title,
                episode: null,
                season: null
            }];
        }

        console.log(`[NetflixMirror] Loaded content: "${content.title}" with ${content.episodes.length} episodes`);
        return content;
    } catch (error) {
        console.error(`[NetflixMirror] Load content failed: ${error.message}`);
        return null;
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

    const unixTime = Math.floor(Date.now() / 1000);
    const playlistUrl = `${STREAM_URL}/tv/playlist.php?id=${id}&t=${encodeURIComponent(title || '')}&tm=${unixTime}`;

    console.log(`[NetflixMirror] Getting playlist: ${playlistUrl}`);

    try {
        const response = await makeRequest(playlistUrl, {
            headers: {
                'X-Requested-With': 'XMLHttpRequest',
                'Cookie': formatCookieHeader(getCookies(cookie)),
                'Referer': `${MAIN_URL}/home`
            },
            timeout: 15000,
            signal
        });

        const data = JSON.parse(response.body);

        if (!Array.isArray(data) || data.length === 0) {
            console.log(`[NetflixMirror] No playlist data returned`);
            return null;
        }

        // Process playlist items
        const playlist = {
            sources: [],
            subtitles: []
        };

        for (const item of data) {
            // Process sources
            if (item.sources && Array.isArray(item.sources)) {
                for (const source of item.sources) {
                    // Build full URL - the file path needs to be converted
                    let streamUrl = source.file;
                    if (streamUrl.startsWith('/')) {
                        streamUrl = `${STREAM_URL}${streamUrl.replace('/tv/', '/')}`;
                    }

                    playlist.sources.push({
                        url: streamUrl,
                        label: source.label || 'Auto',
                        type: source.type || 'hls',
                        quality: source.label || 'Auto'
                    });
                }
            }

            // Process subtitles/tracks
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

        console.log(`[NetflixMirror] Got ${playlist.sources.length} sources, ${playlist.subtitles.length} subtitles`);
        return playlist;
    } catch (error) {
        console.error(`[NetflixMirror] Playlist fetch failed: ${error.message}`);
        return null;
    }
}

/**
 * Get required headers for stream playback
 */
export function getStreamHeaders() {
    return {
        'User-Agent': 'Mozilla/5.0 (Android) ExoPlayer',
        'Accept': '*/*',
        'Accept-Encoding': 'identity',
        'Connection': 'keep-alive',
        'Cookie': 'hd=on',
        'Referer': `${STREAM_URL}/`
    };
}

export { MAIN_URL, STREAM_URL, IMG_CDN };
