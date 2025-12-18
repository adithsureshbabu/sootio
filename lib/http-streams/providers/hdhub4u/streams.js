/**
 * HDHub4u Streams
 * Converts HDHub4u download links into direct HTTP streams
 */

import Cinemeta from '../../../util/cinemeta.js';
import {
    renderLanguageFlags,
    detectLanguagesFromTitle
} from '../../../util/language-mapping.js';
import {
    getResolutionFromName,
    removeYear,
    generateAlternativeQueries,
    calculateSimilarity,
    normalizeTitle
} from '../../utils/parsing.js';
import { encodeUrlForStreaming } from '../../utils/encoding.js';
import { validateSeekableUrl } from '../../utils/validation.js';
import { searchHdHub4uPosts, loadHdHub4uPost } from './search.js';
import { processExtractorLinkWithAwait } from '../4khdhub/extraction.js';
import { batchExtractFilenames } from './extraction.js';
import { isLazyLoadEnabled, createPreviewStream, formatPreviewStreams } from '../../utils/preview-mode.js';

// Enable filename extraction in lazy-load mode (adds latency but provides accurate filenames)
// Disabled by default to avoid timeouts - set HDHUB4U_EXTRACT_FILENAMES=true to enable
const EXTRACT_FILENAMES_IN_LAZY_MODE = process.env.HDHUB4U_EXTRACT_FILENAMES === 'true';

const MAX_LINKS = parseInt(process.env.HDHUB4U_MAX_LINKS, 10) || 14;
const MAX_THREAD_COUNT = Math.max(
    1,
    parseInt(process.env.HDHUB4U_THREAD_COUNT || process.env.HDHUB4U_BATCH_SIZE, 10) || 8
);
const SEEK_VALIDATION_ENABLED = process.env.DISABLE_HDHUB4U_SEEK_VALIDATION !== 'true';

const TRUSTED_HOSTS = [
    'pixeldrain',
    'workers.dev',
    'r2.dev',
    'hubcdn.fans',
    'googleusercontent.com'
];

const SUSPICIOUS_PATTERNS = [
    'cdn.ampproject.org',
    'bloggingvector.shop'
];

function normalizeLabel(label) {
    return label ? label.replace(/\s+/g, ' ').trim() : '';
}

function prioritizeLinks(downloadLinks, type, season, episode) {
    const requestedSeason = season ? parseInt(season) : null;
    const requestedEpisode = episode ? parseInt(episode) : null;

    return downloadLinks
        .map(link => {
            let priority = 0;

            // Prefer per-episode links for series
            if (type === 'series') {
                if (requestedSeason && link.season === requestedSeason) {
                    priority += 30;
                }
                if (requestedEpisode && link.episode === requestedEpisode) {
                    priority += 40;
                }
                if (!requestedEpisode && requestedSeason && link.label?.includes(`S${requestedSeason}`)) {
                    priority += 20;
                }
            }

            // Prefer higher resolution
            const resolution = getResolutionFromName(link.label);
            if (resolution === '2160p') priority += 25;
            else if (resolution === '1080p') priority += 20;
            else if (resolution === '720p') priority += 10;

            // Prefer HEVC/265 encodes
            if (/HEVC|H265|x265/i.test(link.label)) priority += 5;

            // Slight preference for smaller sizes for faster extraction
            if (link.size && /MB/i.test(link.size)) priority += 3;

            return { ...link, priority };
        })
        .sort((a, b) => b.priority - a.priority);
}

async function processDownloadLink(link, index) {
    try {
        const results = await processExtractorLinkWithAwait(link.url, index + 1);
        if (!results || results.length === 0) {
            return [];
        }

        return results.map(result => ({
            url: result.url,
            name: result.name || 'HDHub4u',
            quality: result.quality || getResolutionFromName(link.label),
            size: link.size,
            sourceLabel: link.label,
            languages: link.languages?.length ? link.languages : detectLanguagesFromTitle(link.label),
            resolverUrl: link.url
        }));
    } catch (error) {
        console.error(`[HDHub4u] Failed to process link ${link.url}:`, error.message);
        return [];
    }
}

