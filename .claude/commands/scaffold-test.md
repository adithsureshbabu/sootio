Generate a Jest test file skeleton for a new torrent scraper or HTTP streaming provider.

Arguments: $ARGUMENTS
Format: `<name> <type>`
Types: `scraper` | `http-provider`
Examples:
  `yts scraper`
  `hdtoday http-provider`
  `knaben scraper`

## Instructions

### Step 1 — Read reference test files

For `scraper` type: read `tests/cinemeta.test.js` to understand the simplest test structure used in this project.

For `http-provider` type: read `tests/xdmovies.test.js` (first 80 lines) and `tests/mkvdrama.test.js` (first 80 lines) to understand the HTTP provider test pattern.

### Step 2 — Read the target module

Read the actual module being tested:
- For `scraper`: read `lib/scrapers/**/<name>.js` (use Glob to find it) — note the export function name and required config vars
- For `http-provider`: read `lib/http-streams/providers/<name>/streams.js` and `search.js` — note the export functions and required config vars

### Step 3 — Create the test file

Create `tests/<name>.test.js` with the following structure:

#### For `scraper` type:

```javascript
/**
 * Tests for <Name> scraper
 *
 * These are integration tests that hit the live <Name> API.
 * They are skipped by default to avoid breaking CI.
 * To run: npm test -- tests/<name>.test.js
 *
 * Required env vars:
 *   <NAME>_ENABLED=true
 *   <NAME>_URL=<url>   (if applicable)
 */

import { describe, test, expect, beforeAll } from '@jest/globals';
import dotenv from 'dotenv';
dotenv.config();

import { search<Name> } from '../lib/scrapers/<category>/<name>.js';

const SKIP_REASON = 'Integration test — requires live <Name> API';
const TEST_QUERY_MOVIE = 'Inception 2010';
const TEST_QUERY_SERIES = 'Breaking Bad';

// Skip entire suite if not explicitly enabled
const isEnabled = process.env.<NAME>_ENABLED === 'true';

describe('<Name> scraper', () => {
    beforeAll(() => {
        if (!isEnabled) {
            console.log(`Skipping <Name> tests: <NAME>_ENABLED is not true`);
        }
    });

    test.skip('searches for a movie and returns results', async () => {
        const results = await search<Name>(
            TEST_QUERY_MOVIE,
            AbortSignal.timeout(15000),
            'TEST',
            process.env
        );

        expect(Array.isArray(results)).toBe(true);
        expect(results.length).toBeGreaterThan(0);

        // Validate result shape
        const first = results[0];
        expect(first).toHaveProperty('Title');
        expect(first).toHaveProperty('InfoHash');
        expect(first).toHaveProperty('Seeders');
        expect(first).toHaveProperty('Size');
        expect(first).toHaveProperty('Tracker');

        // Validate data quality
        expect(typeof first.Title).toBe('string');
        expect(first.Title.length).toBeGreaterThan(0);
        expect(first.InfoHash).toMatch(/^[a-f0-9]{40}$/i);
        expect(typeof first.Seeders).toBe('number');

        console.log(`Found ${results.length} results, top: ${first.Title}`);
    }, 20000);

    test.skip('searches for a TV series and returns results', async () => {
        const results = await search<Name>(
            TEST_QUERY_SERIES,
            AbortSignal.timeout(15000),
            'TEST',
            process.env
        );

        expect(Array.isArray(results)).toBe(true);
        console.log(`Found ${results.length} series results`);
    }, 20000);

    test.skip('returns empty array on invalid query', async () => {
        const results = await search<Name>(
            'xxxxxxxxxxxxxxxxxxxxxxxxxxx_no_results_expected',
            AbortSignal.timeout(15000),
            'TEST',
            process.env
        );

        expect(Array.isArray(results)).toBe(true);
        // Should not throw, should return empty array
    }, 20000);

    test.skip('handles abort signal gracefully', async () => {
        const controller = new AbortController();
        controller.abort(); // Pre-abort

        const results = await search<Name>(
            TEST_QUERY_MOVIE,
            controller.signal,
            'TEST',
            process.env
        );

        // Should return empty array, not throw
        expect(Array.isArray(results)).toBe(true);
    }, 5000);
});
```

