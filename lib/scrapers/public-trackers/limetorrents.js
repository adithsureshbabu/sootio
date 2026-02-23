import axios from 'axios';
import * as cheerio from 'cheerio';
import * as config from '../../config.js';
import { sizeToBytes } from '../../common/torrent-utils.js';
import debridProxyManager from '../../util/debrid-proxy.js';

// Import scraper utilities
import { createTimerLabel } from '../utils/timing.js';
import { detectSimpleLangs } from '../utils/filtering.js';
import { processAndDeduplicate } from '../utils/deduplication.js';
import { handleScraperError } from '../utils/error-handling.js';
import { generateScraperCacheKey } from '../utils/cache.js';
import * as SqliteCache from '../../util/cache-store.js';

// Keep a stable reference to env config for fallbacks when user config is partial
const ENV = config;

// Create axios instance with proxy support
const axiosWithProxy = axios.create(debridProxyManager.getScraperAxiosConfig('limetorrents'));

const inFlightRequests = new Map();

/**
 * Parse LimeTorrents search results HTML
 * HTML structure:
 *   <tr bgcolor="#...">
 *     <td class="tdleft">
 *       <div class="tt-name">
 *         <a href="http://itorrents.net/torrent/{HASH}.torrent?title=..." class="csprite_dl14"></a>
 *         <a href="/Title-torrent-123.html">Title Text</a>
 *       </div>
 *     </td>
 *     <td class="tdnormal">Date - in Category</td>
 *     <td class="tdnormal">Size</td>
 *     <td class="tdseed">Seeders</td>
 *     <td class="tdleech">Leechers</td>
 *   </tr>
 */
function parseLimeTorrentsResults(html, limit, logPrefix) {
    const $ = cheerio.load(html);
    const results = [];
    const seen = new Set();

    $('table tr').each((i, row) => {
        if (results.length >= limit) return false;

        const $row = $(row);
        const titleCell = $row.find('td.tdleft');
        if (!titleCell.length) return;

        const ttName = titleCell.find('div.tt-name');
        if (!ttName.length) return;

        // Hash is in the torrent download link: http://itorrents.net/torrent/{HASH}.torrent
        const torrentLink = ttName.find('a.csprite_dl14');
        if (!torrentLink.length) return;

        const torrentHref = torrentLink.attr('href') || '';
        const hashMatch = torrentHref.match(/\/torrent\/([A-Fa-f0-9]{40})\.torrent/i);
        if (!hashMatch) return;

        const infoHash = hashMatch[1].toLowerCase();
        if (seen.has(infoHash)) return;
        seen.add(infoHash);

        // Title is from the second anchor (the detail page link)
        const titleLink = ttName.find('a').not('.csprite_dl14').first();
        const title = titleLink.text().trim();
        if (!title) return;

        let size = 0;
        let seeders = 0;
        let leechers = 0;
        let tdNormalCount = 0;

        $row.find('td').each((_, cell) => {
            const $cell = $(cell);
            const text = $cell.text().trim();

            if ($cell.hasClass('tdseed')) {
                seeders = parseInt(text.replace(/,/g, ''), 10) || 0;
            } else if ($cell.hasClass('tdleech')) {
                leechers = parseInt(text.replace(/,/g, ''), 10) || 0;
            } else if ($cell.hasClass('tdnormal')) {
                tdNormalCount++;
                // First tdnormal = date/category, second tdnormal = size
                if (tdNormalCount === 2) {
                    size = sizeToBytes(text);
                }
            }
        });

        results.push({
            Title: title,
            InfoHash: infoHash,
            Size: size,
            Seeders: seeders,
            Leechers: leechers,
            Tracker: 'LimeTorrents',
            Langs: detectSimpleLangs(title),
            Magnet: `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(title)}`
        });
    });

    return results;
}

/**
 * Search limetorrents.fun for torrents
 * @param {string} query - Search query
 * @param {AbortSignal} signal - Abort signal
 * @param {string} logPrefix - Logging prefix
 * @param {object} userConfig - Configuration object
 * @returns {Promise<Array>} - Array of torrent results
 */
export async function searchLimeTorrents(query, signal, userConfig, logPrefix) {
    const scraperName = 'LimeTorrents';
    const sfx = (userConfig?.Languages && userConfig.Languages.length) ? `:${userConfig.Languages[0]}` : ':none';
    const timerLabel = createTimerLabel(logPrefix, scraperName, sfx);
    console.time(timerLabel);

    const cacheKey = generateScraperCacheKey(scraperName, query, userConfig);
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
        const limit = userConfig?.LIMETORRENTS_LIMIT ?? ENV.LIMETORRENTS_LIMIT ?? 100;
        const maxPages = userConfig?.LIMETORRENTS_MAX_PAGES ?? ENV.LIMETORRENTS_MAX_PAGES ?? 3;
        const base = (userConfig?.LIMETORRENTS_URL || ENV.LIMETORRENTS_URL || 'https://www.limetorrents.fun').replace(/\/$/, '');
        const timeout = userConfig?.LIMETORRENTS_TIMEOUT ?? ENV.LIMETORRENTS_TIMEOUT ?? (userConfig?.SCRAPER_TIMEOUT ?? ENV.SCRAPER_TIMEOUT ?? 10000);

        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

        const allResults = [];
        const seenHashes = new Set();

        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
        };

        for (let page = 1; page <= maxPages; page++) {
            if (signal?.aborted) break;
            if (allResults.length >= limit) break;

            const searchUrl = `${base}/search/all/${encodeURIComponent(query)}/${page}/`;
            console.log(`[${logPrefix} SCRAPER] ${scraperName} fetching page ${page}: ${searchUrl}`);

            try {
                const response = await axiosWithProxy.get(searchUrl, { timeout, signal, headers });
                const html = response.data;

                if (!html || typeof html !== 'string') {
                    console.log(`[${logPrefix} SCRAPER] ${scraperName} page ${page} returned empty response`);
                    break;
                }

                const pageResults = parseLimeTorrentsResults(html, limit, logPrefix);
                console.log(`[${logPrefix} SCRAPER] ${scraperName} page ${page} returned ${pageResults.length} results`);

                for (const result of pageResults) {
                    if (allResults.length >= limit) break;
                    if (!seenHashes.has(result.InfoHash)) {
                        seenHashes.add(result.InfoHash);
                        allResults.push(result);
                    }
                }

                // LimeTorrents shows ~30 results per page; stop if last page wasn't full
                if (pageResults.length < 25) {
                    break;
                }
            } catch (error) {
                if (error.name === 'AbortError' || axios.isCancel(error)) throw error;
                console.log(`[${logPrefix} SCRAPER] ${scraperName} page ${page} error: ${error.message}`);
                if (page === 1) throw error;
                break;
            }
        }

        console.log(`[${logPrefix} SCRAPER] ${scraperName} raw results before processing: ${allResults.length}`);
        if (allResults.length > 0) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} Sample raw results:`);
            allResults.slice(0, 3).forEach((r, i) => {
                console.log(`  ${i + 1}. ${r.Title}`);
                console.log(`     Hash: ${r.InfoHash}, Size: ${(r.Size / (1024 ** 3)).toFixed(2)} GB, Seeders: ${r.Seeders}, Langs: [${r.Langs.join(', ')}]`);
            });
        }

        const processedResults = processAndDeduplicate(allResults, userConfig);
        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${processedResults.length} results after processing (filtered from ${allResults.length}).`);

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
        if (isOwner) inFlightRequests.delete(cacheKey);
        console.timeEnd(timerLabel);
    }
}
