/**
 * HTTP request utilities for HTTP streams
 * Handles HTTP/HTTPS requests with retry logic and domain caching
 */

import https from 'https';
import http from 'http';
import { URL } from 'url';
import * as cheerio from 'cheerio';
import debridProxyManager from '../../util/debrid-proxy.js';

// Configuration
const DOMAINS_URL = 'https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json';
// PERFORMANCE FIX: Add domain cache with TTL to avoid stale domains
const DOMAIN_CACHE_TTL_MS = parseInt(process.env.DOMAIN_CACHE_TTL_MS) || 60000; // 1 minute default
// Safety: hard cap the amount of response data we buffer to avoid downloading whole video files into memory
const DEFAULT_MAX_BODY_SIZE = parseInt(process.env.HTTP_RESPONSE_MAX_BYTES || '2097152', 10); // 2MB default
let cachedDomains = null;
let domainCacheTimestamp = null;

/**
 * Makes an HTTP/HTTPS request with retry logic
 * @param {string} url - URL to request
 * @param {Object} options - Request options
 * @param {string} options.method - HTTP method
 * @param {Object} options.headers - Request headers
 * @param {boolean} options.allowRedirects - Whether to follow redirects
 * @param {boolean} options.parseHTML - Whether to parse response as HTML
 * @param {number} options.maxBodySize - Max bytes to buffer before aborting (defaults to HTTP_RESPONSE_MAX_BYTES or 2MB)
 * @param {AbortSignal} options.signal - Abort signal for request cancellation
 * @returns {Promise<{statusCode: number, headers: Object, body: string, document: Object|null, url: string}>}
 */
export function makeRequest(url, options = {}) {
    // Default timeout configuration (shorter to stay well under 45s global timeout)
    const DEFAULT_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT) || 8000; // 8 seconds default
    const MAX_RETRIES = typeof options.maxRetries === 'number'
        ? options.maxRetries
        : (parseInt(process.env.REQUEST_MAX_RETRIES) || 1); // 1 retry by default
    const RETRY_DELAY = typeof options.retryDelay === 'number'
        ? options.retryDelay
        : (parseInt(process.env.REQUEST_RETRY_DELAY) || 800); // 0.8 second delay
    const requestTimeout = typeof options.timeout === 'number' ? options.timeout : DEFAULT_TIMEOUT;
    const maxBodySize = typeof options.maxBodySize === 'number'
        ? options.maxBodySize
        : DEFAULT_MAX_BODY_SIZE;

    const requestOnce = () => new Promise((resolve, reject) => {
        let settled = false;
        let req = null;
        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            if (options.signal) {
                options.signal.removeEventListener('abort', onAbort);
            }
            fn(value);
        };

        const onAbort = () => {
            const abortError = new Error('Request aborted');
            if (req) req.destroy();
            finish(reject, abortError);
        };

        try {
            const urlObj = new URL(url);
            const protocol = urlObj.protocol === 'https:' ? https : http;

            const requestOptions = {
                hostname: urlObj.hostname,
                port: urlObj.port,
                path: urlObj.pathname + urlObj.search,
                method: options.method || 'GET',
                timeout: requestTimeout,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    ...options.headers
                }
            };

            // Add proxy agent if configured for http-streams
            const proxyAgent = debridProxyManager.getProxyAgent('httpstreams');
            if (proxyAgent) {
                requestOptions.agent = proxyAgent;
            }

            req = protocol.request(requestOptions, (res) => {
                // Handle redirects automatically if not explicitly disabled
                if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) &&
                    res.headers.location && options.allowRedirects !== false) {
                    const redirectUrl = new URL(res.headers.location, url).toString();
                    console.log(`Following redirect from ${url} to ${redirectUrl}`);
                    res.destroy();
                    finish(resolve, makeRequest(redirectUrl, options));
                    return;
                }

                // Use Buffer.concat for large responses to avoid string length limits
                const chunks = [];
                let receivedBytes = 0;
                let abortedForSize = false;

                res.on('data', chunk => {
                    if (abortedForSize || settled) return;

                    receivedBytes += chunk.length;
                    if (receivedBytes > maxBodySize) {
                        abortedForSize = true;
                        const sizeError = new Error(`Response exceeded max body size (${maxBodySize} bytes) for ${url}`);
                        res.destroy();
                        req.destroy();
                        finish(reject, sizeError);
                        return;
                    }
                    chunks.push(chunk);
                });
                res.on('end', () => {
                    if (abortedForSize || settled) return;
                    try {
                        const buffer = Buffer.concat(chunks);
                        const data = buffer.toString('utf8');
                        chunks.length = 0; // Release buffered chunks promptly
                        finish(resolve, {
                            statusCode: res.statusCode,
                            headers: res.headers,
                            body: data,
                            document: options.parseHTML ? cheerio.load(data) : null,
                            url: res.headers.location || url // Track final URL if redirected
                        });
                    } catch (err) {
                        finish(reject, new Error(`Failed to process response: ${err.message}`));
                    }
                });
            });

            // Add abort signal support if provided
            if (options.signal) {
                if (options.signal.aborted) {
                    onAbort();
                    req.destroy();
                    return;
                }
                options.signal.addEventListener('abort', onAbort, { once: true });
            }

            req.on('error', (err) => {
                req.destroy();
                finish(reject, err);
            });

            req.on('timeout', () => {
                req.destroy();
                finish(reject, new Error(`Request timeout after ${requestTimeout}ms for ${url}`));
            });

            req.end();
        } catch (err) {
            finish(reject, err);
        }
    });

    return (async () => {
        let lastError;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            try {
                return await requestOnce();
            } catch (err) {
                lastError = err;
                if (attempt < MAX_RETRIES) {
                    console.log(`Request attempt ${attempt + 1} failed for ${url}, retrying in ${RETRY_DELAY}ms... Error: ${err.message}`);
                    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
                    continue;
                }
            }
        }
        throw lastError;
    })();
}

/**
 * Fetches and caches domain configuration
 * @returns {Promise<Object|null>} Domain configuration object
 */
export function getDomains() {
    // PERFORMANCE FIX: Check if cached domains are still valid (within TTL)
    const now = Date.now();
    if (cachedDomains && domainCacheTimestamp && (now - domainCacheTimestamp < DOMAIN_CACHE_TTL_MS)) {
        console.log(`[4KHDHub] Using cached domains (age: ${Math.floor((now - domainCacheTimestamp) / 1000)}s)`);
        return Promise.resolve(cachedDomains);
    }

    console.log(`[4KHDHub] Fetching fresh domains from ${DOMAINS_URL}`);
    return makeRequest(DOMAINS_URL)
        .then(response => {
            cachedDomains = JSON.parse(response.body);
            domainCacheTimestamp = Date.now();
            console.log(`[4KHDHub] Domains cached successfully`);
            return cachedDomains;
        })
        .catch(error => {
            console.error('Failed to fetch domains:', error.message);
            // Return stale cache if available, otherwise null
            if (cachedDomains) {
                console.log(`[4KHDHub] Using stale cached domains due to fetch error`);
                return cachedDomains;
            }
            return null;
        });
}
