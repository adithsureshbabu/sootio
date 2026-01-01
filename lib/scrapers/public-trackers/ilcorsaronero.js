import axios from 'axios';
import * as cheerio from 'cheerio';
import * as config from '../../config.js';
import { getHashFromMagnet, sizeToBytes } from '../../common/torrent-utils.js';

// Import scraper utilities
import { createTimerLabel } from '../utils/timing.js';
import { processAndDeduplicate } from '../utils/deduplication.js';
import { handleScraperError } from '../utils/error-handling.js';
import { generateScraperCacheKey } from '../utils/cache.js';
import * as SqliteCache from '../../util/cache-store.js';

// Keep a stable reference to env config for fallbacks when user config is partial
const ENV = config;

const inFlightRequests = new Map();

/**
 * Parse ilcorsaronero search results to get torrent links and metadata
 * @param {string} html - The HTML content to parse
 * @param {number} limit - Maximum number of results
 * @param {string} logPrefix - Logging prefix
 * @returns {Array} - Array of partial torrent results (need detail page for hash)
 */
function parseSearchResults(html, limit, logPrefix) {
    const $ = cheerio.load(html);
    const results = [];

    // Results are in table rows within tbody
    $('tbody tr').each((i, row) => {
        if (results.length >= limit) return false;

        try {
            const $row = $(row);

            // Get title and link
            const titleCell = $row.find('th a');
            if (!titleCell.length) return;

            const title = titleCell.text().trim();
            const href = titleCell.attr('href');
            if (!href || !href.startsWith('/torrent/')) return;

            // Get seeders (green text)
            const seedersText = $row.find('td.text-green-500').text().trim();
            const seeders = parseInt(seedersText.replace(/,/g, '')) || 0;

            // Get leechers (red text)
            const leechersText = $row.find('td.text-red-500').text().trim();
            const leechers = parseInt(leechersText.replace(/,/g, '')) || 0;

            // Get size - look for GiB/MiB/KiB pattern in td cells
            let size = 0;
            $row.find('td.tabular-nums').each((idx, td) => {
                const text = $(td).text().trim();
                const sizeMatch = text.match(/^[\d.,]+\s*(GiB|MiB|KiB|TiB|GB|MB|KB|TB)$/i);
                if (sizeMatch && size === 0) {
                    // Convert GiB to bytes (GiB = 1024^3)
                    const normalizedSize = text.replace('GiB', 'GB').replace('MiB', 'MB').replace('KiB', 'KB').replace('TiB', 'TB');
                    size = sizeToBytes(normalizedSize);
                }
            });

            // Get category
            const category = $row.find('td:first-child span').text().trim();

            results.push({
                Title: title,
                TorrentUrl: href,
                Size: size,
                Seeders: seeders,
                Leechers: leechers,
                Category: category,
                Tracker: 'IlCorsaroNero',
                Langs: ['italian'], // Italian torrent site
            });
        } catch (e) {
            // Skip individual parse errors
        }
    });

    return results;
}

/**
 * Fetch magnet link from a torrent detail page
 * @param {string} baseUrl - Base URL of the site
 * @param {string} torrentPath - Path to the torrent page
 * @param {number} timeout - Request timeout
 * @param {AbortSignal} signal - Abort signal
 * @returns {Promise<string|null>} - Info hash or null
 */
async function fetchMagnetFromDetailPage(baseUrl, torrentPath, timeout, signal) {
    try {
        const response = await axios.get(`${baseUrl}${torrentPath}`, {
            timeout,
            signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
            }
        });

        const $ = cheerio.load(response.data);

        // Look for magnet link
        const magnetLink = $('a[href^="magnet:"]').attr('href');
        if (magnetLink) {
            const hash = getHashFromMagnet(magnetLink);
            return { hash, magnet: magnetLink };
        }

        return null;
    } catch (error) {
        return null;
    }
}

/**
 * Search ilcorsaronero.link for torrents
 * @param {string} query - Search query
 * @param {AbortSignal} signal - Abort signal
 * @param {string} logPrefix - Logging prefix
 * @param {object} config - Configuration object
 * @returns {Promise<Array>} - Array of torrent results
 */
