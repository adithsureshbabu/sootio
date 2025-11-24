/**
 * MKVCinemas Streams
 * Builds HTTP streams from mkvcinemas download pages (GDFlix -> HubCloud)
 */

import Cinemeta from '../../../util/cinemeta.js';
import { scrapeMKVCinemasSearch, loadMKVCinemasContent } from './search.js';
import { makeRequest } from '../../utils/http.js';
import {
    removeYear,
    generateAlternativeQueries,
    getSortedMatches
} from '../../utils/parsing.js';
import { encodeUrlForStreaming } from '../../utils/encoding.js';
import { renderLanguageFlags, detectLanguagesFromTitle } from '../../../util/language-mapping.js';
import { createPreviewStream, formatPreviewStreams, isLazyLoadEnabled } from '../../utils/preview-mode.js';

const PROVIDER = 'MKVCinemas';

function parseDownloadBoxes($, baseUrl) {
    const downloads = [];
    $('.download-box').each((_, box) => {
        const quality = $(box).find('h2').text().trim();
        const size = $(box).find('.filesize').text().trim();

        let link = $(box).find('a.btn-gdflix').attr('href');
        if (!link) {
            // Fallback: any anchor that looks like a GDFlix link
            $(box).find('a[href]').each((__, a) => {
                const href = $(a).attr('href') || '';
                const text = ($(a).text() || '').toLowerCase();
                if (href.includes('vcloud') || href.includes('gdflix') || text.includes('gdflix')) {
                    link = href;
                }
            });
        }

        if (link) {
            try {
                link = new URL(link, baseUrl).toString();
            } catch {
                // leave link as-is
            }

            downloads.push({
                quality: quality || 'Download',
                size: size || null,
                gdflix: link
            });
        }
    });

    // In case the page does not use download-box wrappers
    if (downloads.length === 0) {
        $('a[href]').each((_, a) => {
            const href = $(a).attr('href') || '';
            const text = $(a).text() || '';
            if (/gdflix|vcloud/i.test(href) || /gdflix/i.test(text)) {
                try {
                    const absolute = new URL(href, baseUrl).toString();
                    downloads.push({
                        quality: text.trim() || 'Download',
                        size: null,
                        gdflix: absolute
                    });
                } catch {
                    downloads.push({
                        quality: text.trim() || 'Download',
                        size: null,
                        gdflix: href
                    });
                }
            }
        });
    }

    return downloads;
}

async function extractDownloadOptions(downloadPageUrl) {
    try {
        const response = await makeRequest(downloadPageUrl, { parseHTML: true });
        if (!response.document) return [];
        return parseDownloadBoxes(response.document, downloadPageUrl);
    } catch (error) {
        console.error(`[MKVCinemas] Failed to parse download page ${downloadPageUrl}: ${error.message}`);
        return [];
    }
}

export async function getMKVCinemasStreams(tmdbId, type, season = null, episode = null, config = {}) {
    // MKVCinemas primarily hosts movies; bail early for episodic requests
    if (type === 'series' || type === 'tv') {
        console.log('[MKVCinemas] Skipping series request – provider is movie-focused');
        return [];
    }

    try {
        const meta = await Cinemeta.getMeta(type, tmdbId);
        if (!meta?.name) {
            console.log(`[MKVCinemas] Cinemeta lookup failed for ${tmdbId}`);
            return [];
        }

        const searchQueries = [];
        const baseTitle = meta.name;
        searchQueries.push(baseTitle);

        const noYear = removeYear(baseTitle);
        if (noYear !== baseTitle) {
            searchQueries.push(noYear);
        }

        const altQueries = generateAlternativeQueries(meta.name, meta.original_title || '');
        altQueries.forEach(q => {
            if (q && !searchQueries.includes(q)) {
                searchQueries.push(q);
            }
        });

        const searchResults = [];
        for (const query of searchQueries) {
            const results = await scrapeMKVCinemasSearch(query);
            searchResults.push(...results);
        }

        if (searchResults.length === 0) {
            console.log('[MKVCinemas] No search results found');
            return [];
        }

        const sorted = getSortedMatches(searchResults, meta.name);
        const bestMatch = sorted[0];
        if (!bestMatch?.url) {
            console.log('[MKVCinemas] No suitable match found after scoring');
            return [];
        }

        console.log(`[MKVCinemas] Selected post: ${bestMatch.title} (${bestMatch.url})`);

        const content = await loadMKVCinemasContent(bestMatch.url);
        if (!content.downloadPages?.length) {
            console.log('[MKVCinemas] No download pages found on post');
            return [];
        }

        const languages = content.languages?.length ? content.languages : detectLanguagesFromTitle(content.title || meta.name);
        const previews = [];

        for (const downloadPage of content.downloadPages) {
            const options = await extractDownloadOptions(downloadPage);
            if (options.length === 0) {
                console.log(`[MKVCinemas] No download options found at ${downloadPage}`);
                continue;
            }

            options.forEach(opt => {
                if (!opt.gdflix) return;

                const label = `${content.title || meta.name} ${opt.quality}`.trim();
                previews.push(
                    createPreviewStream({
                        url: opt.gdflix,
                        label,
                        provider: PROVIDER,
                        size: opt.size,
                        languages
                    })
                );
            });
        }

        if (previews.length === 0) {
            console.log('[MKVCinemas] No GDFlix links collected');
            return [];
        }

        // Deduplicate by URL
        const seen = new Set();
        const uniquePreviews = previews.filter(stream => {
            if (!stream.url || seen.has(stream.url)) return false;
            seen.add(stream.url);
            return true;
        });

        if (!isLazyLoadEnabled()) {
            console.log('[MKVCinemas] Lazy-load disabled, but GDFlix links require resolution. Returning preview streams for resolver.');
        }

        const formatted = formatPreviewStreams(uniquePreviews, encodeUrlForStreaming, renderLanguageFlags)
            .map(stream => ({
                ...stream,
                behaviorHints: {
                    bingeGroup: 'mkvcinemas-streams'
                }
            }));

        console.log(`[MKVCinemas] Returning ${formatted.length} preview stream(s)`);
        return formatted;
    } catch (error) {
        console.error(`[MKVCinemas] Error building streams: ${error.message}`);
        return [];
    }
}
