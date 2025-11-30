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

function toAbsoluteUrl(href, base) {
    if (!href) return null;
    try {
        return new URL(href, base).toString();
    } catch {
        return href;
    }
}

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
                downloads.push({
                    quality: text.trim() || 'Download',
                    size: null,
                    gdflix: toAbsoluteUrl(href, baseUrl)
                });
            }
        });
    }

    return downloads;
}

async function expandLinkmakeVariants(link, baseUrl) {
    const normalized = toAbsoluteUrl(link, baseUrl);
    if (!normalized) return [];

    try {
        const response = await makeRequest(normalized, { parseHTML: true });
        if (!response.document) return [];

        const $ = response.document;
        const variants = [];

        $('a[href]').each((_, a) => {
            const href = toAbsoluteUrl($(a).attr('href'), normalized);
            if (!href || !/filesdl|gofile|gdflix/i.test(href)) return;

            const text = ($(a).text() || '').trim();
            const qualityMatch = text.toLowerCase().match(/(2160|1080|720|480)p?/);
            const sizeMatch = text.match(/\b\d+(?:\.\d+)?\s*(?:gb|mb)\b/i);

            variants.push({
                quality: qualityMatch ? `${qualityMatch[1]}P DOWNLOAD` : text || 'Download',
                size: sizeMatch ? sizeMatch[0] : null,
                gdflix: href
            });
        });

        const seen = new Set();
        return variants.filter(v => {
            if (!v.gdflix || seen.has(v.gdflix)) return false;
            seen.add(v.gdflix);
            return true;
        });
    } catch (err) {
        console.log(`[MKVCinemas] Failed to expand linkmake variants for ${normalized}: ${err.message}`);
        return [];
    }
}

function extractQualityToken(label = '') {
    const match = label.toLowerCase().match(/(2160|1080|720|480)/);
    return match ? match[1] : null;
}

function sortCandidates(candidates) {
    const score = (href) => {
        const h = href.toLowerCase();
        if (h.includes('gdflix.filesdl.in')) return 100;
        if (h.includes('filesdl.in/watch')) return 90;
        if (h.includes('filesdl.site/cloud')) return 80;
        if (h.includes('gofile.io/d/')) return 50;
        return 0;
    };
    return [...candidates].sort((a, b) => score(b.href) - score(a.href));
}

async function resolveIntermediaryLink(link, baseUrl, qualityHint = '') {
    const normalized = toAbsoluteUrl(link, baseUrl);
    if (!normalized) return null;

    const expectedQuality = extractQualityToken(qualityHint);

    // Handle linkmake wrappers that lead to filesdl/cloud pages
    if (/linkmake\.in\/view/i.test(normalized)) {
        try {
            const response = await makeRequest(normalized, { parseHTML: true });
            if (response.document) {
                const $ = response.document;
                const candidates = [];
                $('a[href]').each((_, a) => {
                    const href = toAbsoluteUrl($(a).attr('href'), normalized);
                    if (!href) return;
                    if (/gdflix\.filesdl\.in|filesdl\.in\/watch|filesdl\.site\/cloud|gofile\.io\/d\//i.test(href)) {
                        const text = ($(a).text() || '').toLowerCase();
                        candidates.push({ href, text });
                    }
                });
                if (candidates.length) {
                    const sorted = sortCandidates(candidates);
                    if (expectedQuality) {
                        const match = sorted.find(c => c.text.includes(expectedQuality));
                        if (match) {
                            if (/filesdl\.site\/cloud/i.test(match.href)) {
                                const deeper = await resolveIntermediaryLink(match.href, normalized, qualityHint);
                                if (deeper) return deeper;
                            }
                            return match.href;
                        }
                    }
                    for (const candidate of sorted) {
                        if (/filesdl\.site\/cloud/i.test(candidate.href)) {
                            const deeper = await resolveIntermediaryLink(candidate.href, normalized, qualityHint);
                            if (deeper) return deeper;
                        } else {
                            return candidate.href;
                        }
                    }
                }
            }
        } catch (err) {
            console.log(`[MKVCinemas] Failed to resolve linkmake link ${normalized}: ${err.message}`);
        }
    }

    // Handle filesdl cloud pages that contain actual host links
    if (/filesdl\.site\/cloud/i.test(normalized)) {
        try {
            const response = await makeRequest(normalized, { parseHTML: true });
            if (response.document) {
                const $ = response.document;
                const candidates = [];
                $('a[href]').each((_, a) => {
                    const href = toAbsoluteUrl($(a).attr('href'), normalized);
                    if (!href) return;
                    const text = ($(a).text() || '').toLowerCase();
                    if (/gdflix\.filesdl\.in|gofile\.io\/d\//i.test(href)) {
                        candidates.push({ href, text });
                    } else if (/filesdl\.in\/watch/i.test(href)) {
                        candidates.push({ href, text });
                    }
                });
                if (candidates.length) {
                    const sorted = sortCandidates(candidates);
                    if (expectedQuality) {
                        const match = sorted.find(c => c.text.includes(expectedQuality));
                        if (match) return match.href;
                    }
                    return sorted[0].href;
                }
            }
        } catch (err) {
            console.log(`[MKVCinemas] Failed to resolve filesdl link ${normalized}: ${err.message}`);
        }
    }

    return normalized;
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

        if (season !== null && episode !== null) {
            const titleForPackCheck = `${content.title} ${bestMatch.title}`.toLowerCase();
            if (/full web series|full season|all episodes|complete(d)? (web )?series|full series/.test(titleForPackCheck)) {
                console.log('[MKVCinemas] Detected full-season/pack post for episodic request, skipping');
                return [];
            }
        }

        const languages = content.languages?.length ? content.languages : detectLanguagesFromTitle(content.title || meta.name);
        const previews = [];
        const optionEntries = [];

        for (const downloadPage of content.downloadPages) {
            // Check if this is a direct HubDrive/GDFlix link (not a page to parse)
            if (/hubdrive|gdflix/i.test(downloadPage)) {
                console.log(`[MKVCinemas] Direct link found: ${downloadPage}`);
                const label = `${content.title || meta.name}`.trim();
                previews.push(
                    createPreviewStream({
                        url: downloadPage,
                        label,
                        provider: PROVIDER,
                        size: null,
                        languages
                    })
                );
                continue;
            }

            // Otherwise, it's a download page - extract options from it
            let options = await extractDownloadOptions(downloadPage);

            const uniqueLinks = new Set(options.map(o => o.gdflix).filter(Boolean));
            if (uniqueLinks.size === 1) {
                const sole = Array.from(uniqueLinks)[0];
                if (/linkmake\.in\/view/i.test(sole)) {
                    const expanded = await expandLinkmakeVariants(sole, downloadPage);
                    if (expanded.length) {
                        options = expanded;
                    }
                }
            }

            if (options.length === 0) {
                console.log(`[MKVCinemas] No download options found at ${downloadPage}`);
                continue;
            }

            options.forEach(opt => {
                if (!opt.gdflix) return;

                optionEntries.push({ opt, sourcePage: downloadPage });
            });
        }

        // Resolve intermediary links and build previews
        for (const entry of optionEntries) {
            const { opt, sourcePage } = entry;
            const resolvedUrl = await resolveIntermediaryLink(opt.gdflix, sourcePage, opt.quality);
            if (!resolvedUrl) continue;

            const label = `${content.title || meta.name} ${opt.quality}`.trim();
            previews.push(
                createPreviewStream({
                    url: resolvedUrl,
                    label,
                    provider: PROVIDER,
                    size: opt.size,
                    languages
                })
            );
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
