/**
 * Mapple Streams Module
 * Fetches direct HTTP streams from mapple.site encrypted API.
 */

import { buildEncryptedUrl } from './api.js';
import { makeRequest } from '../../utils/http.js';
import { getResolutionFromName } from '../../utils/parsing.js';

const DEFAULT_SOURCES = ['mapple', 'sakura', 'alfa', 'oak', 'wiggles'];
const PROXY_HOST = 'https://proxy.mapple.tv/tom-proxy?url=';

function normalizeType(type) {
    if (!type) return 'movie';
    const lowered = type.toLowerCase();
    if (lowered === 'series' || lowered === 'tv') {
        return 'tv';
    }
    return 'movie';
}

function buildTvSlug(season, episode) {
    const safeSeason = season || 1;
    const safeEpisode = episode || 1;
    return `${safeSeason}-${safeEpisode}`;
}

function wrapIfNeeded(url) {
    if (!url) return url;
    if (url.includes('fleurixsun')) {
        return `${PROXY_HOST}${encodeURIComponent(url)}`;
    }
    return url;
}

function inferResolution(data = {}) {
    const { title = '', stream_url: streamUrl = '' } = data;
    const name = title || streamUrl;
    const resolution = getResolutionFromName(name);

    switch (resolution) {
        case '2160p':
            return '4k';
        case '1080p':
            return '1080p';
        case '720p':
            return '720p';
        default:
            return 'auto';
    }
}

function formatStream(data, sourceLabel) {
    const proxiedUrl = wrapIfNeeded(data.stream_url);
    const resolutionLabel = inferResolution(data);

    return {
        name: `[HS+] Sootio\n${sourceLabel}`,
        title: `${data.title || 'Mapple Stream'} (${sourceLabel})`,
        url: proxiedUrl,
        behaviorHints: {
            notWebReady: true,
            bingeGroup: 'mapple-streams'
        },
        resolution: resolutionLabel,
        _provider: 'mapple'
    };
}

async function requestStream({
    tmdbId,
    mediaType,
    season,
    episode,
    sessionId,
    source,
    useFallbackVideo = false
}) {
    const payload = {
        mediaId: String(tmdbId),
        mediaType,
        tv_slug: mediaType === 'tv' ? buildTvSlug(season, episode) : '',
        source,
        useFallbackVideo
    };

    const url = buildEncryptedUrl('stream-encrypted', payload, sessionId);
    const response = await makeRequest(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64)',
            Accept: 'application/json'
        }
    });
    const { statusCode, body } = response;

    if (statusCode === 401) {
        throw new Error('Mapple session verification failed (HTTP 401)');
    }

    let json;
    try {
        json = JSON.parse(body);
    } catch (err) {
        throw new Error('Invalid JSON response from Mapple');
    }

    if (!json.success) {
        const message = json.error || 'Unknown Mapple error';
        throw new Error(message);
    }

    if (!json.data || !json.data.stream_url) {
        throw new Error('Mapple response missing stream_url');
    }

    return json.data;
}

/**
 * Fetches streams for the provided TMDB id.
 * @param {string} tmdbId
 * @param {string} type
 * @param {number|null} season
 * @param {number|null} episode
 * @param {Object} config
 * @returns {Promise<Array>}
 */
export async function getMappleStreams(
    tmdbId,
    type,
    season = null,
    episode = null,
    config = {}
) {
    const sessionId =
        config.mappleSessionId ||
        process.env.MAPPLE_SESSION_ID ||
        config.MAPPLE_SESSION;

    if (!sessionId) {
        console.warn('[Mapple] mappleSessionId not configured - skipping Mapple provider');
        return [];
    }

    const useFallbackVideo = Boolean(config.mappleUseFallbackVideo);
    const requestType = normalizeType(type);

    let sources = DEFAULT_SOURCES;
    if (Array.isArray(config.mappleSources) && config.mappleSources.length > 0) {
        sources = config.mappleSources;
    } else {
        const envSources = (process.env.MAPPLE_SOURCES || '')
            .split(',')
            .map(s => s.trim())
            .filter(Boolean);
        if (envSources.length > 0) {
            sources = envSources;
        }
    }

    const results = [];
    for (const source of sources) {
        try {
            console.log(`[Mapple] Requesting ${source} stream for ${tmdbId} (${requestType})`);
            const data = await requestStream({
                tmdbId,
                mediaType: requestType,
                season,
                episode,
                sessionId,
                source,
                useFallbackVideo
            });
            results.push(formatStream(data, source));
        } catch (error) {
            console.warn(`[Mapple] Source ${source} failed: ${error.message}`);
        }
    }

    if (results.length === 0) {
        console.warn('[Mapple] No streams were returned from available sources');
    }

    return results;
}
