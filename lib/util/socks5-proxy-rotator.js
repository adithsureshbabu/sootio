import axios from 'axios';
import { SocksProxyAgent } from 'socks-proxy-agent';

/**
 * SOCKS5 Proxy Rotator
 * Fetches a rotating list of free SOCKS5 proxies from TheSpeedX/PROXY-List
 * and cycles through them. Uses parallel racing for speed — fires multiple
 * proxy attempts concurrently and returns the first success.
 *
 * Key reliability feature: "known good" proxies that succeeded recently are
 * always included in every batch, dramatically improving hit rate.
 */

const PROXY_LIST_URL = 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt';
const FETCH_INTERVAL_MS = 10 * 60 * 1000; // Refresh list every 10 minutes
const MAX_FAILURES = 2; // Blacklist proxy after N consecutive failures
const PROXY_TIMEOUT_MS = 8000; // Connection timeout per proxy attempt
const MAX_RETRIES = 30; // Max proxies to try per request total
const PARALLEL_BATCH_SIZE = 30; // Fire this many proxies concurrently — first success wins
const MAX_PARALLEL_BATCHES = 2; // Two batches for reliability (60 proxies total)
const MIN_VALID_BODY_LENGTH = 500; // Reject responses with tiny bodies (proxy garbage)
const KNOWN_GOOD_MAX = 10; // Max recently-succeeded proxies to track
const KNOWN_GOOD_MAX_AGE_MS = 5 * 60 * 1000; // Expire known-good entries after 5 min

class Socks5ProxyRotator {
    constructor() {
        this.proxies = []; // Array of { url, ip, port, failures, lastUsed, agent }
        this.currentIndex = 0;
        this.lastFetch = 0;
        this.fetching = null; // Dedup concurrent fetches
        this.blacklist = new Set(); // Permanently failed proxies this session
        this.knownGood = []; // Recently successful proxies (front-loaded in every batch)
    }

