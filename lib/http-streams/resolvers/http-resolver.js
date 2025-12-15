/**
 * HTTP Stream URL Resolver
 * Resolves redirect URLs to final streaming links
 * Handles lazy-load mode for 4KHDHub, HDHub4u, and UHDMovies
 */

import { getRedirectLinks, processExtractorLinkWithAwait } from '../providers/4khdhub/extraction.js';
import { validateSeekableUrl } from '../utils/validation.js';

const FAST_SEEK_TIMEOUT_MS = parseInt(process.env.HTTP_STREAM_SEEK_TIMEOUT_MS, 10) || 1500;
const MAX_PARALLEL_VALIDATIONS = parseInt(process.env.HTTP_STREAM_MAX_PARALLEL, 10) || 2;
const RESOLVE_CACHE_TTL = parseInt(process.env.HTTP_STREAM_RESOLVE_CACHE_TTL, 10) || (5 * 60 * 1000); // 5 minutes

const resolveCache = new Map(); // key -> { promise, value, ts }
const DIRECT_HOST_HINTS = ['workers.dev', 'hubcdn.fans', 'r2.dev'];

const VIDEO_EXTENSIONS = new Set([
    '.mp4',
    '.mkv',
    '.avi',
    '.webm',
    '.mov',
    '.m4v',
    '.ts',
    '.m3u8'
]);

const NON_VIDEO_EXTENSIONS = new Set([
    '.zip',
    '.rar',
    '.7z',
    '.iso',
    '.exe',
    '.tar',
    '.gz',
    '.bz2',
    '.xz'
]);

const VIDEO_EXTENSION_LIST = Array.from(VIDEO_EXTENSIONS);
const NON_VIDEO_EXTENSION_LIST = Array.from(NON_VIDEO_EXTENSIONS);

const TRUSTED_VIDEO_HOST_HINTS = [
    'pixeldrain',
    'workers.dev',
    'hubcdn.fans',
    'r2.dev',
    'googleusercontent.com'
];

const VIDEO_TYPE_HINTS = ['mp4', 'mkv', 'webm', 'm3u8', 'avi', 'mov', 'ts', 'm4v'];

function getFileExtension(urlString) {
    try {
        const cleanedUrl = urlString.split('?')[0].split('#')[0];
        const lastSlash = cleanedUrl.lastIndexOf('/');
        const filename = lastSlash >= 0 ? cleanedUrl.slice(lastSlash + 1) : cleanedUrl;
        const lastDot = filename.lastIndexOf('.');
        if (lastDot === -1) {
            return '';
        }
        return filename.slice(lastDot);
    } catch {
        return '';
    }
}

function evaluateVideoCandidate(candidate) {
    if (!candidate?.url) {
        return { isVideo: false, reason: 'missing URL' };
    }

    const urlLower = candidate.url.toLowerCase();

    if (TRUSTED_VIDEO_HOST_HINTS.some(host => urlLower.includes(host))) {
        return { isVideo: true };
    }

    const extension = getFileExtension(urlLower);
    if (extension) {
        if (NON_VIDEO_EXTENSIONS.has(extension)) {
            return { isVideo: false, reason: `${extension} file` };
        }
        if (VIDEO_EXTENSIONS.has(extension)) {
            return { isVideo: true };
        }
    }

    const label = `${candidate.title || ''} ${candidate.name || ''}`.toLowerCase();
    if (label) {
        if (VIDEO_EXTENSION_LIST.some(ext => label.includes(ext))) {
            return { isVideo: true };
        }
        if (NON_VIDEO_EXTENSION_LIST.some(ext => label.includes(ext))) {
            return { isVideo: false, reason: 'non-video label' };
        }
    }

    if (candidate.type) {
        const typeLower = candidate.type.toLowerCase();
        if (VIDEO_TYPE_HINTS.some(type => typeLower.includes(type))) {
            return { isVideo: true };
        }
        if (typeLower.includes('zip') || typeLower.includes('rar')) {
            return { isVideo: false, reason: 'non-video type' };
        }
    }

    // Default to video when we can't confidently determine the file type
    return { isVideo: true };
}

