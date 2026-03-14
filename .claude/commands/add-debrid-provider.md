Add a new debrid service provider to the Sootio addon.

Arguments: $ARGUMENTS
Format: `<service-name>`
Example: `easydebrid`

The service name should be lowercase with hyphens if needed (e.g. `easydebrid`). The file will be `lib/<name>.js`.

## Instructions

### Step 1 — Read reference implementations

Read these two files before writing any code:
- `lib/torbox.js` — modern/clean debrid integration pattern
- `lib/premiumize.js` — alternative pattern with personal cloud support

Note the key patterns:
- API calls are made with `axios` and the user's API key
- `checkCachedTorrents(apiKey, hashes)` returns a `Set<string>` of cached info hashes
- `getDownloadUrl(apiKey, magnet, fileIdx)` returns a direct streaming URL string
- `listTorrents(apiKey)` returns personal cloud torrents
- `searchPersonalFiles(apiKey, searchKey, threshold)` uses fuzzy matching via fuse.js

### Step 2 — Create the provider file

Create `lib/<name>.js` implementing the standard debrid interface:

```javascript
/**
 * <Name> Debrid Provider
 * Integration for <Name> (https://<name>.com)
 */

import axios from 'axios';
import Fuse from 'fuse.js';
import debridProxyManager from './util/debrid-proxy.js';

const BASE_URL = 'https://api.<name>.com';  // TODO: update with real API base URL
const DEFAULT_TIMEOUT = 15000;

// Create axios instance with optional proxy support
const api = axios.create(debridProxyManager.getAxiosConfig('<name>'));

/**
 * Check which hashes are instantly available (cached) on <Name>.
 * @param {string} apiKey - User's <Name> API key
 * @param {string[]} hashes - Array of info hashes to check
 * @returns {Promise<Set<string>>} Set of cached info hashes (lowercase)
 */
export async function checkCachedTorrents(apiKey, hashes) {
    if (!hashes?.length) return new Set();

    try {
        // TODO: implement using the actual <Name> instant availability API endpoint
        // Example pattern (adapt to real API):
        const response = await api.post(`${BASE_URL}/torrents/instant`, {
            hashes
        }, {
            headers: { Authorization: `Bearer ${apiKey}` },
            timeout: DEFAULT_TIMEOUT
        });

        // TODO: adapt response parsing to actual API shape
        const cachedHashes = new Set();
        const data = response.data?.data || response.data || {};
        for (const [hash, info] of Object.entries(data)) {
            if (info?.cached || info?.instant) {
                cachedHashes.add(hash.toLowerCase());
            }
        }
        return cachedHashes;

    } catch (error) {
        console.error(`[<Name>] checkCachedTorrents failed: ${error.message}`);
        return new Set();
    }
}

/**
 * Get a direct streaming URL for a magnet/torrent.
 * @param {string} apiKey - User's <Name> API key
 * @param {string} magnet - Magnet URI or info hash
 * @param {number} fileIdx - File index within the torrent (0-based)
 * @returns {Promise<string|null>} Direct streaming URL or null on failure
 */
export async function getDownloadUrl(apiKey, magnet, fileIdx = 0) {
    try {
        // TODO: implement using the actual <Name> add torrent + get stream URL API
        // Step 1: Add/find the torrent
        const addResponse = await api.post(`${BASE_URL}/torrents/add`, {
            magnet
        }, {
            headers: { Authorization: `Bearer ${apiKey}` },
            timeout: DEFAULT_TIMEOUT
        });

        const torrentId = addResponse.data?.data?.id;
        if (!torrentId) return null;

        // Step 2: Get the streaming URL for the selected file
        const urlResponse = await api.get(`${BASE_URL}/torrents/${torrentId}/stream`, {
            params: { file_id: fileIdx },
            headers: { Authorization: `Bearer ${apiKey}` },
            timeout: DEFAULT_TIMEOUT
        });

        return urlResponse.data?.data?.url || null;

    } catch (error) {
        console.error(`[<Name>] getDownloadUrl failed: ${error.message}`);
        return null;
    }
}

/**
 * List all torrents in the user's personal cloud.
 * @param {string} apiKey
 * @returns {Promise<Array>} Array of torrent objects
 */
export async function listTorrents(apiKey) {
    try {
        // TODO: implement using the actual <Name> list torrents endpoint
        const response = await api.get(`${BASE_URL}/torrents`, {
            headers: { Authorization: `Bearer ${apiKey}` },
            timeout: DEFAULT_TIMEOUT
        });

        return response.data?.data || response.data || [];

    } catch (error) {
        console.error(`[<Name>] listTorrents failed: ${error.message}`);
        return [];
    }
}

/**
 * Fuzzy-search the user's personal cloud files by title.
 * @param {string} apiKey
 * @param {string} searchKey - Title to search for
 * @param {number} threshold - Fuse.js match threshold (0–1, lower = stricter)
 * @returns {Promise<Array>} Matching file objects
 */
export async function searchPersonalFiles(apiKey, searchKey, threshold = 0.3) {
    try {
        const torrents = await listTorrents(apiKey);
        if (!torrents.length) return [];

        // TODO: adapt the keys to match the actual API response shape
        const fuse = new Fuse(torrents, {
            keys: ['name', 'filename', 'title'],
            threshold,
            includeScore: true
        });

        return fuse.search(searchKey).map(result => result.item);

    } catch (error) {
        console.error(`[<Name>] searchPersonalFiles failed: ${error.message}`);
        return [];
    }
}
```

Replace all `<name>` / `<Name>` placeholders and update all `TODO` sections with the real API endpoints.

### Step 3 — Register in stream-provider.js

Read `lib/stream-provider.js`. Search for `TorBox` or `Premiumize` to find the debrid provider integration section. Add the new provider following the same pattern:
- Import the provider functions at the top of the file
- Add a config flag check (e.g. `config.<NAME>_ENABLED` or `config.DEBRID_SERVICE === '<name>'`)
- Integrate into the cache check and stream resolution flow

### Step 4 — Add env vars to .env.example

Read `.env.example` and append to the debrid services section:

```
# <Name> Debrid
<NAME>_ENABLED=false
<NAME>_API_KEY=
<NAME>_RATE_PER_MINUTE=60
<NAME>_CONCURRENCY=10
<NAME>_TIMEOUT=15000
```

### Step 5 — Summary

Report:
- File created: `lib/<name>.js`
- Integration added to: `lib/stream-provider.js`
- Env vars added to: `.env.example`
- Remind the user to:
  1. Update all `TODO` sections with real API endpoints and response shapes
  2. Check the <Name> API documentation for rate limits and update env var defaults accordingly
  3. Consider adding a dedicated rate limiter in `lib/util/<name>-rate-limit.js` following the pattern in `lib/util/rd-rate-limit.js` if the service has strict rate limits