#### For `http-provider` type:

```javascript
/**
 * Tests for <Name> HTTP streaming provider
 *
 * These are integration tests that hit the live <Name> website.
 * They are skipped by default to avoid breaking CI.
 * To run: npm test -- tests/<name>.test.js
 *
 * Required env vars: none (uses public site)
 * Optional: <NAME>_BASE_URL to override the default URL
 */

import { describe, test, expect } from '@jest/globals';
import dotenv from 'dotenv';
dotenv.config();

// Import provider functions
import { scrape<Name>Search, load<Name>Content } from '../lib/http-streams/providers/<name>/search.js';
import { get<Name>Streams } from '../lib/http-streams/providers/<name>/streams.js';

// Well-known test content (stable IMDB IDs)
const TEST_MOVIE_IMDB = 'tt1375666';   // Inception (2010)
const TEST_MOVIE_NAME = 'Inception';
const TEST_SERIES_IMDB = 'tt0903747';  // Breaking Bad
const TEST_SERIES_NAME = 'Breaking Bad';

describe('<Name> search', () => {
    test.skip('finds results for a known movie', async () => {
        const results = await scrape<Name>Search(TEST_MOVIE_NAME);

        expect(Array.isArray(results)).toBe(true);
        expect(results.length).toBeGreaterThan(0);

        const first = results[0];
        expect(first).toHaveProperty('title');
        expect(first).toHaveProperty('url');
        expect(typeof first.url).toBe('string');
        expect(first.url).toMatch(/^https?:\/\//);

        console.log(`Search found ${results.length} results`);
        console.log(`First: ${first.title} → ${first.url}`);
    }, 30000);

    test.skip('returns empty array for unknown title', async () => {
        const results = await scrape<Name>Search('xxxxxxxxxxx_no_match_expected');
        expect(Array.isArray(results)).toBe(true);
    }, 15000);
});

describe('<Name> content loading', () => {
    test.skip('loads content page and returns download links', async () => {
        // First get a URL from search
        const searchResults = await scrape<Name>Search(TEST_MOVIE_NAME);
        expect(searchResults.length).toBeGreaterThan(0);

        const content = await load<Name>Content(searchResults[0].url);
        expect(content).toBeDefined();
        expect(content).toHaveProperty('title');
        expect(content).toHaveProperty('downloadLinks');
        expect(Array.isArray(content.downloadLinks)).toBe(true);

        console.log(`Content: "${content.title}", ${content.downloadLinks.length} download links`);
    }, 45000);
});

describe('<Name> stream generation', () => {
    test.skip('returns streams for a movie', async () => {
        const streams = await get<Name>Streams(
            TEST_MOVIE_IMDB,
            'movie',
            null,
            null,
            process.env
        );

        expect(Array.isArray(streams)).toBe(true);
        console.log(`Found ${streams.length} streams`);

        if (streams.length > 0) {
            const first = streams[0];
            expect(first).toHaveProperty('name');
            expect(first).toHaveProperty('title');
            expect(first).toHaveProperty('url');
            expect(first.url).toMatch(/^https?:\/\//);
            console.log(`First stream: ${first.name}`);
        }
    }, 60000);

    test.skip('returns streams for a series episode', async () => {
        const streams = await get<Name>Streams(
            TEST_SERIES_IMDB,
            'series',
            1,   // season
            1,   // episode
            process.env
        );

        expect(Array.isArray(streams)).toBe(true);
        console.log(`Found ${streams.length} streams for S01E01`);
    }, 60000);
});
```

Replace all `<name>`, `<Name>`, `<NAME>`, and `<category>` placeholders with the actual values. Update the import path based on the actual file location.

### Step 4 — Report

Tell the user:
- File created: `tests/<name>.test.js`
- All tests are skipped by default (use `test.skip` → `test` to enable)
- How to run: `npm test -- tests/<name>.test.js`
- How to run with verbose output: `npm test -- --verbose tests/<name>.test.js`
- Note: these are live integration tests — they require network access and a running target service