async function findSeekableLink(results, { timeoutMs = FAST_SEEK_TIMEOUT_MS, maxParallel = MAX_PARALLEL_VALIDATIONS } = {}) {
    if (!Array.isArray(results) || results.length === 0) {
        return null;
    }

    const cache = new Map();

    const checkUrl = async (candidate, label) => {
        if (!candidate?.url) return false;
        if (cache.has(candidate.url)) {
            return cache.get(candidate.url);
        }

        const { isVideo, reason } = evaluateVideoCandidate(candidate);
        if (!isVideo) {
            console.log(`[HTTP-RESOLVE] Skipping ${label} link because it is not a video file${reason ? ` (${reason})` : ''}`);
            cache.set(candidate.url, false);
            return false;
        }

        try {
            const validation = await validateSeekableUrl(candidate.url, {
                requirePartialContent: true,
                timeout: timeoutMs
            });
            if (validation.isValid) {
                console.log(`[HTTP-RESOLVE] Selected ${label} link with confirmed 206 support`);
                cache.set(candidate.url, true);
                return true;
            }
            console.log(`[HTTP-RESOLVE] Rejected ${label} link (status: ${validation.statusCode || 'unknown'}) due to missing 206 support`);
            cache.set(candidate.url, false);
            return false;
        } catch (error) {
            console.error(`[HTTP-RESOLVE] Error validating ${label} link: ${error.message}`);
            cache.set(candidate.url, false);
            return false;
        }
    };

    // Sort by priority field from extraction (higher priority first), then deduplicate by URL
    const seen = new Set();
    const candidates = [];

    // Sort results by priority (descending) - extraction already set priority based on button labels
    const sortedResults = [...results].sort((a, b) => {
        const priorityA = a.priority ?? 0;
        const priorityB = b.priority ?? 0;
        return priorityB - priorityA; // Higher priority first
    });

    for (const candidate of sortedResults) {
        if (!candidate?.url || seen.has(candidate.url)) {
            continue;
        }

        const label = candidate.serverType || candidate.name || 'Unknown';
        candidates.push({ candidate, label });
        seen.add(candidate.url);
    }

    console.log(`[HTTP-RESOLVE] Testing ${candidates.length} candidates in priority order:`);
    candidates.forEach((entry, idx) => {
        console.log(`[HTTP-RESOLVE]   ${idx + 1}. [${entry.label}] priority=${entry.candidate.priority ?? 0}`);
    });

    // Validate candidates in small parallel batches to cut down total resolve time
    const batchSize = Math.max(1, maxParallel);
    for (let i = 0; i < candidates.length; i += batchSize) {
        const batch = candidates.slice(i, i + batchSize);
        const validationResults = await Promise.all(
            batch.map(entry => checkUrl(entry.candidate, entry.label))
        );
        const winnerIndex = validationResults.findIndex(Boolean);
        if (winnerIndex !== -1) {
            return batch[winnerIndex].candidate.url;
        }
    }

    return null;
}

/**
 * Resolve a redirect URL to its final direct streaming link
 * Handles lazy-load resolution for 4KHDHub, HDHub4u, and UHDMovies
 * This is called when the user selects a stream, providing lazy resolution
 * Steps: 1) Resolve redirect to file hosting URL, 2) Extract/decrypt to final stream URL, 3) Validate with 206 check
 * @param {string} redirectUrl - Original redirect URL that needs resolution + decryption
 * @returns {Promise<string|null>} - Final direct streaming URL with confirmed 206 support
 */
