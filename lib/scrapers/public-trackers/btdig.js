import * as cheerio from 'cheerio';
import * as config from '../../config.js';
import { getHashFromMagnet, sizeToBytes } from '../../common/torrent-utils.js';
import proxyManager from '../../util/proxy-manager.js';
import * as SqliteCache from '../../util/cache-store.js';
import { exec } from 'child_process';
import { promisify } from 'util';

// Import scraper utilities
import { createTimerLabel } from '../utils/timing.js';
import { detectSimpleLangs } from '../utils/filtering.js';
import { processAndDeduplicate } from '../utils/deduplication.js';
import { handleScraperError } from '../utils/error-handling.js';
import { generateScraperCacheKey } from '../utils/cache.js';
import socks5ProxyRotator from '../../util/socks5-proxy-rotator.js';
import { solveAndCache } from '../utils/cf-cookie-manager.js';

// Keep a stable reference to env config for fallbacks when user config is partial
const ENV = config;

const execPromise = promisify(exec);
const inFlightRequests = new Map();
let curlCheckPromise = null;
let warnedNoCurl = false;

async function hasCurl() {
    if (!curlCheckPromise) {
        curlCheckPromise = execPromise('command -v curl')
            .then(() => true)
            .catch(() => false);
    }
    return curlCheckPromise;
}

// Lazy puppeteer singleton — only loaded when BTDIG_PROXY is configured
let _puppeteerExtra = null;
async function getPuppeteer() {
    if (_puppeteerExtra) return _puppeteerExtra;
    try {
        const { default: puppeteer } = await import('puppeteer-extra');
        const { default: StealthPlugin } = await import('puppeteer-extra-plugin-stealth');
        puppeteer.use(StealthPlugin());
        _puppeteerExtra = puppeteer;
    } catch (e) {
        return null;
    }
    return _puppeteerExtra;
}

async function findChromiumPath() {
    const envPath = process.env.CHROMIUM_PATH;
    if (envPath) return envPath;
    for (const p of ['/snap/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/chromium']) {
        try { await execPromise(`test -x "${p}"`); return p; } catch (_) {}
    }
    return undefined; // puppeteer will use its bundled Chrome
}

// Fetch multiple pages using a stealth Puppeteer browser routed through a SOCKS5 proxy.
// Returns an array of HTML strings, one per URL (may stop early if no results on a page).
async function fetchPagesViaStealth(urls, proxyUrl) {
    const puppeteer = await getPuppeteer();
    if (!puppeteer) throw new Error('puppeteer-extra not available');
    const executablePath = await findChromiumPath();
    const browser = await puppeteer.launch({
        ...(executablePath ? { executablePath } : {}),
        headless: true,
        args: [
            `--proxy-server=${proxyUrl}`,
            '--ignore-certificate-errors',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-first-run',
            '--disable-blink-features=AutomationControlled',
        ],
        timeout: 30000
    });
    const htmlPages = [];
    try {
        for (const url of urls) {
            const page = await browser.newPage();
            try {
                page.setDefaultNavigationTimeout(25000);
                await page.setViewport({ width: 1280, height: 800 });
                await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0');
                await page.goto(url, { waitUntil: 'domcontentloaded' });
                const html = await page.content();
                htmlPages.push(html);
                if (!html.includes('one_result')) break; // no results on this page, stop paginating
            } finally {
                await page.close();
            }
        }
    } finally {
        await browser.close();
    }
    return htmlPages;
}

