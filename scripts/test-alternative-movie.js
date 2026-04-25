#!/usr/bin/env node

import 'dotenv/config';
import { getMalluMvStreams } from '../lib/http-streams/providers/mallumv/streams.js';
import { getCineDozeStreams } from '../lib/http-streams/providers/cinedoze/streams.js';
import { getMoviesLeechStreams } from '../lib/http-streams/providers/moviesleech/streams.js';

const ALT_MOVIE = {
    tmdbId: '550',  // Fight Club
    name: 'Fight Club',
    year: 1999,
    type: 'movie'
};

const CONFIG = { clientIp: '127.0.0.1' };

async function test(name, fn) {
    console.log(`\n=== ${name} ===`);
    try {
        const streams = await fn(ALT_MOVIE.tmdbId, ALT_MOVIE.type, null, null, CONFIG, {
            name: ALT_MOVIE.name,
            year: ALT_MOVIE.year
        });
        console.log(`Got ${streams.length} streams`);
        if (streams.length > 0) {
            console.log('First stream:', streams[0].title?.substring(0, 80));
        }
    } catch(e) {
        console.log('ERROR:', e.message);
    }
}

await test('MalluMv', getMalluMvStreams);
await test('CineDoze', getCineDozeStreams);
await test('MoviesLeech', getMoviesLeechStreams);
