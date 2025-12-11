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
import { validateSeekableUrl } from '../../utils/validation.js';
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

function extractSizeFromText(text = '') {
    const match = text.match(/([0-9]+(?:\.[0-9]+)?)\s*(TB|GB|MB)/i);
    if (!match) return null;
    return `${match[1]} ${match[2].toUpperCase()}`;
}

function getFilenameFromUrl(url = '') {
    try {
        const u = new URL(url);
        const last = u.pathname.split('/').pop() || '';
        return decodeURIComponent(last).replace(/\.[^.]+$/, '');
    } catch {
        return null;
    }
}

function formatBytes(bytes) {
    if (!bytes || Number.isNaN(bytes)) return null;
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    const value = bytes / Math.pow(1024, i);
    return `${value.toFixed(value >= 10 || i === 0 ? 0 : 2)} ${units[i]}`;
}

async function parseDirectLinkMetadata(url) {
    try {
        const response = await makeRequest(url, { parseHTML: true });
        const text = (response.body || '').replace(/\s+/g, ' ');
        const $ = response.document;

        const title = $('title').text().trim() || null;
        const sizeMatch = text.match(/file size[:\s]*([0-9]+(?:\.[0-9]+)?\s*(?:TB|GB|MB|KB))/i);
        const size = sizeMatch ? sizeMatch[1].toUpperCase() : null;

        // Pull out candidate hosting links (gdflix/filesdl) so we can skip hubdrive redirects
        const candidates = [];
        $('a[href]').each((_, a) => {
            const href = $(a).attr('href') || '';
            const text = ($(a).text() || '').toLowerCase();
            if (/gdflix|filesdl\.site\/cloud|filesdl\.in\/watch/i.test(href) || /hub cloud|hub drive|cloud download|drive download/.test(text)) {
                const absolute = toAbsoluteUrl(href, url);
                if (absolute) candidates.push(absolute);
            }
        });

        return { title, size, candidates };
    } catch (err) {
        console.log(`[MKVCinemas] Failed to parse direct link metadata for ${url}: ${err.message}`);
        return { title: null, size: null, candidates: [] };
    }
}