export async function searchBtdig(query, signal, logPrefix, config) {
    const scraperName = 'BTDigg';
    const sfx = (config?.Languages && config.Languages.length) ? `:${config.Languages[0]}` : ':none';
    const timerLabel = createTimerLabel(logPrefix, scraperName, sfx);
    console.time(timerLabel);

    const cacheKey = generateScraperCacheKey(scraperName, query, config);
    const cachedResult = await SqliteCache.getCachedRecord('scraper', cacheKey);
    const cached = cachedResult?.data || null;

    if (cached && Array.isArray(cached)) {
        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${cached.length} results from cache.`);
        console.timeEnd(timerLabel);
        return cached;
    }

    const existingPromise = inFlightRequests.get(cacheKey);
    if (existingPromise) {
        console.log(`[${logPrefix} SCRAPER] ${scraperName} awaiting in-flight request for ${cacheKey}`);
        try {
            return await existingPromise;
        } finally {
            console.timeEnd(timerLabel);
        }
    }

    let cookieFile = null;
    let isOwner = false;

    const scrapePromise = (async () => {
        const limit = config?.BTDIG_LIMIT ?? ENV.BTDIG_LIMIT ?? 50;
        const maxPages = config?.BTDIG_MAX_PAGES ?? ENV.BTDIG_MAX_PAGES ?? 5;
        const base = ((config?.BTDIG_URL || ENV.BTDIG_URL) || 'https://btdig.com').replace(/\/$/, '');
        const timeout = config?.SCRAPER_TIMEOUT ?? ENV.SCRAPER_TIMEOUT;
        const useProxies = config?.BTDIG_USE_PROXIES ?? ENV.BTDIG_USE_PROXIES ?? false;
        const flareSolverrUrl = config?.FLARESOLVERR_URL || ENV.FLARESOLVERR_URL || '';
        const stealthProxy = (config?.BTDIG_PROXY || ENV.BTDIG_PROXY || '').replace(/^socks5h:\/\//, 'socks5://');
        const domain = new URL(base).hostname;
        const curlAvailable = await hasCurl();
        if (!curlAvailable) {
            if (!warnedNoCurl) {
                console.warn(`[${logPrefix} SCRAPER] ${scraperName} requires curl; it is not installed. Skipping scraper.`);
                warnedNoCurl = true;
            }
            return [];
        }

        // Check for abort signal
        if (signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
        }

        // Log proxy usage
        if (useProxies) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} using rotating proxies`);
            const stats = proxyManager.getStats();
            console.log(`[${logPrefix} SCRAPER] ${scraperName} proxy stats:`, stats);
        }

        // Build URLs for all pages with order=0 parameter (sort by relevance)
        const pageUrls = Array.from({ length: maxPages }, (_, page) =>
            page === 0
                ? `${base}/search?q=${encodeURIComponent(query)}&order=0`
                : `${base}/search?q=${encodeURIComponent(query)}&p=${page}&order=0`
        );

        const batchSize = 2;
        const batchDelayMs = 1000;

        function generateRandomUserAgent() {
            const firefoxVersions = ['138.0', '139.0', '140.0', '141.0'];
            const platforms = [
                'Macintosh; Intel Mac OS X 10.15',
                'Macintosh; Intel Mac OS X 14.1',
                'Windows NT 10.0; Win64; x64',
                'X11; Linux x86_64',
                'X11; Ubuntu; Linux x86_64'
            ];
            const version = firefoxVersions[Math.floor(Math.random() * firefoxVersions.length)];
            const platform = platforms[Math.floor(Math.random() * platforms.length)];
            return `Mozilla/5.0 (${platform}; rv:${version}) Gecko/20100101 Firefox/${version}`;
        }

        cookieFile = `/tmp/btdig-cookies-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`;
        const perRequestTimeout = Math.max(timeout || 10000, maxPages * 2000);
        const curlExecOptions = { timeout: perRequestTimeout };

        async function fetchPage(url, index, directProxy = null) {
            const userAgent = generateRandomUserAgent();
            let proxy = null;
            if (directProxy) {
                proxy = directProxy;
            } else if (useProxies) {
                proxy = await proxyManager.getNextProxy();
            }

            const prevPageReferer = index === 1
                ? `${base}/search?q=${encodeURIComponent(query)}&order=0`
                : `${base}/search?q=${encodeURIComponent(query)}&p=${index - 1}&order=0`;

            const escapedUrl = url.replace(/'/g, "'\\''");
            const escapedUserAgent = userAgent.replace(/'/g, "'\\''");
            const escapedCookieFile = cookieFile.replace(/'/g, "'\\''");
            const escapedReferer = prevPageReferer.replace(/'/g, "'\\''");

            let proxyArg = '';
            if (proxy) {
                const escapedProxy = proxy.replace(/'/g, "'\\''");
                if (proxy.startsWith('socks')) {
                    proxyArg = `--socks5 '${escapedProxy.replace('socks5://', '')}'`;
                } else {
                    proxyArg = `-x '${escapedProxy}'`;
                }
            }

            const curlCmd = index === 0
                ? `curl -s -L --connect-timeout 5 ${proxyArg} -c '${escapedCookieFile}' -H 'User-Agent: ${escapedUserAgent}' -H 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' -H 'Accept-Language: en-US,en;q=0.5' -H 'Accept-Encoding: gzip, deflate, br, zstd' -H 'DNT: 1' -H 'Connection: keep-alive' -H 'Upgrade-Insecure-Requests: 1' -H 'Sec-Fetch-Dest: document' -H 'Sec-Fetch-Mode: navigate' -H 'Sec-Fetch-Site: none' -H 'Sec-Fetch-User: ?1' -H 'Priority: u=0, i' -H 'TE: trailers' --compressed '${escapedUrl}'`
                : `curl -s -L --connect-timeout 5 ${proxyArg} -b '${escapedCookieFile}' -c '${escapedCookieFile}' -H 'User-Agent: ${escapedUserAgent}' -H 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' -H 'Accept-Language: en-US,en;q=0.5' -H 'Accept-Encoding: gzip, deflate, br, zstd' -H 'DNT: 1' -H 'Connection: keep-alive' -H 'Upgrade-Insecure-Requests: 1' -H 'Sec-Fetch-Dest: document' -H 'Sec-Fetch-Mode: navigate' -H 'Sec-Fetch-Site: same-origin' -H 'Sec-Fetch-User: ?1' -H 'Referer: ${escapedReferer}' -H 'Priority: u=0, i' -H 'TE: trailers' --compressed '${escapedUrl}'`;

            try {
                const { stdout } = await execPromise(curlCmd, curlExecOptions);
                if (proxy) proxyManager.markSuccess(proxy);
                return { pageNum: index + 1, html: stdout };
            } catch (error) {
                if (proxy) proxyManager.markFailure(proxy);
                const stderr = error.stderr ? String(error.stderr).trim() : '';
                const stdout = error.stdout ? String(error.stdout).trim() : '';
                const exitCode = error.code || 'unknown';
                const errorMsg = stderr || stdout || error.message || 'Unknown error';
                const proxyInfo = proxy ? ` via proxy ${proxy}` : '';
                console.log(`[${logPrefix} SCRAPER] ${scraperName} page ${index + 1} failed${proxyInfo} (exit code: ${exitCode}): ${errorMsg}`);

                if (proxy && (exitCode === 5 || exitCode === 7 || exitCode === 35 || exitCode === 28 || exitCode === 56)) {
                    console.log(`[${logPrefix} SCRAPER] ${scraperName} retrying page ${index + 1} without proxy...`);
                    const curlCmdNoproxy = curlCmd.replace(proxyArg, '').replace(/  +/g, ' ');
                    try {
                        const { stdout: retryStdout } = await execPromise(curlCmdNoproxy, curlExecOptions);
                        return { pageNum: index + 1, html: retryStdout };
                    } catch (_) {
                        return { pageNum: index + 1, html: null };
                    }
                }
                return { pageNum: index + 1, html: null };
            }
        }

        // Helper: fetch a page via SOCKS5 proxy rotation (axios-based)
        async function fetchPageViaRotation(url, index) {
            const { response } = await socks5ProxyRotator.requestWithRotation({
                method: 'GET',
                url,
                responseType: 'text',
                timeout: 8000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.5',
                    'Referer': index === 0 ? base : pageUrls[index - 1]
                }
            }, { batchSize: 20, maxBatches: 1 }); // Single fast batch — don't spend too long
            const html = typeof response.data === 'string' ? response.data : String(response.data || '');
            return { pageNum: index + 1, html };
        }

        // Helper: check if HTML is a CAPTCHA page
        function isCaptchaPage(html) {
            return html.includes('security check') || html.includes('g-recaptcha') || html.includes('One more step');
        }

        let page1Html = '';
        let isSiteDead = false;
        let isCfBlocked = false;
        let usingRotation = false;
        let usingFlare = false;
        let usingStealthBrowser = false;
        const allPageResults = [];

        if (stealthProxy) {
            // When BTDIG_PROXY is set, first try fast curl via the proxy.
            // If curl succeeds (proxy IP not blocked), skip the slow stealth browser entirely.
            // Only fall back to stealth browser if curl is blocked/fails.
            console.log(`[${logPrefix} SCRAPER] ${scraperName} probing via BTDIG_PROXY (curl)`);
            const page1Result = await fetchPage(pageUrls[0], 0, stealthProxy);
            page1Html = page1Result.html || '';
            const curlDead = !page1Html || page1Html.includes('Welcome to nginx');
            const curlCf = page1Html.includes('Just a moment') || page1Html.includes('cf-browser-verification');
            const curlCaptcha = isCaptchaPage(page1Html);

            if (!curlDead && !curlCf && !curlCaptcha) {
                // Curl via proxy worked — fetch remaining pages the same way
                console.log(`[${logPrefix} SCRAPER] ${scraperName} curl via BTDIG_PROXY succeeded`);
                allPageResults[0] = page1Result;
                usingRotation = true;
                if (page1Html.includes('one_result') && maxPages > 1) {
                    for (let batchStart = 1; batchStart < pageUrls.length; batchStart += batchSize) {
                        if (signal?.aborted) break;
                        await new Promise(resolve => setTimeout(resolve, batchDelayMs));
                        const batchEnd = Math.min(batchStart + batchSize, pageUrls.length);
                        const batchResults = await Promise.all(
                            Array.from({ length: batchEnd - batchStart }, (_, k) =>
                                fetchPage(pageUrls[batchStart + k], batchStart + k, stealthProxy))
                        );
                        allPageResults.push(...batchResults);
                        if (!batchResults.some(r => r.html?.includes('one_result'))) break;
                    }
                }
            } else {
                // Curl blocked — fall back to stealth browser
                const reason = curlDead ? 'dead' : curlCf ? 'CF-blocked' : 'CAPTCHA';
                console.log(`[${logPrefix} SCRAPER] ${scraperName} curl via proxy got ${reason}, trying stealth browser`);
                try {
                    const htmlPages = await fetchPagesViaStealth(pageUrls, stealthProxy);
                    for (let i = 0; i < htmlPages.length; i++) {
                        const html = htmlPages[i];
                        const isCaptcha = html.includes('g-recaptcha') || html.includes('One more step') || html.includes('security check');
                        const isDead = !html || html.includes('Welcome to nginx');
                        allPageResults[i] = { pageNum: i + 1, html: (!isCaptcha && !isDead) ? html : null };
                        if (i === 0) {
                            page1Html = (!isCaptcha && !isDead) ? html : '';
                            usingStealthBrowser = !isCaptcha && !isDead;
                        }
                    }
                    if (usingStealthBrowser) {
                        console.log(`[${logPrefix} SCRAPER] ${scraperName} stealth browser succeeded (${htmlPages.length} page(s))`);
                    } else {
                        console.log(`[${logPrefix} SCRAPER] ${scraperName} stealth browser got CAPTCHA or no content`);
                        isSiteDead = true;
                    }
                } catch (stealthErr) {
                    console.log(`[${logPrefix} SCRAPER] ${scraperName} stealth browser error: ${stealthErr.message}`);
                    isSiteDead = true;
                }
            }
        } else {
            // No proxy configured — fall back to curl probe + SOCKS5 rotation + FlareSolverr
            console.log(`[${logPrefix} SCRAPER] ${scraperName} probing page 1...`);
            const page1Result = await fetchPage(pageUrls[0], 0);
            allPageResults[0] = page1Result;
            page1Html = page1Result.html || '';
            isSiteDead = !page1Html ||
                page1Html.includes('Welcome to nginx') ||
                page1Html.includes('<title>Welcome to nginx</title>');
            isCfBlocked = page1Html.includes('Just a moment') ||
                page1Html.includes('cf-browser-verification');

            // Tier 2: SOCKS5 rotation — bypasses geo-restrictions
            let rotationProxy = null;
            if (isSiteDead || isCfBlocked) {
                const reason = isSiteDead ? 'dead (nginx)' : 'Cloudflare-blocked';
                console.log(`[${logPrefix} SCRAPER] ${scraperName} direct probe ${reason}, trying SOCKS5 rotation`);
                try {
                    const rotResult = await fetchPageViaRotation(pageUrls[0], 0);
                    const rotHtml = rotResult.html || '';
                    const rotDead = !rotHtml || rotHtml.includes('Welcome to nginx');
                    const rotCf = rotHtml.includes('Just a moment') || rotHtml.includes('cf-browser-verification');
                    const rotCaptcha = isCaptchaPage(rotHtml);
                    if (!rotDead && !rotCf && !rotCaptcha) {
                        console.log(`[${logPrefix} SCRAPER] ${scraperName} SOCKS5 rotation succeeded for page 1`);
                        allPageResults[0] = rotResult;
                        page1Html = rotHtml;
                        usingRotation = true;
                    } else {
                        const rotReason = rotDead ? 'dead' : rotCf ? 'CF-blocked' : 'CAPTCHA';
                        console.log(`[${logPrefix} SCRAPER] ${scraperName} SOCKS5 rotation got ${rotReason}, will retry via FlareSolverr+proxy`);
                    }
                } catch (rotErr) {
                    console.log(`[${logPrefix} SCRAPER] ${scraperName} SOCKS5 rotation failed: ${rotErr.message.slice(0, 120)}`);
                }

                if (!usingRotation && flareSolverrUrl) {
                    await socks5ProxyRotator.fetchProxies();
                    const candidates = socks5ProxyRotator.getNextProxies(1);
                    rotationProxy = candidates[0] || null;
                    if (rotationProxy) {
                        console.log(`[${logPrefix} SCRAPER] ${scraperName} will route FlareSolverr through ${rotationProxy.ip}:${rotationProxy.port}`);
                    }
                }
            }

            // Tier 3: FlareSolverr + SOCKS5 proxy
            if (!usingRotation && flareSolverrUrl && (isSiteDead || isCfBlocked || rotationProxy)) {
                console.log(`[${logPrefix} SCRAPER] ${scraperName} trying FlareSolverr${rotationProxy ? '+proxy' : ''} for page 1`);
                try {
                    const proxyUrl = rotationProxy?.url?.replace(/^socks5h:\/\//, 'socks5://');
                    const flareOptions = proxyUrl ? { proxy: { url: proxyUrl } } : {};
                    const flareTimeout = Math.min(perRequestTimeout, 30000);
                    const flareResult = await solveAndCache(domain, pageUrls[0], flareSolverrUrl, flareTimeout, logPrefix, scraperName, flareOptions);
                    const flareBody = flareResult?.body || '';
                    const flareIsError = !flareBody ||
                        flareBody.includes('Welcome to nginx') ||
                        (flareBody.includes('--background-color') && flareBody.includes('--google-blue'));
                    if (flareResult?.body && !isCaptchaPage(flareBody) && !flareIsError) {
                        console.log(`[${logPrefix} SCRAPER] ${scraperName} FlareSolverr succeeded for page 1`);
                        allPageResults[0] = { pageNum: 1, html: flareBody };
                        page1Html = flareBody;
                        usingFlare = true;
                        if (rotationProxy) socks5ProxyRotator.reportSuccess(rotationProxy);
                    } else {
                        console.log(`[${logPrefix} SCRAPER] ${scraperName} FlareSolverr returned CAPTCHA or no content`);
                        if (rotationProxy) socks5ProxyRotator.reportFailure(rotationProxy);
                    }
                } catch (flareErr) {
                    console.log(`[${logPrefix} SCRAPER] ${scraperName} FlareSolverr error: ${flareErr.message}`);
                    if (rotationProxy) socks5ProxyRotator.reportFailure(rotationProxy);
                }
            }
        }

        const siteAccessible = usingRotation || usingFlare || usingStealthBrowser || (!isSiteDead && !isCfBlocked);

        if (!siteAccessible) {
            if (isSiteDead) {
                console.log(`[${logPrefix} SCRAPER] ${scraperName} site appears dead (nginx welcome page), aborting`);
            } else if (isCfBlocked) {
                console.log(`[${logPrefix} SCRAPER] ${scraperName} blocked by Cloudflare, aborting`);
            }
        } else if (page1Html.includes('one_result') && maxPages > 1 && !usingStealthBrowser && !stealthProxy) {
            // Site is alive and has results — fetch remaining pages.
            // (Stealth browser already fetched all pages in one session, so skip when using it.)
            const method = usingRotation ? ' (via rotation)' : usingFlare ? ' (via FlareSolverr)' : '';
            console.log(`[${logPrefix} SCRAPER] ${scraperName} site alive${method}, fetching remaining ${maxPages - 1} pages...`);
            for (let batchStart = 1; batchStart < pageUrls.length; batchStart += batchSize) {
                if (signal?.aborted) break;
                await new Promise(resolve => setTimeout(resolve, batchDelayMs));
                const batchEnd = Math.min(batchStart + batchSize, pageUrls.length);
                const batchPromises = [];
                for (let i = batchStart; i < batchEnd; i++) {
                    batchPromises.push(usingRotation
                        ? fetchPageViaRotation(pageUrls[i], i)
                        : fetchPage(pageUrls[i], i));
                }
                const batchResults = await Promise.all(batchPromises);
                allPageResults.push(...batchResults);
            }
        }

        const pageResults = allPageResults;

        // Process all page results
        const results = [];
        const seen = new Set();
        let captchaDetected = false;

        for (const { pageNum, html } of pageResults) {
            if (!html || results.length >= limit) continue;

            const $ = cheerio.load(html);

            // Detect CAPTCHA page
            if (html.includes('security check') || html.includes('g-recaptcha') || html.includes('One more step')) {
                console.log(`[${logPrefix} SCRAPER] ${scraperName} CAPTCHA detected on page ${pageNum}. BTDigg has anti-bot protection enabled.`);
                captchaDetected = true;
                continue;
            }

            const resultDivs = $('.one_result');

            if (resultDivs.length === 0) {
                console.log(`[${logPrefix} SCRAPER] ${scraperName} no results found on page ${pageNum}.`);
                continue;
            }

            resultDivs.each((i, el) => {
                if (results.length >= limit) return false;

                try {
                    // Extract title
                    const titleLink = $(el).find('.torrent_name a');
                    const title = titleLink.text().trim();

                    // Extract magnet link
                    const magnetLink = $(el).find('.torrent_magnet a[href^="magnet:"]').attr('href');
                    if (!magnetLink) return;

                    // Decode HTML entities in magnet link
                    const decodedMagnet = magnetLink
                        .replace(/&amp;/g, '&')
                        .replace(/&lt;/g, '<')
                        .replace(/&gt;/g, '>')
                        .replace(/&quot;/g, '"');

                    const infoHash = getHashFromMagnet(decodedMagnet);
                    if (!infoHash) return;

                    // Skip if already seen
                    if (seen.has(infoHash)) return;
                    seen.add(infoHash);

                    // Extract size
                    const sizeText = $(el).find('.torrent_size').text().trim();
                    const size = sizeToBytes(sizeText);

                    // Extract seeders (not available on BTDigg)
                    const seeders = 0;

                    // Extract number of files
                    const filesText = $(el).find('.torrent_files').text().trim();
                    const fileCount = parseInt(filesText) || 0;

                    results.push({
                        Title: title,
                        InfoHash: infoHash,
                        Size: size,
                        Seeders: seeders,
                        Tracker: scraperName,
                        Langs: detectSimpleLangs(title),
                        Magnet: decodedMagnet,
                        FileCount: fileCount
                    });
                } catch (e) {
                    // Ignore individual parsing errors
                }
            });
        }

        if (captchaDetected && results.length === 0) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} WARNING: BTDigg has enabled CAPTCHA/anti-bot protection. The scraper cannot bypass this automatically.`);
            console.log(`[${logPrefix} SCRAPER] ${scraperName} Consider: 1) Disabling BTDigg scraper 2) Using alternative scrapers 3) Waiting and trying again later`);
        }

        console.log(`[${logPrefix} SCRAPER] ${scraperName} raw results before processing: ${results.length}`);
        if (results.length > 0) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} Sample raw results:`);
            results.slice(0, 3).forEach((r, i) => {
                console.log(`  ${i+1}. ${r.Title}`);
                console.log(`     Hash: ${r.InfoHash}, Size: ${(r.Size / (1024**3)).toFixed(2)} GB, Files: ${r.FileCount}, Langs: [${r.Langs.join(', ')}]`);
            });
        }

        const processedResults = processAndDeduplicate(results, config);

        console.log(`[${logPrefix} SCRAPER] ${scraperName} found ${processedResults.length} results after processing (filtered from ${results.length}).`);
        if (processedResults.length > 0) {
            console.log(`[${logPrefix} SCRAPER] ${scraperName} Sample processed results:`);
            processedResults.slice(0, 3).forEach((r, i) => {
                console.log(`  ${i+1}. ${r.Title}`);
                console.log(`     Hash: ${r.InfoHash}, Size: ${(r.Size / (1024**3)).toFixed(2)} GB, Langs: [${r.Langs.join(', ')}]`);
            });
        }

        return processedResults;
    })();

    inFlightRequests.set(cacheKey, scrapePromise);
    isOwner = true;

    try {
        const processedResults = await scrapePromise;

        if (isOwner && processedResults.length > 0) {
            try {
                const saved = await SqliteCache.upsertCachedMagnet({
                    service: 'scraper',
                    hash: cacheKey,
                    data: processedResults
                });
                if (saved) {
                    console.log(`[${logPrefix} SCRAPER] ${scraperName} saved ${processedResults.length} results to cache`);
                }
            } catch (cacheError) {
                console.warn(`[${logPrefix} SCRAPER] ${scraperName} failed to save to cache: ${cacheError.message}`);
            }
        }

        return processedResults;
    } catch (error) {
        handleScraperError(error, scraperName, logPrefix);
        return [];
    } finally {
        if (isOwner) {
            inFlightRequests.delete(cacheKey);
            // Clean up cookie file
            if (cookieFile) {
                try {
                    await execPromise(`rm -f "${cookieFile}"`);
                } catch (e) {
                    // Ignore cleanup errors
                }
            }
        }
        console.timeEnd(timerLabel);
    }
}
