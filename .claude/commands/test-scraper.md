Run a single torrent scraper in isolation to verify it's working and inspect its results.

Arguments: $ARGUMENTS
Format: `<scraper-name> [query]`
Examples:
  `knaben`
  `knaben "The Dark Knight 2008"`
  `1337x "Inception 2010"`
  `jackett "Breaking Bad S01E01"`

## Instructions

### Step 1 — Resolve the scraper

Parse the scraper name from arguments. Map common shorthand names to their actual module names:
- `1337x` → `lib/scrapers/public-trackers/1337x.js`, export: `search1337x`
- `knaben` → `lib/scrapers/public-trackers/knaben.js`, export: `searchKnaben`
- `btdig` → `lib/scrapers/public-trackers/btdig.js`, export: `searchBtdig`
- `magnetdl` → `lib/scrapers/public-trackers/magnetdl.js`, export: `searchMagnetDL`
- `torrentgalaxy` → `lib/scrapers/public-trackers/torrentgalaxy.js`, export: `searchTorrentGalaxy`
- `thepiratebay` / `tpb` → `lib/scrapers/public-trackers/thepiratebay.js`, export: `searchThePirateBay`
- `limetorrents` → `lib/scrapers/public-trackers/limetorrents.js`, export: `searchLimeTorrents`
- `torrent9` → `lib/scrapers/public-trackers/torrent9.js`, export: `searchTorrent9`
- `extto` → `lib/scrapers/public-trackers/extto.js`, export: `searchExtTo`
- `torrentdownload` → `lib/scrapers/public-trackers/torrentdownload.js`, export: `searchTorrentDownload`
- `ilcorsaronero` → `lib/scrapers/public-trackers/ilcorsaronero.js`, export: `searchIlCorsaroNero`
- `jackett` → `lib/scrapers/torznab/jackett.js`, export: `searchJackett`
- `zilean` → `lib/scrapers/torznab/zilean.js`, export: `searchZilean`
- `bitmagnet` → `lib/scrapers/torznab/bitmagnet.js`, export: `searchBitmagnet`
- `torrentio` → `lib/scrapers/stremio-addons/torrentio.js`, export: `searchTorrentio`
- `comet` → `lib/scrapers/stremio-addons/comet.js`, export: `searchComet`
- `stremthru` → `lib/scrapers/stremio-addons/stremthru.js`, export: `searchStremthru`
- `snowfl` → `lib/scrapers/specialized/snowfl.js`, export: `searchSnowfl`
- `wolfmax4k` → `lib/scrapers/specialized/wolfmax4k.js`, export: `searchWolfmax4K`
- `bludv` → `lib/scrapers/specialized/bludv.js`, export: `searchBluDV`

Read `lib/scrapers/index.js` to confirm the export name. If the scraper name is not recognized, list all available scrapers.

### Step 2 — Check configuration

Read the scraper file (e.g. `lib/scrapers/public-trackers/knaben.js`) to find which env vars it uses (look for `config?.` or `ENV.` references).

Read `.env` (or `.env.example`) and check:
- Is `<NAME>_ENABLED=true`? If false or missing → warn but continue
- Is `<NAME>_URL` set (if required)? If missing for URL-required scrapers → error and stop
- Is the API key set (for Jackett: `JACKETT_API_KEY`)?

Show the current config values for this scraper.

### Step 3 — Determine test query

Use the query from `$ARGUMENTS` if provided.
Otherwise use default: `"Inception 2010"` (reliable cross-scraper test).

### Step 4 — Generate and run a test script

Create a temporary test script at `/tmp/test-scraper-<name>.mjs` with this structure:

```javascript
import dotenv from 'dotenv';
dotenv.config();

import { search<Name> } from './<path-to-scraper>';

const query = '<test-query>';
const logPrefix = 'TEST';
const signal = AbortSignal.timeout(15000);

console.log(`Testing <ScraperName> with query: "${query}"`);
console.log('---');

const start = Date.now();
try {
    const results = await search<Name>(query, signal, logPrefix, process.env);
    const elapsed = Date.now() - start;

    console.log(`\nCompleted in ${elapsed}ms`);
    console.log(`Results: ${results.length}`);

    if (results.length === 0) {
        console.log('⚠️  No results returned');
    } else {
        console.log('\nTop 5 results:');
        results.slice(0, 5).forEach((r, i) => {
            const size = r.Size ? `${(r.Size / 1073741824).toFixed(2)} GB` : 'unknown size';
            console.log(`${i + 1}. ${r.Title}`);
            console.log(`   Hash: ${r.InfoHash}`);
            console.log(`   Seeds: ${r.Seeders} | Size: ${size} | Tracker: ${r.Tracker}`);
            console.log(`   Langs: ${(r.Langs || []).join(', ') || 'none detected'}`);
        });

        if (results.length > 5) {
            console.log(`\n... and ${results.length - 5} more results`);
        }

        // Quality summary
        const withHash = results.filter(r => r.InfoHash).length;
        const withSeeders = results.filter(r => r.Seeders > 0).length;
        console.log(`\nQuality: ${withHash}/${results.length} have valid hash, ${withSeeders}/${results.length} have seeders`);
    }
} catch (error) {
    const elapsed = Date.now() - start;
    console.error(`❌ Error after ${elapsed}ms: ${error.message}`);
    if (error.code) console.error(`   Code: ${error.code}`);
}
```

Use the correct relative import path from the project root.

Run the script:
```
node /tmp/test-scraper-<name>.mjs
```

### Step 5 — Report results

After running, summarize:
- **Status**: ✅ working / ⚠️ partial / ❌ failed
- **Latency**: Xms
- **Result count**: N results
- **Data quality**: % with valid hash, % with seeders
- **Issues found**: any errors, empty responses, malformed data

If the scraper returned 0 results or failed, provide specific diagnostics:
- Check if the URL is reachable
- Check if the response format matches what the scraper expects
- Suggest checking the site for changes (domain moved, API changed)
- Suggest increasing `<NAME>_TIMEOUT` if it timed out