function parseDownloadBoxes($, baseUrl) {
    const downloads = [];
    const seen = new Set();
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
            seen.add(link);
        }
    });

    // Always scan anchors to capture filesdl cloud/direct links even when download-box exists
    $('a[href]').each((_, a) => {
        const href = $(a).attr('href') || '';
        const text = $(a).text() || '';
        const hrefMatch = /gdflix|vcloud|filesdl\.site\/cloud|filesdl\.in\/watch|gofile\.io\/d\//i.test(href);
        const viewMatch = /filesdl\.live\/view\/\d+/i.test(href) && /download/i.test(text);
        const textMatch = /gdflix|direct download|fast cloud|download/i.test(text);
        if (hrefMatch || viewMatch || textMatch) {
            const absolute = toAbsoluteUrl(href, baseUrl);
            if (!absolute || seen.has(absolute)) return;
            downloads.push({
                quality: text.trim() || 'Download',
                size: extractSizeFromText(text),
                gdflix: absolute
            });
            seen.add(absolute);
        }
    });

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
    if (/filesdl\.(?:site|in|live)\/cloud/i.test(normalized)) {
        try {
            const response = await makeRequest(normalized, { parseHTML: true });
            if (response.document) {
                const $ = response.document;
                const candidates = [];

                const addCandidate = (href, text = '', weight = 0) => {
                    const absolute = toAbsoluteUrl(href, normalized);
                    if (!absolute) return;
                    candidates.push({ href: absolute, text: text || '', weight });
                };

                // Explicit download buttons (often the real file)
                $('.download-link[href]').each((_, a) => {
                    addCandidate($(a).attr('href'), $(a).text(), 120);
                });

                $('a[href]').each((_, a) => {
                    const href = $(a).attr('href');
                    const absolute = toAbsoluteUrl(href, normalized);
                    if (!absolute) return;
                    const text = ($(a).text() || '').trim();
                    const textLower = text.toLowerCase();
                    const hrefLower = absolute.toLowerCase();

                    if (/gdflix\.filesdl\.in|gofile\.io\/d\//i.test(hrefLower)) {
                        addCandidate(absolute, text, 90);
                    } else if (/filesdl\.in\/watch/i.test(hrefLower)) {
                        addCandidate(absolute, text, 80);
                    } else if (/awsstorage|bbdownload\.filesdl\.in|filesdl\.in\/fdownload|workers\.dev|googleusercontent|photos\.google|drive\.google/i.test(hrefLower)) {
                        addCandidate(absolute, text, 110);
                    } else if (/fast cloud|direct download|watch online|slowcloud|cloud/i.test(textLower)) {
                        addCandidate(absolute, text, 70);
                    }
                });
                if (candidates.length) {
                    const seen = new Set();
                    const unique = [];
                    for (const cand of candidates) {
                        if (!cand.href || seen.has(cand.href)) continue;
                        seen.add(cand.href);
                        unique.push(cand);
                    }
                    const sorted = unique.sort((a, b) => (b.weight || 0) - (a.weight || 0));
                    if (expectedQuality) {
                        const match = sorted.find(c => (c.text || '').toLowerCase().includes(expectedQuality));
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

function isHosterWrapper(url = '') {
    const lower = url.toLowerCase();
    return /gdflix\.net\/file|gdflix\.filesdl\.in|filesdl\.(live|site|in)\/(view|cloud|watch)|linkmake\.in\/view/.test(lower);
}

function isDirectCandidate(url = '') {
    const lower = url.toLowerCase();
    return /\.(mp4|mkv|webm|mov|m4v|ts)(\?|$)/.test(lower) ||
        /(pixeldrain|workers\.dev|hubcdn\.fans|r2\.dev|googleusercontent\.com|photos\.google|drive\.google|awsstorage|bbdownload\.filesdl\.in)/.test(lower);
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

export async function getMKVCinemasStreams(tmdbId, type, season = null, episode = null, config = {}, signal = null) {
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
            const results = await scrapeMKVCinemasSearch(query, signal);
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

        const content = await loadMKVCinemasContent(bestMatch.url, signal);
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
            if (/hubdrive|hubcloud|gdflix/i.test(downloadPage)) {
                console.log(`[MKVCinemas] Direct link found: ${downloadPage}`);
                const metaInfo = await parseDirectLinkMetadata(downloadPage);

                // If the direct link page already exposes real host links, queue those instead of the wrapper
                if (metaInfo.candidates && metaInfo.candidates.length) {
                    metaInfo.candidates.forEach(link => {
                        optionEntries.push({
                            opt: { gdflix: link, quality: metaInfo.title || content.title || meta.name, size: metaInfo.size || null },
                            sourcePage: downloadPage
                        });
                    });
                    continue;
                }

                const label = `${metaInfo.title || content.title || meta.name}`.trim();
                const size = metaInfo.size || null;
                previews.push(
                    createPreviewStream({
                        url: downloadPage,
                        label,
                        provider: PROVIDER,
                        size,
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

            // Avoid returning obvious non-seekable direct URLs (busycdn, dead direct links)
            let filename = null;
            let contentLength = null;
            if (!isHosterWrapper(resolvedUrl) && isDirectCandidate(resolvedUrl)) {
                try {
                    const validation = await validateSeekableUrl(resolvedUrl, { requirePartialContent: true, timeout: 4000 });
                    filename = validation.filename || filename;
                    contentLength = validation.contentLength || contentLength;
                    if (!validation.isValid) {
                        console.log(`[MKVCinemas] Skipping non-seekable direct link (${validation.statusCode || 'unknown'}): ${resolvedUrl}`);
                        continue;
                    }
                } catch (err) {
                    console.log(`[MKVCinemas] Seekable check failed for ${resolvedUrl}: ${err.message}`);
                    continue;
                }
            }

            const isWrapper = isHosterWrapper(resolvedUrl);
            const inferredName = !isWrapper ? (filename || getFilenameFromUrl(resolvedUrl)) : null;
            const label = (inferredName || `${opt.quality || content.title || meta.name}`).trim();
            const size = opt.size || extractSizeFromText(label) || extractSizeFromText(resolvedUrl) || formatBytes(contentLength);
            previews.push(
                createPreviewStream({
                    url: resolvedUrl,
                    label,
                    provider: PROVIDER,
                    size,
                    languages
                })
            );
        }

        if (previews.length === 0) {
            console.log('[MKVCinemas] No GDFlix links collected');
            return [];
        }

        // If we managed to collect direct/validated links, prefer them over hoster wrappers
        const directPreviews = previews.filter(p => !isHosterWrapper(p.url));
        const previewsToUse = directPreviews.length ? directPreviews : previews;

        // Deduplicate by URL
        const seen = new Set();
        const uniquePreviews = previewsToUse.filter(stream => {
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
