/**
 * NetflixMirror proxy helpers
 * - Builds proxied URLs pointing back to the addon resolver
 * - Rewrites playlists so every fetch goes through the proxy
 * - Detects mislabeled segment payloads (e.g., .js served as TS)
 */

import { URL } from 'url';

export const NETFLIXMIRROR_SEGMENT_SUFFIX = '__nfmts';

function normalizeResolverBase(resolverBase = '') {
    if (!resolverBase || typeof resolverBase !== 'string') return '';
    return resolverBase.replace(/\/+$/, '');
}

export function stripNetflixMirrorSegmentSuffix(url = '') {
    if (!url || typeof url !== 'string') return url;
    return url.endsWith(NETFLIXMIRROR_SEGMENT_SUFFIX)
        ? url.slice(0, -NETFLIXMIRROR_SEGMENT_SUFFIX.length)
        : url;
}

export function buildNetflixMirrorProxyUrl(target, playlistUrl, resolverBase) {
    if (!target) return target;

    const normalizedResolver = normalizeResolverBase(resolverBase);
    if (normalizedResolver && target.startsWith(normalizedResolver)) {
        return target;
    }

    let resolved;
    try {
        resolved = new URL(target, playlistUrl).toString();
    } catch {
        resolved = target;
    }

    if (!normalizedResolver) return resolved;

    const needsSegmentSuffix = resolved.toLowerCase().endsWith('.js');
    const encoded = encodeURIComponent(resolved);
    const suffix = needsSegmentSuffix ? NETFLIXMIRROR_SEGMENT_SUFFIX : '';
    return `${normalizedResolver}/resolve/httpstreaming/${encoded}${suffix}?provider=netflixmirror`;
}

function rewriteTagLine(line, playlistUrl, resolverBase) {
    return line.replace(/(URI=)(\"?)([^\",]+)(\"?)/i, (_, prefix, _quote, uri) => {
        const proxied = buildNetflixMirrorProxyUrl(uri, playlistUrl, resolverBase);
        return `${prefix}"${proxied}"`;
    });
}

export function rewriteNetflixMirrorPlaylist(playlistText, playlistUrl, resolverBase) {
    if (!playlistText) return playlistText;

    const normalizedResolver = normalizeResolverBase(resolverBase);
    const lines = playlistText.split('\n');

    const rewritten = lines.map(line => {
        const trimmed = line.trim();
        if (!trimmed) return line;

        // Leave already proxied lines untouched
        if (normalizedResolver && trimmed.includes(normalizedResolver)) {
            return line;
        }

        if (trimmed.startsWith('#EXT-X-KEY') || trimmed.startsWith('#EXT-X-MAP') || trimmed.startsWith('#EXT-X-MEDIA')) {
            return rewriteTagLine(line, playlistUrl, normalizedResolver);
        }

        if (trimmed.startsWith('#')) {
            return line;
        }

        // Segment or nested playlist URL
        return buildNetflixMirrorProxyUrl(trimmed, playlistUrl, normalizedResolver);
    });

    return rewritten.join('\n');
}

export function detectNetflixMirrorPayloadType(payload, originalContentType = 'application/octet-stream') {
    try {
        if (payload && payload.length >= 188) {
            const syncByte = 0x47;
            const hasSync = payload[0] === syncByte && payload[188] === syncByte;
            if (hasSync) {
                return 'video/mp2t';
            }
        }
    } catch {
        // fall through to original content type
    }
    return originalContentType;
}
