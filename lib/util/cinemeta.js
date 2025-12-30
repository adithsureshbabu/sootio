// lib/util/cinemeta.js
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';

// In-memory cache for Cinemeta results (avoids redundant fetches within same request)
const metaCache = new Map();
const metaFetchInFlight = new Map(); // Deduplicates concurrent requests for same IMDB ID
const altTitleFetchInFlight = new Map();
const altTitleLogCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CINEMETA_TIMEOUT_MS = parseInt(process.env.CINEMETA_TIMEOUT_MS || '6000', 10);
const CINEMETA_SLOW_THRESHOLD_MS = parseInt(process.env.CINEMETA_SLOW_THRESHOLD_MS || '3000', 10);
const IMDB_ALT_TIMEOUT_MS = parseInt(process.env.IMDB_ALT_TIMEOUT_MS || '8000', 10);
const IMDB_ALT_SLOW_THRESHOLD_MS = parseInt(process.env.IMDB_ALT_SLOW_THRESHOLD_MS || '4000', 10);
const CINEMETA_LOG_ALT_TITLES = process.env.CINEMETA_LOG_ALT_TITLES === 'true';
const CINEMETA_ALT_LOG_TTL_MS = parseInt(process.env.CINEMETA_ALT_LOG_TTL_MS || '600000', 10);

function shouldLogAltTitles(imdbId) {
    if (!CINEMETA_LOG_ALT_TITLES) return false;
    const now = Date.now();
    const last = altTitleLogCache.get(imdbId);
    if (last && (now - last) < CINEMETA_ALT_LOG_TTL_MS) {
        return false;
    }
    altTitleLogCache.set(imdbId, now);
    return true;
}

// Manual metadata overrides for cases where Cinemeta has incorrect data
const METADATA_OVERRIDES = {
    'tt15416342': {
        name: 'The Bengal Files',
        year: '2025',
        imdb_id: 'tt15416342'
    }
    // Removed Thamma manual override to test automatic IMDB title fetching
    // 'tt28102562': {
    //     name: 'Thamma',
    //     original_title: 'Vampires of Vijay Nagar',
    //     alternativeTitles: ['Thamma', 'Vampires of Vijay Nagar'],
    //     year: '2025',
    //     imdb_id: 'tt28102562'
    // }
};

/**
 * Fetches alternative titles (AKAs) from IMDB
 * @param {string} imdbId - IMDB ID (e.g., 'tt28102562')
 * @returns {Promise<string[]>} Array of alternative titles
 */
async function fetchImdbAlternativeTitles(imdbId) {
    try {
        console.log(`[Cinemeta] Fetching IMDB alternative titles for ${imdbId}`);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), IMDB_ALT_TIMEOUT_MS);
        const startTime = Date.now();

        const response = await fetch(`https://www.imdb.com/title/${imdbId}/`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept-Language': 'en-US,en;q=0.9'
            },
            signal: controller.signal
        }).finally(() => clearTimeout(timeoutId));

        const duration = Date.now() - startTime;
        if (duration >= IMDB_ALT_SLOW_THRESHOLD_MS) {
            console.error(`[Cinemeta] IMDB alternative titles slow (${duration}ms) for ${imdbId}`);
        }

        if (!response.ok) {
            console.log(`[Cinemeta] IMDB fetch failed with status ${response.status}`);
            return [];
        }

        const html = await response.text();
        const $ = cheerio.load(html);

        const titles = new Set();

        // Get the main title
        const mainTitle = $('h1[data-testid="hero__pageTitle"] span').first().text().trim();
        if (mainTitle) titles.add(mainTitle);

        // Get original title if different
        const originalTitle = $('div[data-testid="hero__pageTitle"] ul li:contains("Original title:")').text().replace('Original title:', '').trim();
        if (originalTitle) titles.add(originalTitle);

        // Try to get AKA titles from the page
        const akaSection = $('li[data-testid="title-details-akas"]');
        if (akaSection.length > 0) {
            // The AKAs might be in a link or button
            const akaText = akaSection.find('a, button, span').text();
            if (akaText && !akaText.includes('See more')) {
                // Clean up common prefixes
                const cleanedText = akaText
                    .replace(/Also known as\s*/gi, '')
                    .replace(/AKA\s*/gi, '');
                // Parse individual AKAs if they're listed
                const akas = cleanedText.split(/[,;]/).map(t => t.trim()).filter(t => t.length > 0);
                akas.forEach(aka => titles.add(aka));
            }
        }

        const result = Array.from(titles).filter(t => t.length > 0 && t.length < 100);
        if (shouldLogAltTitles(imdbId)) {
            console.debug(`[Cinemeta] Found ${result.length} alternative titles from IMDB:`, result);
        }
        return result;
    } catch (err) {
        if (err.name === 'AbortError') {
            console.error(`[Cinemeta] IMDB alternative titles timeout after ${IMDB_ALT_TIMEOUT_MS}ms for ${imdbId}`);
        } else {
            console.error(`[Cinemeta] Error fetching IMDB alternative titles:`, err.message);
        }
        return [];
    }
}