    /**
     * Fetch and parse the SOCKS5 proxy list (ip:port per line)
     */
    async fetchProxies() {
        const now = Date.now();
        if (this.proxies.length > 0 && (now - this.lastFetch) < FETCH_INTERVAL_MS) {
            return this.proxies;
        }

        // Dedup concurrent fetches
        if (this.fetching) return this.fetching;

        this.fetching = (async () => {
            try {
                console.log('[SOCKS5Rotator] Fetching fresh SOCKS5 proxy list...');
                const response = await axios.get(PROXY_LIST_URL, { timeout: 15000 });
                const text = typeof response.data === 'string' ? response.data : String(response.data || '');
                const lines = text.trim().split('\n').map(l => l.trim()).filter(Boolean);

                if (lines.length === 0) {
                    console.warn('[SOCKS5Rotator] Empty proxy list');
                    return this.proxies;
                }

                // Parse ip:port lines and filter blacklisted
                const parsed = [];
                for (const line of lines) {
                    const match = line.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d{1,5})$/);
                    if (!match) continue;
                    const ip = match[1];
                    const port = parseInt(match[2], 10);
                    const key = `${ip}:${port}`;
                    if (this.blacklist.has(key)) continue;
                    parsed.push({
                        url: `socks5h://${ip}:${port}`,
                        ip,
                        port,
                        failures: 0,
                        lastUsed: 0,
                        agent: null
                    });
                }

                // Shuffle using Fisher-Yates for even distribution
                for (let i = parsed.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [parsed[i], parsed[j]] = [parsed[j], parsed[i]];
                }

                this.proxies = parsed;
                this.currentIndex = 0;
                this.lastFetch = Date.now();
                console.log(`[SOCKS5Rotator] Loaded ${this.proxies.length} SOCKS5 proxies`);
                return this.proxies;
            } catch (error) {
                console.error(`[SOCKS5Rotator] Failed to fetch proxy list: ${error.message}`);
                return this.proxies;
            } finally {
                this.fetching = null;
            }
        })();

        return this.fetching;
    }

    /**
     * Get the next N available proxies, skipping failed ones.
     * Known-good proxies are always front-loaded for reliability.
     */
    getNextProxies(count = 1) {
        if (this.proxies.length === 0) return [];

        const result = [];
        const resultKeys = new Set();

        // Front-load known-good proxies (recently successful)
        const now = Date.now();
        this.knownGood = this.knownGood.filter(p =>
            (now - p.lastUsed) < KNOWN_GOOD_MAX_AGE_MS && p.failures < MAX_FAILURES
        );
        for (const proxy of this.knownGood) {
            if (result.length >= count) break;
            const key = `${proxy.ip}:${proxy.port}`;
            if (!resultKeys.has(key) && proxy.failures < MAX_FAILURES) {
                // Reset agent for fresh connection each time
                proxy.agent = null;
                result.push(proxy);
                resultKeys.add(key);
            }
        }

        // Fill remaining slots from the general pool
        let scanned = 0;
        while (result.length < count && scanned < this.proxies.length) {
            const proxy = this.proxies[this.currentIndex];
            this.currentIndex = (this.currentIndex + 1) % this.proxies.length;
            scanned++;

            const key = `${proxy.ip}:${proxy.port}`;
            if (proxy.failures < MAX_FAILURES && !resultKeys.has(key)) {
                result.push(proxy);
                resultKeys.add(key);
            }
        }

        // If we couldn't find enough healthy proxies, reset and try again
        if (result.length === 0 && this.proxies.length > 0) {
            console.warn('[SOCKS5Rotator] All proxies exhausted, resetting failure counts');
            for (const proxy of this.proxies) {
                proxy.failures = 0;
                proxy.agent = null;
            }
            return this.proxies.slice(0, count);
        }

        return result;
    }

    /**
     * Get or create a SocksProxyAgent for a proxy entry
     */
    getAgent(proxy) {
        if (!proxy) return null;
        if (!proxy.agent) {
            const agent = new SocksProxyAgent(proxy.url);
            // Wrap connect() to inject rejectUnauthorized: false into TLS options.
            // Many free SOCKS5 proxies have stale CA bundles that reject valid certs
            // (e.g. Cloudflare edge certs). Passing the option to the constructor doesn't
            // propagate to the TLS socket — we must override connect() directly.
            const origConnect = agent.connect.bind(agent);
            agent.connect = async function (req, opts) {
                opts.rejectUnauthorized = false;
                return origConnect(req, opts);
            };
            proxy.agent = agent;
        }
        return proxy.agent;
    }

    reportSuccess(proxy) {
        if (!proxy) return;
        proxy.failures = 0;
        proxy.lastUsed = Date.now();
        // Add to known-good list (deduplicate)
        const key = `${proxy.ip}:${proxy.port}`;
        const existing = this.knownGood.findIndex(p => `${p.ip}:${p.port}` === key);
        if (existing >= 0) {
            this.knownGood[existing] = proxy;
        } else {
            this.knownGood.unshift(proxy); // Most recent first
            if (this.knownGood.length > KNOWN_GOOD_MAX) {
                this.knownGood.pop();
            }
        }
    }

    reportFailure(proxy) {
        if (!proxy) return;
        proxy.failures++;
        proxy.agent = null; // Force new agent on next use
        if (proxy.failures >= MAX_FAILURES) {
            this.blacklist.add(`${proxy.ip}:${proxy.port}`);
            // Remove from known-good if blacklisted
            const key = `${proxy.ip}:${proxy.port}`;
            this.knownGood = this.knownGood.filter(p => `${p.ip}:${p.port}` !== key);
        }
    }

    /**
     * Try a single proxy for a request. Returns { response, proxy } or throws.
     */
    async _tryProxy(proxy, axiosConfig) {
        const agent = this.getAgent(proxy);
        const config = {
            ...axiosConfig,
            httpAgent: agent,
            httpsAgent: agent,
            proxy: false,
            timeout: axiosConfig.timeout || PROXY_TIMEOUT_MS,
            validateStatus: () => true
        };

        const response = await axios.request(config);

        // Treat proxy-level errors as failures
        if (response.status === 407 || response.status === 502 || response.status === 504) {
            throw new Error(`Proxy returned status ${response.status}`);
        }

        // Reject suspiciously tiny responses — some SOCKS proxies return garbage
        const bodyStr = typeof response.data === 'string' ? response.data : String(response.data || '');
        if (bodyStr.length < MIN_VALID_BODY_LENGTH) {
            throw new Error(`Response too small (${bodyStr.length} bytes) — likely proxy garbage`);
        }

        return { response, proxy };
    }

    /**
     * Execute an axios request with proxy rotation.
     * Fires PARALLEL_BATCH_SIZE proxies concurrently — first success wins.
     * If the whole batch fails, tries the next batch. Up to MAX_PARALLEL_BATCHES.
     *
     * @param {Object} axiosConfig - Axios request config (url, headers, timeout, etc.)
     * @param {Object} options - { batchSize, maxBatches }
     * @returns {{ response, proxy }}
     * @throws Error if all proxies fail
     */
    async requestWithRotation(axiosConfig, options = {}) {
        await this.fetchProxies();

        const batchSize = options.batchSize || PARALLEL_BATCH_SIZE;
        const maxBatches = options.maxBatches || MAX_PARALLEL_BATCHES;
        const errors = [];

        for (let batch = 0; batch < maxBatches; batch++) {
            const proxies = this.getNextProxies(batchSize);
            if (proxies.length === 0) {
                throw new Error('[SOCKS5Rotator] No proxies available');
            }

            const knownGoodCount = this.knownGood.filter(p =>
                proxies.some(bp => bp.ip === p.ip && bp.port === p.port)
            ).length;
            if (knownGoodCount > 0) {
                console.log(`[SOCKS5Rotator] Batch ${batch + 1}/${maxBatches}: ${proxies.length} proxies (${knownGoodCount} known-good)`);
            }

            // Race all proxies in this batch — first success wins
            const promises = proxies.map(proxy =>
                this._tryProxy(proxy, axiosConfig)
                    .then(result => {
                        this.reportSuccess(result.proxy);
                        return result;
                    })
                    .catch(err => {
                        this.reportFailure(proxy);
                        const reason = err.code || err.message || 'unknown';
                        errors.push(`${proxy.ip}:${proxy.port} -> ${reason}`);
                        throw err; // Re-throw so Promise.any skips it
                    })
            );

            try {
                const result = await Promise.any(promises);
                console.log(`[SOCKS5Rotator] Request succeeded via ${result.proxy.ip}:${result.proxy.port} (batch ${batch + 1}/${maxBatches})`);
                return result;
            } catch {
                // All promises in this batch rejected
                console.warn(`[SOCKS5Rotator] Batch ${batch + 1}/${maxBatches} failed (${proxies.length} proxies)`);
            }
        }

        const totalAttempts = Math.min(errors.length, 8); // Truncate log
        const sample = errors.slice(0, totalAttempts).join('; ');
        throw new Error(`[SOCKS5Rotator] All ${errors.length} proxy attempts failed: ${sample}${errors.length > totalAttempts ? '...' : ''}`);
    }

    /**
     * Warmup: pre-validate proxies by making a lightweight request.
     * Populates the known-good list so the first real request doesn't cold-start.
     * Call this once at server startup (fire-and-forget).
     */
    async warmup(testUrl = 'https://www.google.com/') {
        try {
            await this.fetchProxies();
            if (this.proxies.length === 0) return;
            console.log('[SOCKS5Rotator] Warming up — finding working proxies...');
            const { proxy } = await this.requestWithRotation({
                method: 'GET',
                url: testUrl,
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0' },
                timeout: 10000,
                maxRedirects: 5
            });
            console.log(`[SOCKS5Rotator] Warmup complete — ${this.knownGood.length} known-good proxies`);
        } catch (e) {
            console.warn(`[SOCKS5Rotator] Warmup failed: ${e.message}`);
        }
    }

    /**
     * Get stats about the proxy pool
     */
    getStats() {
        const total = this.proxies.length;
        const healthy = this.proxies.filter(p => p.failures < MAX_FAILURES).length;
        const blacklisted = this.blacklist.size;
        const knownGood = this.knownGood.length;
        return { total, healthy, blacklisted, knownGood, lastFetch: this.lastFetch };
    }
}

// Singleton instance
const socks5ProxyRotator = new Socks5ProxyRotator();

export default socks5ProxyRotator;
export { Socks5ProxyRotator, MAX_RETRIES, PROXY_TIMEOUT_MS };
