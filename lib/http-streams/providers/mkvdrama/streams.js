/**
 * MKVDrama Streams
 * Builds HTTP streams from mkvdrama.net download pages (Ouo short links).
 *
 * Search phase: Find page, extract OUO links with resolutions
 * Resolution phase (user clicks): Resolve OUO → viewcrate → pixeldrain
 */

import Cinemeta from '../../../util/cinemeta.js';
import { scrapeMkvDramaSearch, loadMkvDramaContent } from './search.js';
import { renderLanguageFlags, detectLanguagesFromTitle } from '../../../util/language-mapping.js';
import { removeYear, generateAlternativeQueries, getSortedMatches, getResolutionFromName } from '../../utils/parsing.js';
import { encodeUrlForStreaming } from '../../utils/encoding.js';
import { isLazyLoadEnabled, createPreviewStream, formatPreviewStreams } from '../../utils/preview-mode.js';

const PROVIDER = 'MkvDrama';

// Supported download hosts - each link generates streams for all hosts
const DOWNLOAD_HOSTS = [
    { id: 'pixeldrain.com', label: 'Pixeldrain' }
];

function normalizeResolution(label = '') {
    const resolution = getResolutionFromName(label);
    if (resolution === '2160p') return '4k';
    if (['1080p', '720p', '480p'].includes(resolution)) return resolution;
    return 'HTTP';
}

function buildHintedUrl(url, hints = {}) {
    const params = new URLSearchParams();
    if (hints.episode) params.set('ep', hints.episode);
    if (hints.resolution) params.set('res', hints.resolution);
    if (hints.host) params.set('host', hints.host);
    const hash = params.toString();
    return hash ? `${url}#${hash}` : url;
}

function formatEpisodeKey(season, episode) {
    if (!season || !episode) return null;
    const s = String(season).padStart(2, '0');
    const e = String(episode).padStart(2, '0');
    return `S${s}E${e}`;
}

function buildDisplayLabel(entry, episodeKey = null) {
    const label = episodeKey || entry.label;
    const parts = [label, entry.quality].filter(Boolean);
    return parts.join(' ').trim() || 'Download';
}

function matchesEpisode(entry, season, episode) {
    if (!episode) return true;
    if (entry.season && season && entry.season !== parseInt(season, 10)) return false;
    if (entry.episodeStart && entry.episodeEnd) {
        return episode >= entry.episodeStart && episode <= entry.episodeEnd;
    }
    return true;
}

export async function getMkvDramaStreams(tmdbId, type, season = null, episode = null, config = {}, prefetchedMeta = null) {
    try {
        console.log(`[${PROVIDER}] Starting search for ${tmdbId} (${type}${season ? ` S${season}` : ''}${episode ? `E${episode}` : ''})`);

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
            const results = await scrapeMkvDramaSearch(query);
            searchResults.push(...results);

            // Early exit if we found a good match
            if (results.length > 0) {
                const matches = getSortedMatches(results, meta.name);
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

        const seenUrls = new Set();
        const uniqueResults = searchResults.filter(result => {
            if (!result?.url || seenUrls.has(result.url)) return false;
            seenUrls.add(result.url);
            return true;
        });

        const sortedMatches = getSortedMatches(uniqueResults, meta.name);
        const bestMatch = sortedMatches[0];
        if (!bestMatch?.url) {
            console.log(`[${PROVIDER}] No suitable match found for ${meta.name}`);
            return [];
        }

        console.log(`[${PROVIDER}] Loading content from: ${bestMatch.url}`);
        const content = await loadMkvDramaContent(bestMatch.url, null, {
            season,
            episode
        });
        const downloadLinks = content.downloadLinks || [];

        if (downloadLinks.length === 0) {
            console.log(`[${PROVIDER}] No download links found on ${bestMatch.url}`);
            return [];
        }

        const filteredLinks = (type === 'series' || type === 'tv') && episode
            ? downloadLinks.filter(entry => matchesEpisode(entry, season, parseInt(episode, 10)))
            : downloadLinks;

        if (filteredLinks.length === 0) {
            console.log(`[${PROVIDER}] No episode-matching links found for S${season}E${episode}`);
            return [];
        }

        const detectedLanguages = detectLanguagesFromTitle(content.title || meta.name || '');
        const episodeKey = (type === 'series' || type === 'tv') && episode
            ? formatEpisodeKey(season, episode)
            : null;

        if (isLazyLoadEnabled()) {
            const previewStreams = [];
            for (const link of filteredLinks) {
                const label = buildDisplayLabel(link, episodeKey);
                const resolutionHint = getResolutionFromName(label);

                // Generate a stream for each supported host
                for (const host of DOWNLOAD_HOSTS) {
                    const hintedUrl = buildHintedUrl(link.url, {
                        episode: episodeKey,
                        resolution: resolutionHint !== 'other' ? resolutionHint : null,
                        host: host.id
                    });
                    previewStreams.push(createPreviewStream({
                        url: hintedUrl,
                        label: `${label} [${host.label}]`,
                        provider: PROVIDER,
                        languages: detectedLanguages
                    }));
                }
            }

            return formatPreviewStreams(previewStreams, encodeUrlForStreaming, renderLanguageFlags);
        }

        const streams = [];
        for (const link of filteredLinks) {
            const label = buildDisplayLabel(link, episodeKey);
            const resolutionLabel = normalizeResolution(label);
            const languageFlags = renderLanguageFlags(detectedLanguages);
            const resolutionHint = getResolutionFromName(label);

            // Generate a stream for each supported host
            for (const host of DOWNLOAD_HOSTS) {
                const hintedUrl = buildHintedUrl(link.url, {
                    episode: episodeKey,
                    resolution: resolutionHint !== 'other' ? resolutionHint : null,
                    host: host.id
                });

                streams.push({
                    name: `[HS+] Sootio\n${resolutionLabel}`,
                    title: `${label} [${host.label}]${languageFlags}\n${PROVIDER}`,
                    url: encodeUrlForStreaming(hintedUrl),
                    resolution: resolutionLabel,
                    needsResolution: true,
                    isPreview: true,
                    behaviorHints: {
                        bingeGroup: 'mkvdrama-streams'
                    }
                });
            }
        }

        console.log(`[${PROVIDER}] Returning ${streams.length} streams`);
        return streams;
    } catch (error) {
        console.error(`[${PROVIDER}] Failed to fetch streams: ${error.message}`);
        return [];
    }
}
