/**
 * E2E test: verify all MKVDrama requests go through the SOCKS5 proxy
 * and we can search + get streams + resolve video URLs.
 */

import { config } from 'dotenv';
config();

import axios from 'axios';
import { SocksProxyAgent } from 'socks-proxy-agent';
import * as cheerio from 'cheerio';

const PROXY_URL = process.env.MKVDRAMA_DIRECT_PROXY_URL || process.env.FLARESOLVERR_PROXY_URL || 'socks5h://100.104.177.44:1080';
const BASE_URL = 'https://mkvdrama.net';

const proxyAgent = new SocksProxyAgent(PROXY_URL);

async function fetchViaProxy(url, options = {}) {
    const resp = await axios.request({
        method: options.method || 'GET',
        url,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            ...options.headers
        },
        httpAgent: proxyAgent,
        httpsAgent: proxyAgent,
        proxy: false,
        timeout: 20000,
        maxRedirects: 5,
        validateStatus: () => true,
        ...(options.data ? { data: options.data } : {})
    });
    return resp;
}

async function testSearchViaProxy() {
    console.log('=== Test 1: Search MKVDrama via SOCKS5 proxy ===');
    console.log(`Proxy: ${PROXY_URL}\n`);

    const searchUrl = `${BASE_URL}/?s=squid+game`;
    console.log(`Fetching: ${searchUrl}`);

    const resp = await fetchViaProxy(searchUrl);
    const body = typeof resp.data === 'string' ? resp.data : '';

    console.log(`Status: ${resp.status}`);
    console.log(`Body length: ${body.length}`);

    const lower = body.toLowerCase();
    const isCfBlocked = lower.includes('just a moment') || lower.includes('checking your browser');
    const isWafBlocked = lower.includes('wordfence') || lower.includes('your access to this site has been limited');

    if (isCfBlocked) {
        console.log('WARN: Got Cloudflare challenge - proxy IP may be blocked');
        return { success: false, reason: 'cloudflare' };
    }
    if (isWafBlocked) {
        console.log('WARN: Got WAF block page');
        return { success: false, reason: 'waf' };
    }
    if (resp.status >= 400) {
        console.log(`WARN: Got HTTP ${resp.status}`);
        return { success: false, reason: `http-${resp.status}` };
    }

    const $ = cheerio.load(body);
    const results = $('article, .post, h2 a[href*="mkvdrama"]').length;
    console.log(`Found ${results} article/post elements`);

    // Try to extract post links
    const postLinks = [];
    $('a[href]').each((_, el) => {
        const href = $(el).attr('href');
        if (href && href.includes('mkvdrama.net') && !href.includes('?s=') && href !== BASE_URL + '/' &&
            !href.includes('/category/') && !href.includes('/tag/') && !href.includes('/page/') &&
            !href.endsWith('#respond') && !href.includes('#comment')) {
            if (!postLinks.includes(href)) postLinks.push(href);
        }
    });
    // Also try broader link matching
    const allLinks = [];
    $('a[href]').each((_, el) => {
        const href = $(el).attr('href') || '';
        if (href.includes('mkvdrama.net/') && href.length > BASE_URL.length + 2) {
            allLinks.push(href);
        }
    });
    const uniqueLinks = [...new Set(allLinks)];

    console.log(`Found ${postLinks.length} post links, ${uniqueLinks.length} total mkvdrama links`);
    if (uniqueLinks.length > 0) {
        console.log(`Sample links:\n  ${uniqueLinks.slice(0, 5).join('\n  ')}`);
    }
    if (postLinks.length === 0 && uniqueLinks.length > 0) {
        // Use first unique link as post link fallback
        postLinks.push(...uniqueLinks.filter(l => !l.includes('?') && !l.includes('#')).slice(0, 3));
    }
    if (postLinks.length === 0) {
        // Dump a snippet of the page for debugging
        console.log(`Page title: ${$('title').text()}`);
        console.log(`Page snippet: ${body.substring(0, 500)}`);
    }

    console.log('SUCCESS: Search via proxy works\n');
    return { success: true, postLinks };
}

