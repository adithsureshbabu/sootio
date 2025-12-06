// lib/util/cinemeta.js
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';

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
        const response = await fetch(`https://www.imdb.com/title/${imdbId}/`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept-Language': 'en-US,en;q=0.9'
            }
        });

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
        console.log(`[Cinemeta] Found ${result.length} alternative titles from IMDB:`, result);
        return result;
    } catch (err) {
        console.error(`[Cinemeta] Error fetching IMDB alternative titles:`, err.message);
        return [];
    }
}

async function getMeta(type, imdbId) {
    try {
        // Check for manual override first
        if (METADATA_OVERRIDES[imdbId]) {
            console.log(`[Cinemeta] Using manual override for ${imdbId}: ${METADATA_OVERRIDES[imdbId].name} (${METADATA_OVERRIDES[imdbId].year})`);
            return METADATA_OVERRIDES[imdbId];
        }

        const response = await fetch(`https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`);

        // Check if the request was successful
        if (!response.ok) {
            console.error(`[Cinemeta] Received a ${response.status} response for ${type}:${imdbId}`);
            // Return null or a fallback object if meta is not found
            return null;
        }

        const body = await response.json();
        const meta = body && body.meta;

        // Fetch alternative titles from IMDB for better regional title matching
        // Only for movies/series that might have regional variations
        if (meta && process.env.ENABLE_IMDB_ALTERNATIVE_TITLES !== 'false') {
            try {
                const altTitles = await fetchImdbAlternativeTitles(imdbId);
                if (altTitles.length > 0) {
                    meta.alternativeTitles = altTitles;
                }
            } catch (err) {
                console.log(`[Cinemeta] Failed to fetch alternative titles, continuing without them`);
            }
        }

        return meta;

    } catch (err) {
        console.error(`[Cinemeta] A network or parsing error occurred:`, err);
        // Throwing an error here is okay, but we can also return null
        return null;
    }
}

export default { getMeta };
