Add a new torrent scraper to the Sootio addon.

Arguments: $ARGUMENTS
Format: `<scraper-name> <category>`
Categories: `public-trackers` | `torznab` | `stremio-addons` | `specialized`
Example: `yts public-trackers`

## Instructions

Parse the scraper name and category from the arguments. The scraper name should be lowercase (e.g. `yts`), and the exported function name should be PascalCase prefixed with `search` (e.g. `searchYts`).

### Step 1 — Read a reference scraper

Read an existing scraper from the same category for reference:
- `public-trackers` → read `lib/scrapers/public-trackers/knaben.js`
- `torznab` → read `lib/scrapers/torznab/jackett.js`
- `stremio-addons` → read `lib/scrapers/stremio-addons/torrentio.js`
- `specialized` → read `lib/scrapers/specialized/snowfl.js`

### Step 2 — Create the scraper file

Create `lib/scrapers/<category>/<name>.js` following this exact pattern:

```javascript
import axios from 'axios';
import * as config from '../../config.js';
import { getHashFromMagnet } from '../../common/torrent-utils.js';
import debridProxyManager from '../../util/debrid-proxy.js';

import { createTimerLabel } from '../utils/timing.js';
import { detectSimpleLangs } from '../utils/filtering.js';
import { processAndDeduplicate } from '../utils/deduplication.js';
import { handleScraperError } from '../utils/error-handling.js';

const ENV = config;

const axiosWithProxy = axios.create(debridProxyManager.getScraperAxiosConfig('<name>'));

export async function search<Name>(query, signal, logPrefix, config) {
    const scraperName = '<DisplayName>';
    const sfx = (config?.Languages && config.Languages.length) ? `:${config.Languages[0]}` : ':none';
    const timerLabel = createTimerLabel(logPrefix, scraperName, sfx);
    console.time(timerLabel);

    try {
        const limit = config?.<NAME>_LIMIT ?? ENV.<NAME>_LIMIT ?? 200;
        const base = (config?.<NAME>_URL || ENV.<NAME>_URL || '').replace(/\/$/, '');
        const timeout = config?.<NAME>_TIMEOUT ?? ENV.<NAME>_TIMEOUT ?? config?.SCRAPER_TIMEOUT ?? ENV.SCRAPER_TIMEOUT ?? 5000;

        if (!base) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} URL not configured`);
            return [];
        }

        console.log(`[${logPrefix} SCRAPER] ${scraperName} searching: ${query}`);

        // TODO: implement the actual HTTP request and response parsing for this scraper's API
        const response = await axiosWithProxy.get(`${base}/search`, {
            params: { q: query, limit },
            timeout,
            signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'application/json'
            }
        });

        // TODO: adapt this mapping to the actual API response shape
        const items = response.data?.results || response.data?.torrents || response.data || [];
        const results = items.slice(0, limit).map(item => {
            const infoHash = item.hash || item.info_hash || getHashFromMagnet(item.magnet);
            if (!infoHash) return null;
            return {
                Title: item.title || item.name,
                InfoHash: infoHash.toLowerCase(),
                Size: item.size || item.bytes || 0,
                Seeders: item.seeders || item.seeds || 0,
                Leechers: item.leechers || item.peers || 0,
                Tracker: scraperName,
                Langs: detectSimpleLangs(item.title || item.name || '')
            };
        }).filter(Boolean);

        const processedResults = processAndDeduplicate(results, config);
        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${processedResults.length} results after processing.`);
        return processedResults;

    } catch (error) {
        handleScraperError(error, scraperName, logPrefix);
        return [];
    } finally {
        console.timeEnd(timerLabel);
    }
}
```

Fill in the real API URL, request format, and response parsing based on the scraper's actual API documentation. The `TODO` comments mark areas that need customisation.

### Step 3 — Register in index

Read `lib/scrapers/index.js`, then append the export line in the appropriate category section:

```javascript
export { search<Name> } from './<category>/<name>.js';
```

### Step 4 — Add env vars to .env.example

Read `.env.example`, then append to the appropriate scrapers section:

```
# <DisplayName>
<NAME>_ENABLED=false
<NAME>_URL=https://api.<name>.to
<NAME>_LIMIT=200
<NAME>_TIMEOUT=5000
```

### Step 5 — Summary

Report:
- File created: `lib/scrapers/<category>/<name>.js`
- Export added to: `lib/scrapers/index.js`
- Env vars added to: `.env.example`
- Remind the user to implement the actual HTTP request and response parsing (marked with `TODO` comments)
