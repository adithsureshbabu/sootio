/**
 * CineDoze HTTP Streams
 * Scrapes cinedoze.tv posts -> cinedoze links -> savelinks pages, preferring hubdrive/hubcloud
 * with gdflix as a pixeldrain-only fallback.
 */

import Cinemeta from '../../../util/cinemeta.js';
import { renderLanguageFlags, detectLanguagesFromTitle } from '../../../util/language-mapping.js';
import { makeRequest } from '../../utils/http.js';
import {
    removeYear,
    generateAlternativeQueries,
    getSortedMatches
} from '../../utils/parsing.js';
import { getResolutionFromName } from '../../utils/parsing.js';
import { encodeUrlForStreaming } from '../../utils/encoding.js';
import { processExtractorLinkWithAwait } from '../4khdhub/extraction.js';
import { parseSizeFromText, isLazyLoadEnabled } from '../../utils/preview-mode.js';

const BASE_URL = (process.env.CINEDOZE_BASE_URL || 'https://cinedoze.tv').replace(/\/+$/, '');
const PROVIDER = 'CineDoze';

function cleanText(text = '') {
    return text.replace(/\s+/g, ' ').replace(/^\W+/, '').trim();
}

function toAbsolute(href, base = BASE_URL) {
    if (!href) return null;
    try {
        return new URL(href, base).toString();
    } catch {
        return null;
    }
}