async function extractStreamingLinks(downloadLinks, type, season, episode) {
    const prioritized = prioritizeLinks(downloadLinks, type, season, episode);
    const limited = prioritized.slice(0, MAX_LINKS);

    if (limited.length === 0) {
        return [];
    }

    const concurrency = Math.min(MAX_THREAD_COUNT, limited.length);
    console.log(`[HDHub4u] Extracting ${limited.length} links with concurrency ${concurrency}`);

    const results = new Array(limited.length);
    let cursor = 0;

    const worker = async () => {
        while (cursor < limited.length) {
            const currentIndex = cursor++;
            const link = limited[currentIndex];
            results[currentIndex] = await processDownloadLink(link, currentIndex);
        }
    };

    await Promise.all(Array.from({ length: concurrency }, worker));
    return results.flat();
}

function filterSuspicious(links) {
    return links.filter(link => {
        if (!link.url) return false;
        const lower = link.url.toLowerCase();
        const suspicious = SUSPICIOUS_PATTERNS.some(pattern => lower.includes(pattern));
        if (suspicious) {
            console.log(`[HDHub4u] Filtered suspicious URL: ${link.url}`);
            return false;
        }
        return true;
    });
}

function dedupeLinks(links) {
    const seen = new Set();
    const unique = [];
    for (const link of links) {
        if (!link.url) continue;
        if (!seen.has(link.url)) {
            seen.add(link.url);
            unique.push(link);
        }
    }
    return unique;
}

async function validateLinks(links) {
    if (!links?.length) {
        return [];
    }

    if (process.env.DISABLE_HDHUB4U_URL_VALIDATION === 'true') {
        console.log('[HDHub4u] URL validation disabled via env, but enforcing 206 confirmation');
    }

    if (!SEEK_VALIDATION_ENABLED) {
        console.log('[HDHub4u] Seek validation disabled via env override, forcing 206 confirmation for all links');
    }

    const trusted = [];
    const otherLinks = [];
    for (const link of links) {
        if (!link.url) continue;
        if (TRUSTED_HOSTS.some(host => link.url.includes(host))) {
            trusted.push(link);
        } else {
            otherLinks.push(link);
        }
    }

    const orderedLinks = [...trusted, ...otherLinks];
    const validated = [];

    for (let i = 0; i < orderedLinks.length; i += 4) {
        const slice = orderedLinks.slice(i, i + 4);
        const checks = await Promise.all(slice.map(async (link) => {
            try {
                const result = await validateSeekableUrl(link.url, { requirePartialContent: true });
                if (!result.isValid) {
                    console.log(`[HDHub4u] Dropped link (status ${result.statusCode || 'unknown'}) without confirmed 206 response: ${link.url}`);
                    return null;
                }
                if (result.filename) {
                    link.sourceLabel = `${result.filename} ${link.sourceLabel || ''}`.trim();
                }
                return link;
            } catch (error) {
                console.log(`[HDHub4u] Error validating ${link.url}: ${error.message}`);
                return null;
            }
        }));

        validated.push(...checks.filter(Boolean));
    }

    return validated;
}

function mapToStreams(links) {
    const trustedDirectHosts = ['hubcloud', 'hubcdn', 'pixeldrain', 'r2.dev', 'workers.dev', 'googleusercontent.com'];

    return links.map(link => {
        let resolution = getResolutionFromName(link.sourceLabel);
        if (resolution === 'other') {
            resolution = getResolutionFromName(link.name);
        }

        let resolutionLabel = resolution;
        if (resolution === '2160p') resolutionLabel = '4k';

        const languages = link.languages?.length ? link.languages : detectLanguagesFromTitle(link.sourceLabel);
        const languageFlags = renderLanguageFlags(languages);
        let needsResolution = Boolean(link.resolverUrl);
        const directUrl = encodeUrlForStreaming(link.url);

        const urlLower = (link.url || '').toLowerCase();
        const directIsTrusted = urlLower && trustedDirectHosts.some(host => urlLower.includes(host));

        let streamUrl;
        if (directIsTrusted) {
            needsResolution = false;
            streamUrl = encodeUrlForStreaming(link.url);
        } else {
            const resolverSource = needsResolution ? link.resolverUrl : link.url;
            streamUrl = encodeUrlForStreaming(resolverSource || link.url);
        }
        const size = link.size || extractSizeFromLabel(link.sourceLabel || link.name);

        return {
            name: `[HS+] Sootio\n${resolutionLabel}`,
            title: `${normalizeLabel(link.sourceLabel || link.name)}${languageFlags}\n💾 ${size || 'N/A'} | HDHub4u`,
            url: streamUrl,
            size,
            resolution,
            needsResolution,
            resolverFallbackUrl: directUrl,
            behaviorHints: {
                bingeGroup: 'hdhub4u-streams',
                hdhub4uDirectUrl: directUrl
            }
        };
    });
}

