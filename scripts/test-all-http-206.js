#!/usr/bin/env node

import 'dotenv/config';

import { get4KHDHubStreams } from '../lib/http-streams/providers/4khdhub/streams.js';
import { getAnimeFlixStreams } from '../lib/http-streams/providers/animeflix/streams.js';
import { getAsiaflixStreams } from '../lib/http-streams/providers/asiaflix/streams.js';
import { getCineDozeStreams } from '../lib/http-streams/providers/cinedoze/streams.js';
import { getHDHub4uStreams } from '../lib/http-streams/providers/hdhub4u/streams.js';
import { getMalluMvStreams } from '../lib/http-streams/providers/mallumv/streams.js';
import { getMKVCinemasStreams } from '../lib/http-streams/providers/mkvcinemas/streams.js';
import { getMoviesLeechStreams } from '../lib/http-streams/providers/moviesleech/streams.js';
import { getMoviesModStreams } from '../lib/http-streams/providers/moviesmod/streams.js';
import { getVixSrcStreams } from '../lib/http-streams/providers/vixsrc/streams.js';
import { resolveHttpStreamUrl } from '../lib/http-streams/resolvers/http-resolver.js';
import { validateSeekableUrl } from '../lib/http-streams/utils/validation.js';
import { makeRequest } from '../lib/http-streams/utils/http.js';

const TEST_MOVIE = {
    imdbId: 'tt1375666',
    tmdbId: '27205',
    name: 'Inception',
    year: 2010,
    type: 'movie'
};

const CONFIG = { clientIp: '127.0.0.1' };
const DIRECT_PROBE_TIMEOUT = 10_000;
const MAX_DIRECT_STREAMS_TO_TRY = 5;

function looksLikeMediaPayload(buffer, contentType = '') {
    if (!buffer || buffer.length === 0) return false;

    const lowerType = String(contentType).toLowerCase();
    if (lowerType.includes('video/') || lowerType.includes('audio/') || lowerType.includes('mp2t')) {
        return true;
    }

    // MPEG-TS sync byte check
    if (buffer[0] === 0x47) return true;
    if (buffer.length > 188 && buffer[188] === 0x47) return true;

    const textPrefix = buffer.subarray(0, 64).toString('utf8').trim().toLowerCase();
    if (!textPrefix) return false;
    if (textPrefix.startsWith('<!doctype') || textPrefix.startsWith('<html') || textPrefix.startsWith('<h1')) {
        return false;
    }

    return true;
}

async function probeDirectUrl206(url, headers = {}) {
    const validation = await validateSeekableUrl(url, {
        requirePartialContent: true,
        timeout: DIRECT_PROBE_TIMEOUT
    });

    if (!validation?.isValid || validation.statusCode !== 206) {
        return {
            ok: false,
            reason: `seek validation failed (${validation?.statusCode ?? 'unknown'})`,
            validation
        };
    }

    // Small GET range probe to confirm payload is media rather than HTML placeholder.
    const rangeResponse = await makeRequest(url, {
        method: 'GET',
        timeout: DIRECT_PROBE_TIMEOUT,
        maxBodySize: 4096,
        headers: {
            ...headers,
            Range: 'bytes=0-1023'
        }
    });

    const payloadBuffer = Buffer.from(rangeResponse.body || '', 'utf8');
    const contentType = rangeResponse.headers?.['content-type'] || '';
    const isMedia = looksLikeMediaPayload(payloadBuffer, contentType);

    return {
        ok: rangeResponse.statusCode === 206 && isMedia,
        statusCode: rangeResponse.statusCode,
        contentType,
        contentRange: rangeResponse.headers?.['content-range'] || null,
        validation
    };
}