async function getMeta(type, imdbId) {
    // Check for manual override first
    if (METADATA_OVERRIDES[imdbId]) {
        console.log(`[Cinemeta] Using manual override for ${imdbId}: ${METADATA_OVERRIDES[imdbId].name} (${METADATA_OVERRIDES[imdbId].year})`);
        return METADATA_OVERRIDES[imdbId];
    }

    // Check in-memory cache first (avoids redundant fetches for same request)
    const cacheKey = `${type}:${imdbId}`;
    const cached = metaCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL_MS)) {
        console.log(`[Cinemeta] Cache HIT for ${imdbId}: ${cached.data?.name || 'null'}`);
        return cached.data;
    }

    // Check if there's already an in-flight request for this IMDB ID (request coalescing)
    // This prevents multiple concurrent requests from hitting Cinemeta simultaneously
    if (metaFetchInFlight.has(cacheKey)) {
        console.log(`[Cinemeta] Coalescing request for ${imdbId} (already in-flight)`);
        return metaFetchInFlight.get(cacheKey);
    }

    // Create the fetch promise and store it for coalescing
    const fetchPromise = (async () => {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), CINEMETA_TIMEOUT_MS);
            const startTime = Date.now();

            const response = await fetch(`https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`, {
                signal: controller.signal
            }).finally(() => clearTimeout(timeoutId));

            const duration = Date.now() - startTime;
            if (duration >= CINEMETA_SLOW_THRESHOLD_MS) {
                console.error(`[Cinemeta] Slow metadata response (${duration}ms) for ${type}:${imdbId}`);
            }

            // Check if the request was successful
            if (!response.ok) {
                console.error(`[Cinemeta] Received a ${response.status} response for ${type}:${imdbId}`);
                return null;
            }

            const body = await response.json();
            const meta = body && body.meta;

            // Cache the basic result immediately for fast response
            metaCache.set(cacheKey, { data: meta, timestamp: Date.now() });

            // Fetch alternative titles from IMDB in BACKGROUND (non-blocking)
            // This improves performance by ~1-2 seconds on first request
            if (meta && process.env.ENABLE_IMDB_ALTERNATIVE_TITLES !== 'false') {
                if (!altTitleFetchInFlight.has(imdbId)) {
                    const altFetchPromise = fetchImdbAlternativeTitles(imdbId)
                        .then(altTitles => {
                            if (altTitles.length > 0) {
                                meta.alternativeTitles = altTitles;
                                // Update cache with alternative titles
                                metaCache.set(cacheKey, { data: meta, timestamp: Date.now() });
                                if (shouldLogAltTitles(imdbId)) {
                                    console.debug(`[Cinemeta] Background: added ${altTitles.length} alternative titles to cache for ${imdbId}`);
                                }
                            }
                        })
                        .catch(() => {
                            if (shouldLogAltTitles(imdbId)) {
                                console.debug(`[Cinemeta] Background: failed to fetch alternative titles for ${imdbId}`);
                            }
                        })
                        .finally(() => {
                            altTitleFetchInFlight.delete(imdbId);
                        });

                    altTitleFetchInFlight.set(imdbId, altFetchPromise);
                }
            }

            return meta;

        } catch (err) {
            if (err.name === 'AbortError') {
                console.error(`[Cinemeta] Metadata timeout after ${CINEMETA_TIMEOUT_MS}ms for ${type}:${imdbId}`);
            } else {
                console.error(`[Cinemeta] A network or parsing error occurred:`, err);
            }
            return null;
        }
    })();

    // Store the in-flight promise for coalescing
    metaFetchInFlight.set(cacheKey, fetchPromise);

    // Clean up in-flight tracker when done
    fetchPromise.finally(() => {
        metaFetchInFlight.delete(cacheKey);
    });

    return fetchPromise;
}

export default { getMeta };
