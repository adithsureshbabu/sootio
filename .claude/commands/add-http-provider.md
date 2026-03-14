Add a new HTTP streaming provider to the Sootio addon.

Arguments: $ARGUMENTS
Format: `<provider-name>`
Example: `hdtoday`

The provider name should be lowercase (e.g. `hdtoday`). The exported function will be `get<Name>Streams` (e.g. `getHdTodayStreams`).

## Instructions

### Step 1 — Read reference implementations

Read both of these files before writing any code:
- `lib/http-streams/providers/mkvcinemas/streams.js` — full provider pattern with Cinemeta, search, preview streams
- `lib/http-streams/providers/mkvcinemas/search.js` — search + content loading with in-memory cache

Also read `lib/http-streams/utils/parsing.js` to understand available utilities:
`removeYear`, `generateAlternativeQueries`, `getSortedMatches`, `getResolutionFromName`, `calculateSimilarity`

And read `lib/http-streams/utils/preview-mode.js`:
`createPreviewStream`, `formatPreviewStreams`, `isLazyLoadEnabled`

### Step 2 — Create the provider directory and files

Create directory `lib/http-streams/providers/<name>/` with two files:

#### `lib/http-streams/providers/<name>/search.js`

```javascript
/**
 * <Name> Search Module
 * Scrapes <Name> for movie/series download pages.
 */

import * as cheerio from 'cheerio';
import { makeRequest } from '../../utils/http.js';
import { cleanTitle } from '../../utils/parsing.js';

const BASE_URL = process.env.<NAME>_BASE_URL || 'https://<name>.to';
const SEARCH_CACHE_TTL = 15 * 60 * 1000; // 15 minutes

const searchCache = new Map();

/**
 * Search <Name> for a title query.
 * @param {string} query - Search query string
 * @param {AbortSignal} [signal] - Optional abort signal
 * @returns {Promise<Array<{title: string, url: string, year?: number}>>}
 */
export async function scrape<Name>Search(query, signal) {
    const cacheKey = query.toLowerCase().trim();
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < SEARCH_CACHE_TTL) {
        return cached.data;
    }

    try {
        const searchUrl = `${BASE_URL}/?s=${encodeURIComponent(query)}`;
        const response = await makeRequest(searchUrl, { signal, parseHTML: true });
        if (!response?.document) return [];

        const $ = response.document;
        const results = [];

        // TODO: update selector to match the site's search results markup
        $('article.post, .search-result, .item').each((_, el) => {
            const title = $(el).find('h2, h3, .title').first().text().trim();
            const url = $(el).find('a').first().attr('href');
            const yearMatch = title.match(/\b(19|20)\d{2}\b/);
            if (title && url) {
                results.push({
                    title: cleanTitle(title),
                    url,
                    year: yearMatch ? parseInt(yearMatch[0], 10) : null
                });
            }
        });

        searchCache.set(cacheKey, { data: results, ts: Date.now() });
        return results;

    } catch (error) {
        console.error(`[<Name>] Search failed for "${query}": ${error.message}`);
        return [];
    }
}

/**
 * Load the full content/download page for a given URL.
 * @param {string} url - Post URL from search results
 * @param {AbortSignal} [signal]
 * @returns {Promise<{title: string, downloadLinks: string[], languages: string[]}>}
 */
export async function load<Name>Content(url, signal) {
    try {
        const response = await makeRequest(url, { signal, parseHTML: true });
        if (!response?.document) return { title: '', downloadLinks: [], languages: [] };

        const $ = response.document;
        const title = $('h1, .post-title').first().text().trim();
        const downloadLinks = [];

        // TODO: update selector to match the site's download link markup
        $('a[href]').each((_, a) => {
            const href = $(a).attr('href') || '';
            const text = $(a).text().toLowerCase();
            if (/download|stream|watch/i.test(text) || /\.(mp4|mkv)/.test(href)) {
                if (!downloadLinks.includes(href)) downloadLinks.push(href);
            }
        });

        return { title, downloadLinks, languages: [] };

    } catch (error) {
        console.error(`[<Name>] Content load failed for ${url}: ${error.message}`);
        return { title: '', downloadLinks: [], languages: [] };
    }
}
```

#### `lib/http-streams/providers/<name>/streams.js`