export async function resolveHttpStreamUrl(redirectUrl) {
    const decodedUrl = decodeURIComponent(redirectUrl);
    const cacheKey = decodedUrl;

    const now = Date.now();
    const cached = resolveCache.get(cacheKey);
    if (cached) {
        if (cached.value && now - cached.ts < RESOLVE_CACHE_TTL) {
            console.log('[HTTP-RESOLVE] Using cached result');
            return cached.value;
        }
        if (cached.promise) {
            console.log('[HTTP-RESOLVE] Joining in-flight resolve');
            return cached.promise;
        }
    }

    const resolverPromise = (async () => {
        console.log('[HTTP-RESOLVE] Starting lazy resolution (on-demand extraction + validation)');
        console.log('[HTTP-RESOLVE] Redirect URL:', decodedUrl.substring(0, 100) + '...');

        // Detect provider type from URL
        let provider = 'Unknown';
        if (decodedUrl.includes('hubcloud') || decodedUrl.includes('hubdrive') || decodedUrl.includes('4khdhub')) {
            provider = '4KHDHub/HDHub4u';
        } else if (decodedUrl.includes('hubcdn.fans')) {
            provider = 'HDHub4u';
        }
        console.log('[HTTP-RESOLVE] Detected provider:', provider);

        // Fast-path: direct hosts (workers/hubcdn/r2) — validate and return without extractor
        if (DIRECT_HOST_HINTS.some(h => decodedUrl.includes(h))) {
            console.log('[HTTP-RESOLVE] Direct host detected, performing fast 206 validation');
            try {
                const validation = await validateSeekableUrl(decodedUrl, { requirePartialContent: true, timeout: FAST_SEEK_TIMEOUT_MS });
                if (validation.isValid) {
                    resolveCache.set(cacheKey, { value: decodedUrl, ts: Date.now() });
                    return decodedUrl;
                }
                console.log('[HTTP-RESOLVE] Direct host failed 206 validation');
            } catch (err) {
                console.log(`[HTTP-RESOLVE] Direct host validation error: ${err.message}`);
            }
        }

        // Step 1: Resolve redirect to file hosting URL (hubcloud/hubdrive)
        let fileHostingUrl;
        const hasRedirectParam = /[?&]id=/i.test(decodedUrl);
        if (hasRedirectParam) {
            console.log('[HTTP-RESOLVE] Resolving redirect to file hosting URL...');
            fileHostingUrl = await getRedirectLinks(decodedUrl);
            if (!fileHostingUrl || !fileHostingUrl.trim()) {
                console.log('[HTTP-RESOLVE] Failed to resolve redirect');
                return null;
            }
            console.log('[HTTP-RESOLVE] Resolved to file hosting URL:', fileHostingUrl.substring(0, 100) + '...');
        } else {
            // Already a direct URL
            fileHostingUrl = decodedUrl;
            console.log('[HTTP-RESOLVE] URL is already a file hosting URL');
        }

        // Step 2: Decrypt file hosting URL to final streaming URL
        console.log('[HTTP-RESOLVE] Decrypting file hosting URL...');
        const result = await processExtractorLinkWithAwait(fileHostingUrl, 99);  // Get ALL results, not just 1

        if (!result || !Array.isArray(result) || result.length === 0) {
            console.log('[HTTP-RESOLVE] No valid stream found after decryption');
            return null;
        }

        console.log(`[HTTP-RESOLVE] Found ${result.length} potential stream(s), selecting best one...`);

        // Log all results for debugging
        result.forEach((r, idx) => {
            const type = r.url.includes('pixeldrain') ? 'Pixeldrain' :
                r.url.includes('googleusercontent') ? 'GoogleUserContent' :
                    r.url.includes('workers.dev') ? 'Workers.dev' :
                        r.url.includes('hubcdn') ? 'HubCDN' :
                            r.url.includes('r2.dev') ? 'R2' : 'Other';
            console.log(`[HTTP-RESOLVE]   ${idx + 1}. [${type}] ${r.url.substring(0, 80)}...`);
        });

        const seekableLink = await findSeekableLink(result);
        if (seekableLink) {
            console.log(`[HTTP-RESOLVE] Returning seekable link: ${seekableLink.substring(0, 100)}...`);
            return seekableLink;
        }

        console.log('[HTTP-RESOLVE] No links with confirmed 206 support were found');
        return null;
    })();

    resolveCache.set(cacheKey, { promise: resolverPromise, ts: now });

    const result = await resolverPromise;
    resolveCache.set(cacheKey, { value: result, ts: Date.now() });
    return result;
}