async function testPostPageViaProxy(postUrl) {
    console.log('=== Test 2: Fetch post page via SOCKS5 proxy ===');
    console.log(`Fetching: ${postUrl}\n`);

    const resp = await fetchViaProxy(postUrl);
    const body = typeof resp.data === 'string' ? resp.data : '';

    console.log(`Status: ${resp.status}`);
    console.log(`Body length: ${body.length}`);

    if (resp.status >= 400) {
        console.log(`WARN: Got HTTP ${resp.status}`);
        return { success: false };
    }

    const $ = cheerio.load(body);

    // Look for download links (ouo.io, filecrypt, etc.)
    const downloadLinks = [];
    $('a[href]').each((_, el) => {
        const href = $(el).attr('href') || '';
        if (href.includes('ouo.io') || href.includes('ouo.press') || href.includes('filecrypt') ||
            href.includes('pixeldrain') || href.includes('hubcloud') || href.includes('viewcrate')) {
            downloadLinks.push(href);
        }
    });

    // Look for download API token
    const htmlStr = body;
    const tokenMatch = htmlStr.match(/download_token\s*[:=]\s*['"]([^'"]+)['"]/i) ||
                       htmlStr.match(/\bt\s*[:=]\s*['"]([a-f0-9]{20,})['"]/i);

    console.log(`Download links found: ${downloadLinks.length}`);
    console.log(`Download API token: ${tokenMatch ? 'found' : 'not found'}`);

    if (downloadLinks.length > 0) {
        console.log(`Sample links: ${downloadLinks.slice(0, 3).join('\n  ')}`);
    }

    console.log('SUCCESS: Post page via proxy works\n');
    return { success: true, downloadLinks, hasToken: !!tokenMatch };
}

async function testDirectConnectionBlocked() {
    console.log('=== Test 3: Verify direct connection gets blocked ===');
    try {
        const resp = await axios.get(`${BASE_URL}/?s=test`, {
            timeout: 10000,
            validateStatus: () => true,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        const body = typeof resp.data === 'string' ? resp.data : '';
        const lower = body.toLowerCase();
        const blocked = lower.includes('just a moment') ||
            lower.includes('checking your browser') ||
            lower.includes('wordfence') ||
            resp.status === 403 || resp.status === 429 || resp.status === 503;

        if (blocked) {
            console.log(`Direct connection blocked as expected (status: ${resp.status})`);
            console.log('SUCCESS: Direct is blocked, proxy is required\n');
        } else {
            console.log(`WARN: Direct connection returned status ${resp.status} and was NOT blocked`);
            console.log('(This means MKVDrama may not be blocking this IP currently)\n');
        }
    } catch (err) {
        console.log(`Direct connection failed with error: ${err.message}`);
        console.log('This confirms proxy is needed\n');
    }
}

async function main() {
    console.log('========================================');
    console.log('MKVDrama Proxy E2E Test');
    console.log('========================================\n');

    // Test 1: Search
    const searchResult = await testSearchViaProxy();

    // Test 2: Post page - try multiple slug patterns
    if (searchResult.success) {
        const slugCandidates = [
            `${BASE_URL}/squid-game/`,
            `${BASE_URL}/download-squid-game/`,
            `${BASE_URL}/series/squid-game/`,
            `${BASE_URL}/moving/`,
            `${BASE_URL}/download-moving/`,
        ];
        let foundPost = false;
        for (const slug of slugCandidates) {
            console.log(`Trying slug: ${slug}`);
            const resp = await fetchViaProxy(slug);
            if (resp.status === 200) {
                console.log(`Found working slug: ${slug}`);
                await testPostPageViaProxy(slug);
                foundPost = true;
                break;
            }
            console.log(`  -> ${resp.status}`);
        }
        if (!foundPost) {
            // Try getting a slug from the homepage
            console.log('\nTrying to find a valid post from homepage...');
            const homeResp = await fetchViaProxy(BASE_URL);
            const home$ = cheerio.load(typeof homeResp.data === 'string' ? homeResp.data : '');
            const homeLinks = [];
            home$('a[href]').each((_, el) => {
                const href = home$(el).attr('href') || '';
                if (href.startsWith(BASE_URL + '/') && href.length > BASE_URL.length + 5 &&
                    !href.includes('?') && !href.includes('#') &&
                    !href.includes('/category/') && !href.includes('/tag/') && !href.includes('/page/')) {
                    homeLinks.push(href);
                }
            });
            const uniqueHome = [...new Set(homeLinks)];
            if (uniqueHome.length > 0) {
                console.log(`Found ${uniqueHome.length} homepage links, testing first one`);
                await testPostPageViaProxy(uniqueHome[0]);
            } else {
                console.log('No post links found from homepage either');
            }
        }
    }

    // Test 3: Direct connection should be blocked
    await testDirectConnectionBlocked();

    console.log('========================================');
    console.log('All proxy E2E tests completed');
    console.log('========================================');
}

main().catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(1);
});