function extractSizeFromLabel(label) {
    if (!label) return null;
    const match = label.match(/([0-9]+(?:\.[0-9]+)?)\s*(TB|GB|MB)/i);
    if (!match) return null;
    return `${match[1]} ${match[2].toUpperCase()}`;
}

function filterEpisodeStreams(streams, season, episode) {
    if (!season || !episode) return streams;
    const requestedSeason = parseInt(season);
    const requestedEpisode = parseInt(episode);

    return streams.filter(stream => {
        const title = stream.title || '';

        // First, check for explicit SxxExx format which is most reliable
        const sxxexxMatch = title.match(/S0*(\d+)\s*E0*(\d+)/i);
        if (sxxexxMatch) {
            const s = parseInt(sxxexxMatch[1]);
            const e = parseInt(sxxexxMatch[2]);
            return s === requestedSeason && e === requestedEpisode;
        }

        // Check for "Episode X" at the START of the title (before any "|" or "–" separators)
        // This avoids matching button text like "Instant EPiSODE 1" at the end
        const titleStart = title.split(/[|–-]/)[0];
        const episodeMatch = titleStart.match(/Episode\s*0*(\d+)/i);
        if (episodeMatch) {
            const e = parseInt(episodeMatch[1]);
            return e === requestedEpisode;
        }

        // Check for "EP X" or "Ep.X" format at the start
        const epMatch = titleStart.match(/\bEP\.?\s*0*(\d+)/i);
        if (epMatch) {
            const e = parseInt(epMatch[1]);
            return e === requestedEpisode;
        }

        // Fallback: no episode marker found, exclude by default for series
        return false;
    });
}

async function findBestMatch(searchResults, targetTitle) {
    let bestMatch = null;
    let bestScore = -Infinity;
    const normalizedTarget = normalizeTitle(targetTitle);

    for (const result of searchResults) {
        const similarity = calculateSimilarity(normalizedTarget, result.slug);
        const score = similarity - (result.score || 0);
        if (score > bestScore) {
            bestScore = score;
            bestMatch = result;
        }
    }

    return bestMatch;
}

