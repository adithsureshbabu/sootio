import axios from 'axios';
import * as config from '../../config.js';
import debridProxyManager from '../../util/debrid-proxy.js';

// Import scraper utilities
import { createTimerLabel } from '../utils/timing.js';
import { detectSimpleLangs } from '../utils/filtering.js';
import { processAndDeduplicate } from '../utils/deduplication.js';
import { handleScraperError } from '../utils/error-handling.js';

// Keep a stable reference to env config for fallbacks when user config is partial
const ENV = config;

// Standard trackers for magnet links
const TRACKERS = [
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://open.stealth.si:80/announce',
    'udp://tracker.torrent.eu.org:451/announce',
    'udp://tracker.bittor.pw:1337/announce',
    'udp://public.popcorn-tracker.org:6969/announce',
    'udp://tracker.dler.org:6969/announce',
    'udp://exodus.desync.com:6969',
    'udp://open.demonii.com:1337/announce'
];

/**
 * Build a magnet link from info hash and name
 */
function buildMagnetLink(infoHash, name) {
    const encodedName = encodeURIComponent(name);
    const trackerParams = TRACKERS.map(t => `&tr=${encodeURIComponent(t)}`).join('');
    return `magnet:?xt=urn:btih:${infoHash}&dn=${encodedName}${trackerParams}`;
}

// Create axios instance with proxy support for this scraper (falls back to scrapers default)
const axiosWithProxy = axios.create(debridProxyManager.getScraperAxiosConfig('thepiratebay'));

/**
 * Search The Pirate Bay using the apibay.org API
 * @param {string} query - Search query
 * @param {AbortSignal} signal - Abort signal
 * @param {string} logPrefix - Logging prefix
 * @param {object} config - Configuration object
 * @returns {Promise<Array>} - Array of torrent results
 */
export async function searchThePirateBay(query, signal, logPrefix, config) {
    const scraperName = 'ThePirateBay';
    const sfx = (config?.Languages && config.Languages.length) ? `:${config.Languages[0]}` : ':none';
    const timerLabel = createTimerLabel(logPrefix, scraperName, sfx);
    console.time(timerLabel);

    try {
        const limit = config?.THEPIRATEBAY_LIMIT ?? ENV.THEPIRATEBAY_LIMIT ?? 100;
        const base = ((config?.THEPIRATEBAY_URL || ENV.THEPIRATEBAY_URL) || 'https://apibay.org').replace(/\/$/, '');
        const timeout = config?.SCRAPER_TIMEOUT ?? ENV.SCRAPER_TIMEOUT;

        // Build search URL - cat=0 means all categories (200 = movies, 500 = video)
        const searchUrl = `${base}/q.php?q=${encodeURIComponent(query)}&cat=0`;

        console.log(`[${logPrefix} SCRAPER] ${scraperName} searching: ${searchUrl}`);

        const response = await axiosWithProxy.get(searchUrl, {
            timeout,
            signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'en-US,en;q=0.9',
            }
        });

        const data = response.data;

        // Check if response is valid
        if (!Array.isArray(data)) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} invalid response format`);
            return [];
        }

        // Filter out invalid entries (info_hash of all zeros means no results)
        const INVALID_HASH = '0000000000000000000000000000000000000000';
        const validResults = data.filter(item => item.info_hash && item.info_hash !== INVALID_HASH);

        if (validResults.length === 0) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} no valid results found`);
            return [];
        }

        const results = [];
        const seen = new Set();

        for (const item of validResults) {
            if (results.length >= limit) break;

            const infoHash = item.info_hash.toLowerCase();

            // Skip duplicates
            if (seen.has(infoHash)) continue;
            seen.add(infoHash);

            const title = item.name || 'Unknown Title';
            const seeders = parseInt(item.seeders) || 0;
            const leechers = parseInt(item.leechers) || 0;
            const size = parseInt(item.size) || 0;

            results.push({
                Title: title,
                InfoHash: infoHash,
                Size: size,
                Seeders: seeders,
                Leechers: leechers,
                Tracker: scraperName,
                Langs: detectSimpleLangs(title),
                Magnet: buildMagnetLink(infoHash, title)
            });
        }

        console.log(`[${logPrefix} SCRAPER] ${scraperName} raw results before processing: ${results.length}`);
        if (results.length > 0) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} Sample raw results:`);
            results.slice(0, 3).forEach((r, i) => {
                console.log(`  ${i+1}. ${r.Title}`);
                console.log(`     Hash: ${r.InfoHash}, Size: ${(r.Size / (1024**3)).toFixed(2)} GB, Seeders: ${r.Seeders}, Langs: [${r.Langs.join(', ')}]`);
            });
        }

        const processedResults = processAndDeduplicate(results, config);

        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${processedResults.length} results after processing (filtered from ${results.length}).`);
        if (processedResults.length > 0) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} Sample processed results:`);
            processedResults.slice(0, 3).forEach((r, i) => {
                console.log(`  ${i+1}. ${r.Title}`);
                console.log(`     Hash: ${r.InfoHash}, Size: ${(r.Size / (1024**3)).toFixed(2)} GB, Seeders: ${r.Seeders}, Langs: [${r.Langs.join(', ')}]`);
            });
        }

        return processedResults;
    } catch (error) {
        handleScraperError(error, scraperName, logPrefix);
        return [];
    } finally {
        console.timeEnd(timerLabel);
    }
}