```javascript
/**
 * <Name> Streams Module
 * Builds Stremio HTTP streams from <Name>.
 */

import Cinemeta from '../../../util/cinemeta.js';
import { scrape<Name>Search, load<Name>Content } from './search.js';
import {
    removeYear,
    generateAlternativeQueries,
    getSortedMatches
} from '../../utils/parsing.js';
import { createPreviewStream, formatPreviewStreams } from '../../utils/preview-mode.js';
import { encodeUrlForStreaming } from '../../utils/encoding.js';
import { renderLanguageFlags, detectLanguagesFromTitle } from '../../../util/language-mapping.js';

const PROVIDER = '<Name>';

/**
 * Get streams from <Name> for a given content ID.
 * @param {string} tmdbId - IMDB or TMDB ID (e.g. "tt1375666")
 * @param {'movie'|'series'} type
 * @param {number|null} season
 * @param {number|null} episode
 * @param {object} config - User config object
 * @param {object|null} prefetchedMeta - Pre-fetched Cinemeta metadata (pass to avoid duplicate API calls)
 * @returns {Promise<Array>} Array of Stremio stream objects
 */
export async function get<Name>Streams(tmdbId, type, season = null, episode = null, config = {}, prefetchedMeta = null) {
    try {
        // Use pre-fetched metadata if provided (avoids redundant Cinemeta calls)
        let meta = prefetchedMeta;
        if (!meta) {
            console.log(`[${PROVIDER}] Fetching metadata for ${tmdbId}...`);
            meta = await Cinemeta.getMeta(type, tmdbId);
        }

        if (!meta?.name) {
            console.log(`[${PROVIDER}] No metadata for ${tmdbId}, skipping`);
            return [];
        }

        // Build search queries (primary + alternatives to improve match rate)
        const queries = Array.from(new Set([
            meta.name,
            removeYear(meta.name),
            ...generateAlternativeQueries(meta.name, meta.original_title || '')
        ])).filter(Boolean);

        console.log(`[${PROVIDER}] Searching for "${meta.name}" (${type}${season != null ? ` S${season}E${episode}` : ''})`);

        // Try queries in order, stop on first hit
        let searchResults = [];
        for (const query of queries) {
            const results = await scrape<Name>Search(query);
            if (results.length > 0) {
                searchResults = results;
                break;
            }
        }

        if (searchResults.length === 0) {
            console.log(`[${PROVIDER}] No search results for "${meta.name}"`);
            return [];
        }

        // Pick the best match by title similarity
        const sorted = getSortedMatches(searchResults, meta.name);
        const bestMatch = sorted[0];
        if (!bestMatch?.url) {
            console.log(`[${PROVIDER}] No suitable match found`);
            return [];
        }

        console.log(`[${PROVIDER}] Best match: "${bestMatch.title}" → ${bestMatch.url}`);

        // Load the download/stream links from the content page
        const content = await load<Name>Content(bestMatch.url);
        if (!content.downloadLinks?.length) {
            console.log(`[${PROVIDER}] No download links found`);
            return [];
        }

        const languages = content.languages?.length
            ? content.languages
            : detectLanguagesFromTitle(content.title || meta.name);

        // Build preview streams for each download link
        const previews = content.downloadLinks.map(url =>
            createPreviewStream({
                url,
                label: content.title || meta.name,
                provider: PROVIDER,
                size: null,
                languages
            })
        ).filter(Boolean);

        const formatted = formatPreviewStreams(previews, encodeUrlForStreaming, renderLanguageFlags)
            .map(stream => ({
                ...stream,
                behaviorHints: { ...stream.behaviorHints, bingeGroup: '<name>-streams' }
            }));

        console.log(`[${PROVIDER}] Returning ${formatted.length} stream(s)`);
        return formatted;

    } catch (error) {
        console.error(`[${PROVIDER}] Error: ${error.message}`);
        return [];
    }
}
```

Replace all `<name>` and `<Name>` placeholders with the actual provider name (lowercase and PascalCase respectively).

### Step 3 — Register exports in index

Read `lib/http-streams/index.js`, then add at the end of the provider exports section:

```javascript
// Provider exports - <Name>
export { get<Name>Streams } from './providers/<name>/streams.js';
export { scrape<Name>Search, load<Name>Content } from './providers/<name>/search.js';
```

### Step 4 — Register in stream-provider.js

Read `lib/stream-provider.js` and search for the HTTP streaming section (search for `getHttpStreamingStreams` or `4KHDHub` to find the right place). Add the new provider following the exact same pattern as the existing ones (typically a `withTimeout` wrapped call, guarded by a config flag).

### Step 5 — Add env vars to .env.example

Read `.env.example` and append to the HTTP streaming providers section:

```
# <Name>
<NAME>_ENABLED=false
<NAME>_BASE_URL=https://<name>.to
<NAME>_TIMEOUT=15000
```

### Step 6 — Summary

Report:
- Files created: `lib/http-streams/providers/<name>/search.js`, `streams.js`
- Exports added to: `lib/http-streams/index.js`
- Integration added to: `lib/stream-provider.js`
- Env vars added to: `.env.example`
- Remind the user to update the CSS selectors and URL patterns in `search.js` (marked with `TODO`) to match the actual site's HTML structure
