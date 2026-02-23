/**
 * Test all public-tracker and specialized scrapers
 * Usage: node --experimental-vm-modules scripts/test-all-scrapers.js
 */

import { config } from 'dotenv';
config();

// Import all public tracker scrapers
import { searchThePirateBay } from '../lib/scrapers/public-trackers/thepiratebay.js';
import { search1337x } from '../lib/scrapers/public-trackers/1337x.js';
import { searchBtdig } from '../lib/scrapers/public-trackers/btdig.js';
import { searchMagnetDL } from '../lib/scrapers/public-trackers/magnetdl.js';
import { searchTorrentGalaxy } from '../lib/scrapers/public-trackers/torrentgalaxy.js';
import { searchKnaben } from '../lib/scrapers/public-trackers/knaben.js';
import { searchExtTo } from '../lib/scrapers/public-trackers/extto.js';
import { searchTorrentDownload } from '../lib/scrapers/public-trackers/torrentdownload.js';
import { searchIlCorsaroNero } from '../lib/scrapers/public-trackers/ilcorsaronero.js';
import { searchTorrent9 } from '../lib/scrapers/public-trackers/torrent9.js';
import { searchLimeTorrents } from '../lib/scrapers/public-trackers/limetorrents.js';

// Import specialized scrapers
import { searchSnowfl } from '../lib/scrapers/specialized/snowfl.js';

const QUERY = 'matrix';
const TIMEOUT = 30000;
const LOG_PREFIX = 'TEST';

const scrapers = [
    { name: 'ThePirateBay', fn: searchThePirateBay },
    { name: '1337x', fn: search1337x },
    { name: 'BTDigg', fn: searchBtdig },
    { name: 'MagnetDL', fn: searchMagnetDL },
    { name: 'TorrentGalaxy', fn: searchTorrentGalaxy },
    { name: 'Knaben', fn: searchKnaben },
    { name: 'ExtTo', fn: searchExtTo },
    { name: 'TorrentDownload', fn: searchTorrentDownload },
    { name: 'IlCorsaroNero', fn: searchIlCorsaroNero },
    { name: 'Torrent9', fn: searchTorrent9 },
    { name: 'LimeTorrents', fn: (q, s, lp, cfg) => searchLimeTorrents(q, s, cfg, lp) },
    { name: 'Snowfl', fn: searchSnowfl },
];

const mockConfig = {
    SCRAPER_TIMEOUT: TIMEOUT,
    Languages: [],
};

console.log(`\n${'='.repeat(60)}`);
console.log(`Testing all scrapers with query: "${QUERY}"`);
console.log(`${'='.repeat(60)}\n`);

const results = {};

for (const { name, fn } of scrapers) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT + 5000);

    try {
        console.log(`\n--- ${name} ---`);
        const start = Date.now();
        const res = await fn(QUERY, controller.signal, LOG_PREFIX, mockConfig);
        const elapsed = Date.now() - start;
        results[name] = { count: res.length, elapsed, error: null };

        if (res.length > 0) {
            console.log(`  ✅ ${name}: ${res.length} results in ${elapsed}ms`);
            console.log(`     Sample: ${res[0].Title} (${(res[0].Size / (1024**3)).toFixed(2)} GB, ${res[0].Seeders} seeders)`);
        } else {
            console.log(`  ⚠️  ${name}: 0 results in ${elapsed}ms`);
        }
    } catch (err) {
        results[name] = { count: 0, elapsed: 0, error: err.message };
        console.log(`  ❌ ${name}: ERROR - ${err.message}`);
    } finally {
        clearTimeout(timer);
    }
}

console.log(`\n${'='.repeat(60)}`);
console.log('SUMMARY');
console.log(`${'='.repeat(60)}`);
let passCount = 0;
let failCount = 0;
for (const [name, { count, elapsed, error }] of Object.entries(results)) {
    if (error) {
        console.log(`  ❌ ${name.padEnd(20)} ERROR: ${error}`);
        failCount++;
    } else if (count > 0) {
        console.log(`  ✅ ${name.padEnd(20)} ${String(count).padStart(4)} results  (${elapsed}ms)`);
        passCount++;
    } else {
        console.log(`  ⚠️  ${name.padEnd(20)}    0 results  (${elapsed}ms)`);
        failCount++;
    }
}
console.log(`\n${passCount} passed, ${failCount} failed/empty`);
console.log(`${'='.repeat(60)}\n`);

process.exit(failCount > 0 ? 1 : 0);
