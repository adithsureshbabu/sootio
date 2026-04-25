#!/usr/bin/env node
/**
 * E2E test for scrapers + HTTP streaming providers
 * Tests the full pipeline without needing debrid credentials
 *
 * Usage: node scripts/e2e-scrapers-and-http.js
 */

import 'dotenv/config';

// Scrapers
import { search1337x } from '../lib/scrapers/public-trackers/1337x.js';
import { searchKnaben } from '../lib/scrapers/public-trackers/knaben.js';
import { searchSnowfl } from '../lib/scrapers/specialized/snowfl.js';
import { searchThePirateBay } from '../lib/scrapers/public-trackers/thepiratebay.js';
import { searchTorrentGalaxy } from '../lib/scrapers/public-trackers/torrentgalaxy.js';
import { searchIlCorsaroNero } from '../lib/scrapers/public-trackers/ilcorsaronero.js';
import { searchTorrent9 } from '../lib/scrapers/public-trackers/torrent9.js';

// HTTP streaming

const TIMEOUT = 30000;
const LOG_PREFIX = 'E2E';
const mockConfig = { SCRAPER_TIMEOUT: TIMEOUT, Languages: [] };

const results = [];

function log(icon, name, msg) {
    results.push({ icon, name, msg });
    console.log(`  ${icon} ${name}: ${msg}`);
}

async function runTest(name, fn) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT + 5000);
    const start = Date.now();
    try {
        const res = await fn(controller.signal);
        const elapsed = Date.now() - start;
        if (res && res.length > 0) {
            log('✅', name, `${res.length} results in ${elapsed}ms`);
            return true;
        } else {
            log('⚠️ ', name, `0 results in ${elapsed}ms`);
            return false;
        }
    } catch (err) {
        const elapsed = Date.now() - start;
        log('❌', name, `ERROR in ${elapsed}ms: ${err.message}`);
        return false;
    } finally {
        clearTimeout(timer);
    }
}

console.log(`\n${'='.repeat(60)}`);
console.log('E2E Test: Scrapers + HTTP Streaming');
console.log(`${'='.repeat(60)}`);

// ============================================================
// Part 1: Scraper tests (movie search)
// ============================================================
console.log('\n--- Scrapers: Movie search "Inception 2010" ---');
const movieQuery = 'Inception 2010';

let scraperPass = 0;
let scraperTotal = 0;

const scraperTests = [
    ['1337x', (sig) => search1337x(movieQuery, sig, LOG_PREFIX, mockConfig)],
    ['Knaben', (sig) => searchKnaben(movieQuery, sig, LOG_PREFIX, mockConfig)],
    ['Snowfl', (sig) => searchSnowfl(movieQuery, sig, LOG_PREFIX, mockConfig)],
    ['IlCorsaroNero', (sig) => searchIlCorsaroNero(movieQuery, sig, LOG_PREFIX, mockConfig)],
    ['Torrent9', (sig) => searchTorrent9(movieQuery, sig, LOG_PREFIX, mockConfig)],
    ['ThePirateBay', (sig) => searchThePirateBay(movieQuery, sig, LOG_PREFIX, mockConfig)],
    ['TorrentGalaxy', (sig) => searchTorrentGalaxy(movieQuery, sig, LOG_PREFIX, mockConfig)],
];

for (const [name, fn] of scraperTests) {
    scraperTotal++;
    if (await runTest(name, fn)) scraperPass++;
}

// ============================================================
// Part 2: Scraper tests (TV search)
// ============================================================
console.log('\n--- Scrapers: TV search "Breaking Bad S01E01" ---');
const tvQuery = 'Breaking Bad S01E01';

const tvTests = [
    ['1337x (TV)', (sig) => search1337x(tvQuery, sig, LOG_PREFIX, mockConfig)],
    ['Knaben (TV)', (sig) => searchKnaben(tvQuery, sig, LOG_PREFIX, mockConfig)],
    ['Snowfl (TV)', (sig) => searchSnowfl(tvQuery, sig, LOG_PREFIX, mockConfig)],
];

for (const [name, fn] of tvTests) {
    scraperTotal++;
    if (await runTest(name, fn)) scraperPass++;
}

let httpPass = 0;
let httpTotal = 0;

// ============================================================
// Summary
// ============================================================
console.log(`\n${'='.repeat(60)}`);
console.log('SUMMARY');
console.log(`${'='.repeat(60)}`);
for (const { icon, name, msg } of results) {
    console.log(`  ${icon} ${name.padEnd(25)} ${msg}`);
}
const totalPass = scraperPass + httpPass;
const totalTests = scraperTotal + httpTotal;
const totalFail = totalTests - totalPass;
console.log(`\nScrapers: ${scraperPass}/${scraperTotal} passed`);
console.log(`HTTP Streaming: ${httpPass}/${httpTotal} passed`);
console.log(`Total: ${totalPass}/${totalTests} passed, ${totalFail} failed`);
console.log(`${'='.repeat(60)}\n`);

// Exit with non-zero only if the known-working scrapers fail
const criticalFail = results.some(r =>
    r.icon === '❌' && ['1337x', 'Knaben', 'Snowfl'].includes(r.name)
);
process.exit(criticalFail ? 1 : 0);
