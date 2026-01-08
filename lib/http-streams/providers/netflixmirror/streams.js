/**
 * NetflixMirror Streams
 * Builds HLS streams from NetflixMirror API
 *
 * Unlike other http-streams providers that provide direct download links,
 * NetflixMirror provides ready-to-play M3U8 (HLS) streams.
 */

import Cinemeta from '../../../util/cinemeta.js';
import { searchNetflixMirror, loadNetflixMirrorContent, getNetflixMirrorPlaylist, getStreamHeaders, STREAM_URL } from './search.js';
import { renderLanguageFlags, detectLanguagesFromTitle } from '../../../util/language-mapping.js';
import { removeYear, generateAlternativeQueries, getSortedMatches, getResolutionFromName } from '../../utils/parsing.js';

const PROVIDER = 'NetflixMirror';

/**
 * Normalize quality label to standard format
 */
function normalizeQuality(label = '') {
    const lower = label.toLowerCase();
    if (lower.includes('4k') || lower.includes('2160')) return '4K';
    if (lower.includes('1080')) return '1080p';
    if (lower.includes('720')) return '720p';
    if (lower.includes('480')) return '480p';
    if (lower.includes('360')) return '360p';
    return 'HLS';
}

/**
 * Find matching episode from content
 */
function findMatchingEpisode(content, season, episode) {
    if (!content.episodes || content.episodes.length === 0) return null;

    // For movies, return the first (and only) episode
    if (content.type === 'movie') {
        return content.episodes[0];
    }

    // For series, find matching episode
    const seasonNum = parseInt(season, 10);
    const episodeNum = parseInt(episode, 10);

    return content.episodes.find(ep =>
        ep.season === seasonNum && ep.episode === episodeNum
    );
}

/**
 * Get streams from NetflixMirror
 * @param {string} tmdbId - TMDB ID
 * @param {string} type - Content type (movie/series)
 * @param {number|null} season - Season number (for series)
 * @param {number|null} episode - Episode number (for series)
 * @param {Object} config - Configuration options
 * @param {Object} prefetchedMeta - Pre-fetched Cinemeta metadata
 * @returns {Promise<Array>} Array of stream objects
 */
export async function getNetflixMirrorStreams(tmdbId, type, season = null, episode = null, config = {}, prefetchedMeta = null) {
    try {
        console.log(`[${PROVIDER}] Starting search for ${tmdbId} (${type}${season ? ` S${season}` : ''}${episode ? `E${episode}` : ''})`);

        // Get metadata
        let meta = prefetchedMeta;
        if (!meta) {
            console.log(`[${PROVIDER}] No pre-fetched metadata, fetching from Cinemeta...`);
            meta = await Cinemeta.getMeta(type, tmdbId);
        } else {
            console.log(`[${PROVIDER}] Using pre-fetched Cinemeta metadata: "${meta.name}"`);
        }

        if (!meta?.name) {
            console.log(`[${PROVIDER}] Missing metadata for ${tmdbId}`);
            return [];
        }

        // Build search queries
        const queries = Array.from(new Set([
            meta.name,
            removeYear(meta.name),
            ...(meta.alternativeTitles || []),
            ...generateAlternativeQueries(meta.name, meta.original_title)
        ].filter(Boolean)));

        // Search with early exit on good match
        let searchResults = [];
        for (const query of queries) {
            console.log(`[${PROVIDER}] Searching for: "${query}"`);
            const results = await searchNetflixMirror(query);
            searchResults.push(...results);

            // Early exit if we found a good match
            if (results.length > 0) {
                const matches = getSortedMatches(results.map(r => ({ ...r, normalizedTitle: r.title })), meta.name);
                if (matches.length > 0 && matches[0].score >= 50) {
                    console.log(`[${PROVIDER}] Found good match early, skipping remaining queries`);
                    break;
                }
            }
        }

        if (searchResults.length === 0) {
            console.log(`[${PROVIDER}] No search results found`);
            return [];
        }

        // Dedupe results
        const seenIds = new Set();
        const uniqueResults = searchResults.filter(result => {
            if (!result?.id || seenIds.has(result.id)) return false;
            seenIds.add(result.id);
            return true;
        });

        // Find best match
        const sortedMatches = getSortedMatches(
            uniqueResults.map(r => ({ ...r, normalizedTitle: r.title })),
            meta.name
        );

        const bestMatch = sortedMatches[0];
        if (!bestMatch?.id) {
            console.log(`[${PROVIDER}] No suitable match found for ${meta.name}`);
            return [];
        }

        console.log(`[${PROVIDER}] Best match: "${bestMatch.title}" (ID: ${bestMatch.id})`);

        // Load content details
        const content = await loadNetflixMirrorContent(bestMatch.id);
        if (!content) {
            console.log(`[${PROVIDER}] Failed to load content details`);
            return [];
        }

        // Find the episode/movie to play
        const episodeData = findMatchingEpisode(content, season, episode);
        if (!episodeData) {
            console.log(`[${PROVIDER}] No matching episode found for S${season}E${episode}`);
            return [];
        }

        console.log(`[${PROVIDER}] Found episode: "${episodeData.title}" (ID: ${episodeData.id})`);

        // Get playlist/streams
        const playlist = await getNetflixMirrorPlaylist(episodeData.id, content.title);
        if (!playlist || !playlist.sources || playlist.sources.length === 0) {
            console.log(`[${PROVIDER}] No streams available`);
            return [];
        }

        // Detect languages from title
        const detectedLanguages = detectLanguagesFromTitle(content.title || meta.name || '');
        const languageFlags = renderLanguageFlags(detectedLanguages);

        // Build stream objects
        const streams = [];
        const streamHeaders = getStreamHeaders();

        for (const source of playlist.sources) {
            const quality = normalizeQuality(source.label);

            // Build stream object compatible with Stremio
            const stream = {
                name: `[HS+] Sootio\n${quality}`,
                title: `${source.label || 'Auto'}${languageFlags}\n${PROVIDER}`,
                url: source.url,
                behaviorHints: {
                    bingeGroup: `netflixmirror-${quality}`
                }
            };

            // Add subtitles if available
            if (playlist.subtitles && playlist.subtitles.length > 0) {
                stream.subtitles = playlist.subtitles.map(sub => ({
                    url: sub.url,
                    lang: sub.lang,
                    id: `${sub.lang}-${sub.url.split('/').pop()}`
                }));
            }

            streams.push(stream);
        }

        console.log(`[${PROVIDER}] Returning ${streams.length} streams`);
        return streams;
    } catch (error) {
        console.error(`[${PROVIDER}] Failed to fetch streams: ${error.message}`);
        return [];
    }
}