async function verifyDirectProvider(providerName, getStreamsFn, meta, useImdbId = false, hasConfigParam = true) {
    const startedAt = Date.now();
    const contentId = useImdbId ? meta.imdbId : meta.tmdbId;

    let streams;
    try {
        if (hasConfigParam) {
            streams = await getStreamsFn(contentId, meta.type, null, null, CONFIG, {
                name: meta.name,
                year: meta.year
            });
        } else {
            streams = await getStreamsFn(contentId, meta.type, null, null);
        }
    } catch (error) {
        return { provider: providerName, ok: false, streamsCount: 0, reason: `search error: ${error.message}`, elapsedMs: Date.now() - startedAt };
    }

    if (!Array.isArray(streams) || streams.length === 0) {
        return { provider: providerName, ok: false, streamsCount: 0, reason: 'no streams', elapsedMs: Date.now() - startedAt };
    }

    const attempts = [];
    for (const stream of streams.slice(0, MAX_DIRECT_STREAMS_TO_TRY)) {
        const sourceUrl = stream?.url;
        if (!sourceUrl) continue;

        try {
            const resolvedUrl = await resolveHttpStreamUrl(sourceUrl);
            if (!resolvedUrl) {
                attempts.push({ sourceUrl, ok: false, reason: 'resolver returned null' });
                continue;
            }

            const probe = await probeDirectUrl206(resolvedUrl);
            attempts.push({
                sourceUrl,
                resolvedUrl,
                ...probe
            });

            if (probe.ok) {
                return {
                    provider: providerName,
                    ok: true,
                    streamsCount: streams.length,
                    elapsedMs: Date.now() - startedAt,
                    result: {
                        streamTitle: stream.title?.split('\n')[0] || stream.name || '',
                        resolvedUrl,
                        statusCode: probe.statusCode,
                        contentType: probe.contentType,
                        contentRange: probe.contentRange
                    }
                };
            }
        } catch (error) {
            attempts.push({ sourceUrl, ok: false, reason: error.message });
        }
    }

    return {
        provider: providerName,
        ok: false,
        streamsCount: streams.length,
        elapsedMs: Date.now() - startedAt,
        reason: 'no stream resolved to 206 media',
        attempts
    };
}

function printResult(result) {
    console.log(`\n=== ${result.provider} ===`);
    console.log(`ok: ${result.ok}`);
    console.log(`streams: ${result.streamsCount ?? 0}`);
    console.log(`elapsedMs: ${result.elapsedMs ?? 0}`);

    if (result.ok) {
        console.log(JSON.stringify(result.result, null, 2));
        return;
    }

    if (result.reason) {
        console.log(`reason: ${result.reason}`);
    }

    if (Array.isArray(result.attempts) && result.attempts.length > 0) {
        const attemptsPreview = result.attempts.slice(0, 3);
        console.log(JSON.stringify(attemptsPreview, null, 2));
        if (result.attempts.length > attemptsPreview.length) {
            console.log(`... ${result.attempts.length - attemptsPreview.length} more attempts`);
        }
    }
}

async function main() {
    const results = [];

    const providers = [
        { name: '4KHDHub', fn: get4KHDHubStreams, useImdbId: false, hasConfigParam: true },
        { name: 'AnimeFlixStreams', fn: getAnimeFlixStreams, useImdbId: false, hasConfigParam: true },
        { name: 'AsiaflixStreams', fn: getAsiaflixStreams, useImdbId: false, hasConfigParam: true },
        { name: 'CineDoze', fn: getCineDozeStreams, useImdbId: false, hasConfigParam: true },
        { name: 'HDHub4u', fn: getHDHub4uStreams, useImdbId: true, hasConfigParam: true },
        { name: 'MalluMv', fn: getMalluMvStreams, useImdbId: false, hasConfigParam: true },
        { name: 'MKVCinemas', fn: getMKVCinemasStreams, useImdbId: false, hasConfigParam: true },
        { name: 'MoviesLeech', fn: getMoviesLeechStreams, useImdbId: false, hasConfigParam: true },
        { name: 'MoviesMod', fn: getMoviesModStreams, useImdbId: false, hasConfigParam: true },
        { name: 'VixSrc', fn: getVixSrcStreams, useImdbId: false, hasConfigParam: false }
    ];

    console.log(`\n\n========================================\n  Testing ${providers.length} HTTP Stream Providers\n========================================\n`);

    for (const provider of providers) {
        console.log(`[${providers.indexOf(provider) + 1}/${providers.length}] Testing ${provider.name}...`);
        try {
            const result = await verifyDirectProvider(provider.name, provider.fn, TEST_MOVIE, provider.useImdbId, provider.hasConfigParam);
            results.push(result);
        } catch (error) {
            console.log(`  ERROR: ${error.message}`);
            results.push({
                provider: provider.name,
                ok: false,
                reason: `fatal error: ${error.message}`,
                elapsedMs: 0
            });
        }
    }

    console.log('\n\n========================================\n  Test Results\n========================================');

    for (const result of results) {
        printResult(result);
    }

    const failed = results.filter(result => !result.ok);
    console.log(`\n\nSUMMARY: ${results.length - failed.length}/${results.length} providers passed strict 206 media verification`);
    if (failed.length > 0) {
        console.log(`FAILED: ${failed.map(result => result.provider).join(', ')}`);
        process.exit(1);
    } else {
        console.log('ALL PROVIDERS PASSED!');
    }
}

main().catch(error => {
    console.error('[E2E-HTTP-206] Fatal error:', error);
    process.exit(1);
});