export async function getHDHub4uStreams(imdbId, type, season = null, episode = null, signal = null) {
    try {
        const cinemetaDetails = await Cinemeta.getMeta(type, imdbId);
        if (!cinemetaDetails) {
            console.log('[HDHub4u] Cinemeta lookup failed');
            return [];
        }

        const year = cinemetaDetails.year ? parseInt(cinemetaDetails.year.split('-')[0]) : null;

        // Build query list: use alternative titles if available, otherwise use standard generation
        let queries = [];
        if (cinemetaDetails.alternativeTitles && cinemetaDetails.alternativeTitles.length > 0) {
            console.log(`[HDHub4u] Using ${cinemetaDetails.alternativeTitles.length} alternative titles for search`);
            queries = cinemetaDetails.alternativeTitles;
        } else {
            queries = generateAlternativeQueries(cinemetaDetails.name, cinemetaDetails.original_title);
        }

        let searchResults = [];
        let usedYearFallback = false;
        for (const query of queries) {
            console.log(`[HDHub4u] Searching with query: "${query}"`);
            const results = await searchHdHub4uPosts(query, 12);
            if (results.length > 0) {
                searchResults = results;
                console.log(`[HDHub4u] Query "${query}" found ${results.length} results`);
                break;
            }
        }

        // Fallback: For recent movies/series with regional title mismatches
        // This helps when Cinemeta has a different title than what's on HDHub4u
        // (e.g., "Vampires of Vijay Nagar" vs "Thamma")
        if (searchResults.length === 0 && year && year >= 2020) {
            console.log(`[HDHub4u] Primary search failed, trying fallback with year ${year}`);

            // For very recent movies, search by year with larger limit
            // Fuse.js prioritizes shorter titles, so we need more results to find longer titles
            const yearResults = await searchHdHub4uPosts(year.toString(), 100);
            if (yearResults.length > 0) {
                searchResults = yearResults;
                usedYearFallback = true;
                console.log(`[HDHub4u] Year-based fallback found ${yearResults.length} results`);
            }
        }

        if (searchResults.length === 0) {
            console.log('[HDHub4u] No search results found');
            return [];
        }

        // Try multiple matches to find one with correct year/season
        // For series with season requested, try more matches to find the correct season
        // Check more results since Fuse.js prioritizes shorter titles
        let content = null;
        let matchIndex = 0;
        const isSeries = type === 'series' || type === 'tv';
        const needsMultipleAttempts = usedYearFallback || (isSeries && season);
        const maxAttempts = needsMultipleAttempts ? Math.min(80, searchResults.length) : Math.min(12, searchResults.length);

        while (matchIndex < maxAttempts && !content) {
            const bestMatch = searchResults[matchIndex];
            if (!bestMatch) break;

            // When using year fallback, skip very short generic titles (like "55", "Mrs", "G20")
            // to prefer longer, more specific titles that might be regional variations
            if (usedYearFallback) {
                const titleWords = bestMatch.slug.split(/\s+/).filter(w => w.length > 0 && !/^\d{4}$/.test(w)); // Filter out year
                const mainTitle = titleWords.filter(w => {
                    const lowerWord = w.toLowerCase();
                    return !['hindi', 'english', 'webrip', 'bluray', 'full', 'movie', 'series', 'hdtc', 'dubbed', 'dual', 'audio'].includes(lowerWord);
                });

                if (mainTitle.length > 0) {
                    const titleText = mainTitle.join(' ');
                    const titleLength = titleText.replace(/\s+/g, '').length;
                    // Skip if title is very short (1-5 characters) unless we've checked many matches
                    // This helps skip generic abbreviated titles like "55", "Mrs", "HAQ" in favor of
                    // longer regional titles like "Thamma" that might appear later
                    if (titleLength <= 5 && matchIndex < 60) {
                        console.log(`[HDHub4u] Skipping short title "${titleText}" (${titleLength} chars) at position ${matchIndex + 1}, looking for more specific match`);
                        matchIndex++;
                        continue;
                    }
                }
            }

            console.log(`[HDHub4u] Trying match ${matchIndex + 1}: ${bestMatch.slug}`);
            const candidateContent = await loadHdHub4uPost(bestMatch.url, signal);

            if (!candidateContent || !candidateContent.downloadLinks?.length) {
                console.log(`[HDHub4u] No download links found for ${bestMatch.url}`);
                matchIndex++;
                continue;
            }

            // Check year match when using fallback
            if (usedYearFallback && year && candidateContent.year && Math.abs(candidateContent.year - year) > 1) {
                console.log(`[HDHub4u] Year mismatch (${candidateContent.year} vs ${year}), trying next match`);
                matchIndex++;
                continue;
            }

            const normalizedTarget = normalizeTitle(cinemetaDetails.name);
            const normalizedContentTitle = normalizeTitle(candidateContent.title || '');

            // Skip strict title matching for series when using year fallback (helps with regional title mismatches)
            if (type !== 'movie' && normalizedTarget && !normalizedContentTitle.includes(normalizedTarget) && !usedYearFallback) {
                console.log(`[HDHub4u] Skipping content due to title mismatch: "${candidateContent.title}" vs target "${normalizedTarget}"`);
                matchIndex++;
                continue;
            }

            // For movies, enforce a minimum title similarity to avoid wrong matches
            if (type === 'movie' && normalizedTarget) {
                const titleSimilarity = calculateSimilarity(normalizedTarget, normalizedContentTitle);
                const minSimilarity = usedYearFallback ? 0.38 : 0.32;
                if (titleSimilarity < minSimilarity) {
                    console.log(`[HDHub4u] Skipping content due to low title similarity (${titleSimilarity.toFixed(3)} < ${minSimilarity}): "${candidateContent.title}"`);
                    matchIndex++;
                    continue;
                }
            }

            // For movies, verify year match
            if (type === 'movie' && year && candidateContent.year && Math.abs(candidateContent.year - year) > 1) {
                console.log(`[HDHub4u] Year mismatch (${candidateContent.year} vs ${year})`);
                matchIndex++;
                continue;
            }

            // For series, verify that the requested season exists in the content
            if ((type === 'series' || type === 'tv') && season) {
                const requestedSeason = parseInt(season);
                const contentTitle = (candidateContent.title || '').toLowerCase();

                // Check if content title mentions a DIFFERENT season
                const seasonMatch = contentTitle.match(/season\s*(\d+)|s(\d+)/i);
                if (seasonMatch) {
                    const foundSeason = parseInt(seasonMatch[1] || seasonMatch[2]);
                    if (foundSeason !== requestedSeason) {
                        console.log(`[HDHub4u] Season mismatch in title: found Season ${foundSeason}, requested Season ${requestedSeason} - "${candidateContent.title}"`);
                        matchIndex++;
                        continue;
                    }
                }

                // Also check if any download links have the requested season
                const hasRequestedSeason = candidateContent.downloadLinks?.some(link => {
                    const linkSeason = link.season;
                    if (linkSeason === requestedSeason) return true;

                    // Check label for season markers
                    const labelLower = (link.label || '').toLowerCase();
                    const labelSeasonMatch = labelLower.match(/s0*(\d+)|season\s*(\d+)/i);
                    if (labelSeasonMatch) {
                        const labelSeason = parseInt(labelSeasonMatch[1] || labelSeasonMatch[2]);
                        return labelSeason === requestedSeason;
                    }

                    return false;
                });

                if (!hasRequestedSeason && candidateContent.downloadLinks?.length > 0) {
                    // Check if links have ANY season info - if they do and none match, skip
                    const hasAnySeasonInfo = candidateContent.downloadLinks.some(link => {
                        const labelLower = (link.label || '').toLowerCase();
                        return link.season || /s\d+|season\s*\d+/i.test(labelLower);
                    });

                    if (hasAnySeasonInfo) {
                        console.log(`[HDHub4u] Content has season info but not Season ${requestedSeason}, skipping "${candidateContent.title}"`);
                        matchIndex++;
                        continue;
                    }
                }
            }

            // Found a good match!
            content = candidateContent;
            console.log(`[HDHub4u] Using match: ${candidateContent.title}`);
        }

        if (!content) {
            console.log(`[HDHub4u] No suitable content found after checking ${matchIndex} matches`);
            return [];
        }

        // CHECK FOR LAZY-LOAD MODE
        if (isLazyLoadEnabled()) {
            console.log(`[HDHub4u] Lazy-load enabled: returning ${content.downloadLinks.length} preview streams without extraction/validation`);

            // HDHub4u already has rich metadata in downloadLinks!
            let linksToProcess = content.downloadLinks;

            // PRE-FILTER by episode metadata for series
            if ((type === 'series' || type === 'tv') && season && episode) {
                const requestedSeason = parseInt(season);
                const requestedEpisode = parseInt(episode);

                // Filter links that have episode metadata matching the requested episode
                const episodeFilteredLinks = linksToProcess.filter(link => {
                    // If link has explicit episode number, it must match
                    if (link.episode !== null && link.episode !== undefined) {
                        return link.episode === requestedEpisode;
                    }

                    // Check label for episode markers at the START (before separators)
                    const label = link.label || '';
                    const labelStart = label.split(/[|–]/)[0];

                    // Check for SxxExx format
                    const sxxexxMatch = labelStart.match(/S0*(\d+)\s*E0*(\d+)/i);
                    if (sxxexxMatch) {
                        const e = parseInt(sxxexxMatch[2]);
                        return e === requestedEpisode;
                    }

                    // Check for "Episode X" at the start
                    const episodeMatch = labelStart.match(/Episode\s*0*(\d+)/i);
                    if (episodeMatch) {
                        const e = parseInt(episodeMatch[1]);
                        return e === requestedEpisode;
                    }

                    // Check for "EP X" format
                    const epMatch = labelStart.match(/\bEP\.?\s*0*(\d+)/i);
                    if (epMatch) {
                        const e = parseInt(epMatch[1]);
                        return e === requestedEpisode;
                    }

                    // No episode marker - exclude for series
                    return false;
                });

                if (episodeFilteredLinks.length > 0) {
                    console.log(`[HDHub4u] Pre-filtered to ${episodeFilteredLinks.length} links for Episode ${requestedEpisode}`);
                    linksToProcess = episodeFilteredLinks;
                } else {
                    console.log(`[HDHub4u] No links matched Episode ${requestedEpisode} by metadata, keeping all for title-based filtering`);
                }
            }

            // Prioritize and limit the links
            const prioritized = prioritizeLinks(linksToProcess, type, season, episode);
            const limited = prioritized.slice(0, MAX_LINKS);

            // Optionally extract filenames from hub pages
            let filenameMap = new Map();
            if (EXTRACT_FILENAMES_IN_LAZY_MODE) {
                try {
                    filenameMap = await batchExtractFilenames(limited, 5);
                } catch (err) {
                    console.log(`[HDHub4u] Filename extraction failed: ${err.message}`);
                }
            }

            // Create preview streams with the rich metadata
            const previewStreams = limited.map(link => {
                // Try to get extracted filename, fall back to original label
                const extractedInfo = filenameMap.get(link.url);
                const label = extractedInfo?.filename || link.label || 'HDHub4u Stream';
                const size = extractedInfo?.size || link.size;

                return createPreviewStream({
                    url: link.url,
                    label: label,
                    provider: 'HDHub4u',
                    size: size,
                    languages: link.languages || []
                });
            });

            // Format for Stremio
            const streams = formatPreviewStreams(previewStreams, encodeUrlForStreaming, renderLanguageFlags);

            // Apply additional episode filtering on formatted titles as fallback
            if ((type === 'series' || type === 'tv') && season && episode) {
                const episodeStreams = filterEpisodeStreams(streams, season, episode);
                if (episodeStreams.length > 0) {
                    console.log(`[HDHub4u] Returning ${episodeStreams.length} preview streams for S${season}E${episode} (lazy-load mode)`);
                    return episodeStreams;
                }
            }

            console.log(`[HDHub4u] Returning ${streams.length} preview streams (lazy-load mode)`);
            return streams;
        }

        // LEGACY MODE: Full extraction and validation (slow but thorough)
        console.log(`[HDHub4u] Lazy-load disabled: extracting and validating all streams (legacy mode)`);
        const streamingLinks = await extractStreamingLinks(content.downloadLinks, type, season, episode);
        if (streamingLinks.length === 0) {
            console.log('[HDHub4u] No streaming links after extraction');
            return [];
        }

        const filtered = filterSuspicious(streamingLinks);
        const unique = dedupeLinks(filtered);
        const validated = await validateLinks(unique);
        if (validated.length === 0) {
            console.log('[HDHub4u] No validated links remained');
            return [];
        }

        // ALWAYS filter out googleusercontent.com - user requested to NEVER return these
        const googleUserContentCount = validated.filter(link => link.url?.includes('googleusercontent.com')).length;
        const finalValidated = validated.filter(link => !link.url?.includes('googleusercontent.com'));

        if (googleUserContentCount > 0) {
            console.log(`[HDHub4u] Filtered out ${googleUserContentCount} googleusercontent.com link(s), keeping ${finalValidated.length} other links`);
        }

        if (finalValidated.length === 0) {
            console.log('[HDHub4u] No links remaining after filtering googleusercontent.com');
            return [];
        }

        let streams = mapToStreams(finalValidated);
        streams.sort((a, b) => {
            const priority = { '2160p': 4, '1080p': 3, '720p': 2, '480p': 1, other: 0 };
            const resDiff = (priority[b.resolution] || 0) - (priority[a.resolution] || 0);
            if (resDiff !== 0) return resDiff;

            // If resolutions are the same, sort by size (larger first)
            // Convert sizes to MB for proper comparison
            const getSizeInMB = (sizeStr) => {
                if (!sizeStr) return 0;
                const match = sizeStr.match(/([0-9.]+)\s*(GB|MB|TB)/i);
                if (!match) return 0;
                const value = parseFloat(match[1]);
                const unit = match[2].toUpperCase();
                if (unit === 'TB') return value * 1024 * 1024;
                if (unit === 'GB') return value * 1024;
                if (unit === 'MB') return value;
                return 0;
            };
            const sizeA = getSizeInMB(a.size);
            const sizeB = getSizeInMB(b.size);
            return sizeB - sizeA;
        });

        if ((type === 'series' || type === 'tv') && season && episode) {
            const episodeStreams = filterEpisodeStreams(streams, season, episode);
            if (episodeStreams.length > 0) {
                streams = episodeStreams;
            }
        }

        console.log(`[HDHub4u] Returning ${streams.length} streams`);
        return streams;
    } catch (error) {
        console.error('[HDHub4u] Error getting streams:', error.message);
        return [];
    }
}

export { filterEpisodeStreams };