async function searchCineDoze(query) {
    // CineDoze search breaks when query contains colons - strip them
    const cleanQuery = query.replace(/:/g, '').replace(/\s+/g, ' ').trim();
    const url = `${BASE_URL}/search/${encodeURIComponent(cleanQuery)}/`;
    try {
        const response = await makeRequest(url, { parseHTML: true, timeout: 3000 });
        const $ = response.document;
        const results = [];

        $('article').each((_, article) => {
            const link =
                $(article).find('a[href*="/movies/"], a[href*="/tvshows/"]').first().attr('href');
            const title =
                cleanText(
                    $(article).find('.title').text() ||
                    $(article).find('h3').text() ||
                    $(article).find('h2').text()
                );
            const absolute = toAbsolute(link, url);
            if (absolute && title) {
                results.push({ title, url: absolute });
            }
        });

        // Fallback: regex for movie/tvshow links if DOM parsing failed
        if (results.length === 0) {
            const regex = /https?:\/\/cinedoze\.tv\/(?:movies|tvshows)\/[^\s"'<>]+/gi;
            const matches = [...(response.body || '').matchAll(regex)].map(m => m[0]);
            for (const href of matches) {
                const absolute = toAbsolute(href, url);
                if (!absolute) continue;
                // Derive title from slug
                const slug = absolute.split('/').filter(Boolean).pop() || '';
                const derived = cleanText(slug.replace(/[-_]+/g, ' '));
                if (derived) {
                    results.push({ title: derived, url: absolute });
                }
            }
        }

        return results;
    } catch (err) {
        console.log(`[${PROVIDER}] Search failed for "${query}": ${err.message}`);
        return [];
    }
}

async function loadCineDozePage(detailUrl) {
    try {
        const response = await makeRequest(detailUrl, { parseHTML: true, timeout: 3000 });
        const $ = response.document;
        const rows = $('#download table tbody tr');
        const entries = [];

        rows.each((_, row) => {
            const link = $(row).find('a[href]').attr('href');
            const quality = cleanText($(row).find('.quality').text() || $(row).find('td').eq(1).text());
            const languageText = cleanText($(row).find('td').eq(2).text());
            const sizeText = cleanText($(row).find('td').eq(3).text());

            const absolute = toAbsolute(link, detailUrl);
            if (!absolute) return;

            entries.push({
                url: absolute,
                quality: quality || 'Download',
                languages: detectLanguagesFromTitle(languageText),
                size: sizeText || parseSizeFromText(quality)
            });
        });

        return entries;
    } catch (err) {
        console.log(`[${PROVIDER}] Failed to load detail page ${detailUrl}: ${err.message}`);
        return [];
    }
}

function extractHostLinks(html, baseUrl) {
    const hostLinks = [];
    const regex = /https?:\/\/[^\s"'<>]+/gi;
    const matches = [...(html || '').matchAll(regex)];
    const seen = new Set();

    for (const m of matches) {
        const href = toAbsolute(m[0], baseUrl);
        if (!href || seen.has(href)) continue;
        const lower = href.toLowerCase();
        if (
            lower.includes('hubdrive') ||
            lower.includes('hubcloud') ||
            lower.includes('hubcdn') ||
            lower.includes('gdflix') ||
            lower.includes('filepress') ||
            lower.includes('pixeldrain') ||
            lower.includes('filesdl')
        ) {
            hostLinks.push(href);
            seen.add(href);
        }
    }

    return hostLinks;
}

async function expandCineDozeLink(linkUrl) {
    try {
        const response = await makeRequest(linkUrl, { parseHTML: false, timeout: 2000 });
        const finalUrl = response.url || linkUrl;
        return extractHostLinks(response.body, finalUrl);
    } catch (err) {
        console.log(`[${PROVIDER}] Failed to expand cinedoze link ${linkUrl}: ${err.message}`);
        return [];
    }
}

/**
 * Quick metadata fetch from HubCloud page - extracts filename from page title
 * The HubCloud page title contains the full filename like:
 * "CineDoze.TV-Wicked For Good (2025) MLSBD.Co-Dual Audio [Hindi ORG-English] Amazon 4K.mkv"
 * Used in lazy-load mode to get proper filenames for preview streams
 */
async function fetchHubCloudMetadata(hubcloudUrl) {
    try {
        const response = await makeRequest(hubcloudUrl, { parseHTML: true, timeout: 2000 });
        if (!response.document) return null;

        const $ = response.document;

        // The filename is in the page title on HubCloud pages
        const pageTitle = $('title').text().trim();

        // Check if it looks like a video filename (ends with .mkv, .mp4, etc.)
        let filename = null;
        if (pageTitle && /\.(mkv|mp4|avi|webm|mov|m4v)$/i.test(pageTitle)) {
            filename = pageTitle;
            console.log(`[${PROVIDER}] Extracted filename from HubCloud title: ${filename}`);
        } else {
            // Fallback: look in body for filename patterns
            const body = response.body || '';
            const fnMatch = body.match(/([A-Za-z0-9._\-\[\]()@ ]+\.(?:mkv|mp4|avi|webm))/i);
            if (fnMatch) {
                filename = fnMatch[1];
                console.log(`[${PROVIDER}] Extracted filename from body: ${filename}`);
            }
        }

        // Extract quality from filename
        const quality = (filename || '').match(/(2160p|1080p|720p|480p|4K)/i)?.[1] || null;

        return { filename, quality };
    } catch (err) {
        console.log(`[${PROVIDER}] Failed to fetch HubCloud metadata from ${hubcloudUrl}: ${err.message}`);
        return null;
    }
}

function buildStream(result, context) {
    if (!result?.url) return null;

    const labelBase = cleanText(result.title || result.name || context.quality || '');
    const size = result.size || context.size || parseSizeFromText(labelBase) || parseSizeFromText(context.quality) || null;
    const qualityLabel = getResolutionFromName(labelBase || result.name || context.quality || '') || 'HTTP';
    const resLabel = qualityLabel === '2160p' ? '4k' : qualityLabel;
    const languages = Array.from(
        new Set([
            ...(context.languages || []),
            ...detectLanguagesFromTitle(labelBase),
            ...detectLanguagesFromTitle(context.quality || ''),
            ...detectLanguagesFromTitle(result.title || '')
        ].filter(Boolean))
    );
    const languageFlags = renderLanguageFlags(languages);
    const title = `${labelBase || context.quality || 'Download'}${languageFlags}${size ? `\n💾 ${size}` : ''}`;

    return {
        name: `[HS+] ${PROVIDER}\n${resLabel}`,
        title,
        url: encodeUrlForStreaming(result.url),
        size,
        resolution: resLabel,
        languages,
        behaviorHints: {
            bingeGroup: 'cinedoze-http'
        },
        httpProvider: PROVIDER
    };
}

function filterPixeldrainOnly(results) {
    return (results || []).filter(r => r.url && r.url.toLowerCase().includes('pixel'));
}

async function resolveHostLinks(hostLinks, context) {
    const hubLinks = hostLinks.filter(h => /hubdrive|hubcloud|hubcdn/.test(h));
    const gdflixLinks = hostLinks.filter(h => /gdflix/.test(h));

    // 1) Try hubdrive/hubcloud first
    for (const link of hubLinks) {
        try {
            const extracted = await processExtractorLinkWithAwait(link, 1);
            if (extracted && extracted.length > 0) {
                const streams = extracted.map(r => buildStream(r, context)).filter(Boolean);
                if (streams.length > 0) return streams;
            }
        } catch (err) {
            console.log(`[${PROVIDER}] Hub link failed ${link}: ${err.message}`);
        }
    }

    // 2) Fallback to gdflix -> only pixeldrain results
    for (const link of gdflixLinks) {
        try {
            const extracted = await processExtractorLinkWithAwait(link, 2);
            const pixelOnly = filterPixeldrainOnly(extracted);
            if (pixelOnly && pixelOnly.length > 0) {
                const streams = pixelOnly.map(r => buildStream(r, context)).filter(Boolean);
                if (streams.length > 0) return streams;
            }
        } catch (err) {
            console.log(`[${PROVIDER}] GDFlix fallback failed ${link}: ${err.message}`);
        }
    }

    return [];
}

export async function getCineDozeStreams(tmdbId, type, season = null, episode = null, config = {}, prefetchedMeta = null) {
    try {
        console.log(`[${PROVIDER}] Starting search for ${tmdbId} (${type}${season ? ` S${season}` : ''}${episode ? `E${episode}` : ''})`);

        // Use pre-fetched metadata if available, otherwise fetch it (fallback for direct calls)
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

        // Run searches in parallel for speed
        console.log(`[${PROVIDER}] Searching with ${queries.length} queries in parallel:`, queries);
        const searchPromises = queries.map(query => searchCineDoze(query).then(results => ({ query, results })));
        const searchResponses = await Promise.all(searchPromises);

        const searchResults = [];
        for (const { query, results } of searchResponses) {
            console.log(`[${PROVIDER}] Query "${query}" returned ${results.length} results`);
            searchResults.push(...results);
        }

        if (searchResults.length === 0) {
            console.log(`[${PROVIDER}] No search results for ${meta.name}`);
            return [];
        }

        console.log(`[${PROVIDER}] Total ${searchResults.length} results before dedup/scoring`);
        const best = getSortedMatches(searchResults, meta.name)[0];
        if (!best?.url) {
            console.log(`[${PROVIDER}] No suitable match for ${meta.name}`);
            return [];
        }

        console.log(`[${PROVIDER}] Selected match: ${best.title} -> ${best.url}`);
        const downloadEntries = await loadCineDozePage(best.url);
        if (downloadEntries.length === 0) {
            console.log(`[${PROVIDER}] No download entries found`);
            return [];
        }

        // Check if lazy-load mode is enabled (default: true for faster initial response)
        const useLazyLoad = isLazyLoadEnabled();

        if (useLazyLoad) {
            // Lazy-load mode: expand links and extract final video URLs in parallel
            console.log(`[${PROVIDER}] Lazy-load: extracting ${downloadEntries.length} streams in parallel...`);

            const movieName = meta.name || 'Unknown';
            const movieYear = meta.year || '';

            const previewPromises = downloadEntries.map(async (entry) => {
                const qualityLabel = getResolutionFromName(entry.quality) || 'HTTP';
                const resLabel = qualityLabel === '2160p' ? '4k' : qualityLabel;
                const fallbackTitle = `${movieName}${movieYear ? ` (${movieYear})` : ''} - ${resLabel.toUpperCase()}`;

                try {
                    // Step 1: Expand CineDoze link to get HubCloud URL
                    const hostLinks = await expandCineDozeLink(entry.url);
                    const hubLink = hostLinks.find(h => /hubcloud|hubdrive|hubcdn/.test(h));

                    if (hubLink) {
                        // Step 2: Extract final video URL from HubCloud
                        const extracted = await processExtractorLinkWithAwait(hubLink, 1);

                        if (extracted && extracted.length > 0 && extracted[0].url) {
                            const result = extracted[0];
                            const filename = result.title || result.name || '';

                            // Build display title from filename or fallback
                            let displayName;
                            if (filename) {
                                displayName = filename
                                    .replace(/\.(mkv|mp4|avi|webm)$/i, '')
                                    .replace(/\./g, ' ')
                                    .replace(/_/g, ' ')
                                    .trim();
                            } else {
                                displayName = fallbackTitle;
                            }

                            const languages = entry.languages || detectLanguagesFromTitle(filename || '');
                            const languageFlags = renderLanguageFlags(languages);
                            const size = result.size || entry.size;

                            return {
                                name: `[HS+] ${PROVIDER}\n${resLabel}`,
                                title: `${displayName}${languageFlags}${size ? `\n💾 ${size}` : ''}`,
                                url: encodeUrlForStreaming(result.url),
                                size,
                                resolution: resLabel,
                                languages,
                                behaviorHints: { bingeGroup: 'cinedoze-http' },
                                httpProvider: PROVIDER
                            };
                        }
                    }
                } catch (err) {
                    console.log(`[${PROVIDER}] Failed to extract stream: ${err.message}`);
                }

                // Fallback: return null if extraction failed (skip this entry)
                return null;
            });

            const results = await Promise.all(previewPromises);
            const previewStreams = results.filter(Boolean);
            console.log(`[${PROVIDER}] Lazy-load: returning ${previewStreams.length} streams`);
            return previewStreams;
        }

        // Full extraction mode (when lazy-load is disabled)
        const streamPromises = downloadEntries.map(async (entry) => {
            const hostLinks = await expandCineDozeLink(entry.url);
            if (!hostLinks.length) return [];
            return resolveHostLinks(hostLinks, entry);
        });

        const resolved = (await Promise.all(streamPromises)).flat().filter(Boolean);

        // Deduplicate by URL
        const seen = new Set();
        const streams = [];
        for (const stream of resolved) {
            if (!stream.url || seen.has(stream.url)) continue;
            seen.add(stream.url);
            streams.push(stream);
        }

        console.log(`[${PROVIDER}] Returning ${streams.length} streams`);
        return streams;
    } catch (err) {
        console.error(`[${PROVIDER}] Unexpected error: ${err.message}`);
        return [];
    }
}
