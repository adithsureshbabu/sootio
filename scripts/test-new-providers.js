#!/usr/bin/env node
/**
 * Test script for new HTTP stream providers: MoviesMod, MoviesLeech, AnimeFlix
 * Tests search, page parsing, and link extraction.
 */

import { getMoviesModStreams } from '../lib/http-streams/providers/moviesmod/streams.js';
import { getMoviesLeechStreams } from '../lib/http-streams/providers/moviesleech/streams.js';
import { getAnimeFlixStreams } from '../lib/http-streams/providers/animeflix/streams.js';

// Inception - classic movie, available on MoviesMod
const TEST_MOVIESMOD_IMDB = 'tt1375666';
// Pushpa 2 - Bollywood, available on MoviesLeech
const TEST_MOVIESLEECH_IMDB = 'tt15441026';
// Demon Slayer: Kimetsu no Yaiba (TV series) - available on AnimeFlix
const TEST_ANIMEFLIX_IMDB = 'tt9335498';

async function testProvider(name, fn, imdbId, type = 'movie', season = null, episode = null) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Testing ${name} with IMDB ${imdbId} (${type})...`);
    console.log(`${'='.repeat(60)}`);

    try {
        const start = Date.now();
        const streams = await fn(imdbId, type, season, episode, {});
        const duration = ((Date.now() - start) / 1000).toFixed(2);

        console.log(`\n[${name}] Got ${streams.length} streams in ${duration}s`);

        if (streams.length > 0) {
            console.log(`\n[${name}] Sample streams:`);
            streams.slice(0, 5).forEach((stream, i) => {
                console.log(`  ${i + 1}. ${stream.name} | ${stream.title?.substring(0, 100)}...`);
                console.log(`     URL: ${stream.url?.substring(0, 120)}...`);
                console.log(`     Preview: ${stream.isPreview ? 'Yes' : 'No'}, NeedsRes: ${stream.needsResolution ? 'Yes' : 'No'}`);
            });
        }

        return streams;
    } catch (err) {
        console.error(`[${name}] ERROR: ${err.message}`);
        console.error(err.stack);
        return [];
    }
}

async function main() {
    console.log('Testing new HTTP stream providers...\n');

    // Test MoviesMod with Inception
    const moviesmodStreams = await testProvider('MoviesMod', getMoviesModStreams, TEST_MOVIESMOD_IMDB, 'movie');

    // Test MoviesLeech with Pushpa 2
    const moviesleechStreams = await testProvider('MoviesLeech', getMoviesLeechStreams, TEST_MOVIESLEECH_IMDB, 'movie');

    // Test AnimeFlix with Demon Slayer (series, S1E1)
    const animeflixStreams = await testProvider('AnimeFlix', getAnimeFlixStreams, TEST_ANIMEFLIX_IMDB, 'series', 1, 1);

    console.log(`\n${'='.repeat(60)}`);
    console.log('SUMMARY');
    console.log(`${'='.repeat(60)}`);
    console.log(`MoviesMod:    ${moviesmodStreams.length} streams`);
    console.log(`MoviesLeech:  ${moviesleechStreams.length} streams`);
    console.log(`AnimeFlix:    ${animeflixStreams.length} streams`);
}

main().catch(console.error);