export async function searchIlCorsaroNero(query, signal, logPrefix, config) {
    const scraperName = 'IlCorsaroNero';
    const sfx = ':italian'; // Always Italian
    const timerLabel = createTimerLabel(logPrefix, scraperName, sfx);
    console.time(timerLabel);

    const cacheKey = generateScraperCacheKey(scraperName, query, config);
    const cachedResult = await SqliteCache.getCachedRecord('scraper', cacheKey);
    const cached = cachedResult?.data || null;

    if (cached && Array.isArray(cached)) {
        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${cached.length} results from cache.`);
        console.timeEnd(timerLabel);
        return cached;
    }

    const existingPromise = inFlightRequests.get(cacheKey);
    if (existingPromise) {
        console.log(`[${logPrefix} SCRAPER] ${scraperName} awaiting in-flight request for ${cacheKey}`);
        try {
            return await existingPromise;
        } finally {
            console.timeEnd(timerLabel);
        }
    }

    let isOwner = false;

    const scrapePromise = (async () => {
        const limit = config?.ILCORSARONERO_LIMIT ?? ENV.ILCORSARONERO_LIMIT ?? 25;
        const base = ((config?.ILCORSARONERO_URL || ENV.ILCORSARONERO_URL) || 'https://ilcorsaronero.link').replace(/\/$/, '');
        const timeout = config?.ILCORSARONERO_TIMEOUT ?? ENV.ILCORSARONERO_TIMEOUT ?? 15000;
        const detailConcurrency = config?.ILCORSARONERO_DETAIL_CONCURRENCY ?? ENV.ILCORSARONERO_DETAIL_CONCURRENCY ?? 5;

        // Check for abort signal
        if (signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
        }

        // Search for torrents
        const searchUrl = `${base}/search?q=${encodeURIComponent(query)}`;
        console.log(`[${logPrefix} SCRAPER] ${scraperName} searching: ${searchUrl}`);

        let searchResults = [];
        try {
            const response = await axios.get(searchUrl, {
                timeout,
                signal,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
                }
            });

            searchResults = parseSearchResults(response.data, limit, logPrefix);
            console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${searchResults.length} search results`);
        } catch (error) {
            if (error.name === 'AbortError' || axios.isCancel(error)) {
                throw error;
            }
            console.log(`[${logPrefix} SCRAPER] ${scraperName} search error: ${error.message}`);
            throw error;
        }

        if (searchResults.length === 0) {
            return [];
        }

        // Fetch magnet links from detail pages in batches
        const allResults = [];
        const seenHashes = new Set();

        // Process in batches for concurrency control
        for (let i = 0; i < searchResults.length; i += detailConcurrency) {
            if (signal?.aborted) break;

            const batch = searchResults.slice(i, i + detailConcurrency);
            const batchPromises = batch.map(async (result) => {
                const magnetInfo = await fetchMagnetFromDetailPage(base, result.TorrentUrl, timeout / 2, signal);
                if (magnetInfo && magnetInfo.hash && !seenHashes.has(magnetInfo.hash)) {
                    seenHashes.add(magnetInfo.hash);
                    return {
                        Title: result.Title,
                        InfoHash: magnetInfo.hash,
                        Size: result.Size,
                        Seeders: result.Seeders,
                        Leechers: result.Leechers,
                        Tracker: result.Tracker,
                        Langs: result.Langs,
                        Magnet: magnetInfo.magnet
                    };
                }
                return null;
            });

            const batchResults = await Promise.all(batchPromises);
            for (const result of batchResults) {
                if (result) {
                    allResults.push(result);
                }
            }
        }

        console.log(`[${logPrefix} SCRAPER] ${scraperName} fetched ${allResults.length} torrents with magnets`);

        if (allResults.length > 0) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} Sample results:`);
            allResults.slice(0, 3).forEach((r, i) => {
                console.log(`  ${i+1}. ${r.Title}`);
                console.log(`     Hash: ${r.InfoHash}, Size: ${(r.Size / (1024**3)).toFixed(2)} GB, Seeders: ${r.Seeders}`);
            });
        }

        // Process results (don't filter by language since these are all Italian)
        const processedResults = processAndDeduplicate(allResults, { ...config, Languages: [] });

        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${processedResults.length} results after processing.`);

        return processedResults;
    })();

    inFlightRequests.set(cacheKey, scrapePromise);
    isOwner = true;

    try {
        const processedResults = await scrapePromise;

        if (isOwner && processedResults.length > 0) {
            try {
                const saved = await SqliteCache.upsertCachedMagnet({
                    service: 'scraper',
                    hash: cacheKey,
                    data: processedResults
                });
                if (saved) {
                    console.log(`[${logPrefix} SCRAPER] ${scraperName} saved ${processedResults.length} results to cache`);
                }
            } catch (cacheError) {
                console.warn(`[${logPrefix} SCRAPER] ${scraperName} failed to save to cache: ${cacheError.message}`);
            }
        }

        return processedResults;
    } catch (error) {
        handleScraperError(error, scraperName, logPrefix);
        return [];
    } finally {
        if (isOwner) {
            inFlightRequests.delete(cacheKey);
        }
        console.timeEnd(timerLabel);
    }
}
