#!/usr/bin/env node

import 'dotenv/config';

import { getXDMoviesStreams } from '../lib/http-streams/providers/xdmovies/streams.js';
import { getMoviesModStreams } from '../lib/http-streams/providers/moviesmod/streams.js';
import { getNetflixMirrorStreams } from '../lib/http-streams/providers/netflixmirror/streams.js';
import { resolveHttpStreamUrl } from '../lib/http-streams/resolvers/http-resolver.js';
import { validateSeekableUrl } from '../lib/http-streams/utils/validation.js';
import { makeRequest } from '../lib/http-streams/utils/http.js';

const TEST_MOVIE = {
    imdbId: 'tt1375666',
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

function firstPlaylistUri(playlistText = '') {
    return playlistText
        .split(/\r?\n/)
        .map(line => line.trim())
        .find(line => line && !line.startsWith('#') && line.includes('.m3u8')) || null;
}

function firstMediaSegmentUri(playlistText = '') {
    return playlistText
        .split(/\r?\n/)
        .map(line => line.trim())
        .find(line => line && !line.startsWith('#')) || null;
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

async function verifyDirectProvider(providerName, getStreamsFn, meta) {
    const startedAt = Date.now();
    const streams = await getStreamsFn(meta.imdbId, meta.type, null, null, CONFIG, {
        name: meta.name,
        year: meta.year
    });

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

async function fetchPlaylist(url, headers, referer = null) {
    const requestHeaders = { ...headers };
    if (referer) requestHeaders.Referer = referer;
    return makeRequest(url, {
        headers: requestHeaders,
        timeout: 10_000,
        maxBodySize: 1_500_000
    });
}

async function fetchMediaRange(url, headers, referer = null) {
    const requestHeaders = {
        ...headers,
        Range: 'bytes=0-1023'
    };
    if (referer) requestHeaders.Referer = referer;

    return makeRequest(url, {
        method: 'GET',
        headers: requestHeaders,
        timeout: 10_000,
        maxBodySize: 4096
    });
}

async function verifyNetmirror206(meta) {
    const startedAt = Date.now();
    const streams = await getNetflixMirrorStreams(meta.imdbId, meta.type, null, null, CONFIG, {
        name: meta.name,
        year: meta.year
    });

    if (!Array.isArray(streams) || streams.length === 0) {
        return { provider: 'Netmirror', ok: false, streamsCount: 0, reason: 'no streams', elapsedMs: Date.now() - startedAt };
    }

    const attempts = [];
    for (const stream of streams) {
        const masterUrl = stream?.url;
        const baseHeaders = stream?.behaviorHints?.proxyHeaders?.request || {};
        if (!masterUrl || !masterUrl.includes('.m3u8')) continue;

        // Try the provider URL and a /tv/hls variant fallback.
        const masterCandidates = Array.from(new Set([
            masterUrl,
            masterUrl.includes('/hls/') ? masterUrl.replace('/hls/', '/tv/hls/') : null
        ].filter(Boolean)));

        for (const masterCandidate of masterCandidates) {
            const attempt = {
                streamTitle: stream.title?.split('\n')[0] || stream.name || '',
                masterUrl: masterCandidate
            };

            try {
                const master = await fetchPlaylist(masterCandidate, baseHeaders);
                attempt.masterStatus = master.statusCode;
                attempt.masterContentType = master.headers?.['content-type'] || null;
                if (!master.body?.includes('#EXTM3U')) {
                    attempt.reason = `master not playlist (${(master.body || '').slice(0, 80)})`;
                    attempts.push(attempt);
                    continue;
                }

                const variantUris = master.body
                    .split(/\r?\n/)
                    .map(line => line.trim())
                    .filter(line => line && !line.startsWith('#') && line.includes('.m3u8'));

                if (variantUris.length === 0) {
                    attempt.reason = 'no video variants found in master';
                    attempts.push(attempt);
                    continue;
                }

                for (const rawVariantUri of variantUris) {
                    const variantUrl = new URL(rawVariantUri, masterCandidate).toString();
                    const variantAttempt = { ...attempt, variantUrl };

                    const variant = await fetchPlaylist(variantUrl, baseHeaders, masterCandidate);
                    variantAttempt.variantStatus = variant.statusCode;
                    variantAttempt.variantContentType = variant.headers?.['content-type'] || null;

                    if (!variant.body?.includes('#EXTM3U')) {
                        variantAttempt.reason = `variant not playlist (${(variant.body || '').slice(0, 80)})`;
                        attempts.push(variantAttempt);
                        continue;
                    }

                    const segmentUri = firstMediaSegmentUri(variant.body);
                    if (!segmentUri) {
                        variantAttempt.reason = 'no media segment in variant';
                        attempts.push(variantAttempt);
                        continue;
                    }

                    const segmentUrl = new URL(segmentUri, variantUrl).toString();
                    const segment = await fetchMediaRange(segmentUrl, baseHeaders, variantUrl);
                    const segmentPayload = Buffer.from(segment.body || '', 'utf8');
                    const segmentType = segment.headers?.['content-type'] || '';
                    const mediaOk = looksLikeMediaPayload(segmentPayload, segmentType);

                    variantAttempt.segmentUrl = segmentUrl;
                    variantAttempt.segmentStatus = segment.statusCode;
                    variantAttempt.segmentContentType = segmentType || null;
                    variantAttempt.segmentContentRange = segment.headers?.['content-range'] || null;

                    if (segment.statusCode === 206 && mediaOk) {
                        return {
                            provider: 'Netmirror',
                            ok: true,
                            streamsCount: streams.length,
                            elapsedMs: Date.now() - startedAt,
                            result: {
                                streamTitle: variantAttempt.streamTitle,
                                masterUrl: masterCandidate,
                                variantUrl,
                                segmentUrl,
                                statusCode: segment.statusCode,
                                contentType: segmentType,
                                contentRange: variantAttempt.segmentContentRange
                            }
                        };
                    }

                    variantAttempt.reason = `segment probe failed (${segment.statusCode})`;
                    attempts.push(variantAttempt);
                }
            } catch (error) {
                attempt.reason = error.message;
                attempts.push(attempt);
            }
        }
    }

    return {
        provider: 'Netmirror',
        ok: false,
        streamsCount: streams.length,
        elapsedMs: Date.now() - startedAt,
        reason: 'no HLS video variant produced a 206 media segment',
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
        const attemptsPreview = result.attempts.slice(0, 6);
        console.log(JSON.stringify(attemptsPreview, null, 2));
        if (result.attempts.length > attemptsPreview.length) {
            console.log(`... ${result.attempts.length - attemptsPreview.length} more attempts`);
        }
    }
}

async function main() {
    const results = [];

    results.push(await verifyDirectProvider('XDMovies', getXDMoviesStreams, TEST_MOVIE));
    results.push(await verifyNetmirror206(TEST_MOVIE));
    results.push(await verifyDirectProvider('MoviesMod', getMoviesModStreams, TEST_MOVIE));

    for (const result of results) {
        printResult(result);
    }

    const failed = results.filter(result => !result.ok);
    console.log(`\nSUMMARY: ${results.length - failed.length}/${results.length} providers passed strict 206 media verification`);
    if (failed.length > 0) {
        console.log(`FAILED: ${failed.map(result => result.provider).join(', ')}`);
        process.exit(1);
    }
}

main().catch(error => {
    console.error('[E2E-HTTP-206] Fatal error:', error);
    process.exit(1);
});
