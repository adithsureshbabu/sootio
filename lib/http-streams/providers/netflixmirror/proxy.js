import axios from 'axios';
import { getAuthStreamHeaders } from './search.js';

export const NETFLIXMIRROR_PROVIDER = 'netflixmirror';

export function buildNetflixMirrorProxyUrl(url, baseUrl, resolverBase) {
    try {
        const resolved = new URL(url, baseUrl).toString();
        return `${resolverBase}/resolve/httpstreaming/${encodeURIComponent(resolved)}?provider=${NETFLIXMIRROR_PROVIDER}`;
    } catch {
        return url;
    }
}

export function rewriteNetflixMirrorPlaylist(playlistText, baseUrl, resolverBase) {
    return playlistText
        .split(/\r?\n/)
        .map(line => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) return line;
            if (trimmed.includes('/resolve/httpstreaming/')) return line;
            return buildNetflixMirrorProxyUrl(trimmed, baseUrl, resolverBase);
        })
        .join('\n');
}

export async function proxyNetflixMirror(targetUrl, req, res, resolverBaseOverride) {
    const resolverBase = resolverBaseOverride || `${req.protocol}://${req.get('host')}`;
    try {
        const headers = { ...(await getAuthStreamHeaders()) };
        if (req.headers.range) {
            headers.Range = req.headers.range;
        }

        const response = await axios.get(targetUrl, {
            responseType: 'arraybuffer',
            headers,
            validateStatus: () => true
        });

        const contentType = (response.headers && response.headers['content-type']) || '';
        const isPlaylist = contentType.includes('mpegurl') || targetUrl.includes('.m3u8');
        const statusCode = response.status || 200;

        if (isPlaylist) {
            const text = response.data.toString('utf8');
            const rewritten = rewriteNetflixMirrorPlaylist(text, targetUrl, resolverBase);
            res.status(statusCode).setHeader('content-type', 'application/vnd.apple.mpegurl');
            return res.send(rewritten);
        }

        res.status(statusCode);
        Object.entries(response.headers || {}).forEach(([key, value]) => {
            res.setHeader(key, value);
        });
        return res.send(response.data);
    } catch (error) {
        console.error(`[HTTP-RESOLVER] NetflixMirror proxy failed: ${error.message}`);
        return res.status(502).send('Failed to proxy NetflixMirror stream');
    }
}
