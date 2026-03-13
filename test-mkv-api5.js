import axios from 'axios';
import { SocksProxyAgent } from 'socks-proxy-agent';

const agent = new SocksProxyAgent('socks5h://100.104.177.44:1080');

// The direct API returns JSON - let's explore what endpoints exist
const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json'
};

// 1. Try the series page - we know it returns JSON with series info
console.log('=== Series info ===');
const seriesResp = await axios.get('https://mkvdrama.net/yesterday-2026', {
    httpsAgent: agent, httpAgent: agent, headers, timeout: 15000
});
const series = seriesResp.data;
console.log('Type:', typeof series);
if (series.series) {
    console.log('Title:', series.series.title);
    console.log('ID:', series.series.id);
    console.log('Slug:', series.series.slug);
    console.log('download_blocks:', series.series.download_blocks);
    console.log('Keys:', Object.keys(series.series).join(', '));
    console.log('Total episodes:', series.series.total_episodes);
    console.log('Seasons:', JSON.stringify(series.series.seasons));
}

// Check for other keys at root level
console.log('\nRoot keys:', Object.keys(series).join(', '));
if (series.episodes) {
    console.log('Episodes:', JSON.stringify(series.episodes).substring(0, 2000));
}
if (series.downloads) {
    console.log('Downloads:', JSON.stringify(series.downloads).substring(0, 2000));
}

// 2. Try API endpoints that might exist
const tryEndpoints = [
    '/api/titles/yesterday-2026',
    '/api/titles/yesterday-2026/episodes',
    '/api/titles/yesterday-2026/downloads',
    '/api/series/8001',
    '/api/series/8001/episodes',
    '/api/series/8001/downloads',
    '/titles/yesterday-2026/episodes',
    '/titles/yesterday-2026/downloads',
    // Try the download path with JSON accept
    '/titles/yesterday-2026/dl/s8001-1c4cfc2e34db4d3404',
];

for (const endpoint of tryEndpoints) {
    try {
        const resp = await axios.get(`https://mkvdrama.net${endpoint}`, {
            httpsAgent: agent, httpAgent: agent,
            headers: { ...headers, 'Accept': 'application/json, text/html' },
            timeout: 10000,
            validateStatus: s => true
        });
        const isJson = typeof resp.data === 'object';
        const summary = isJson ? JSON.stringify(resp.data).substring(0, 300) : `HTML (${resp.data.length} chars)`;
        console.log(`\n${endpoint} -> ${resp.status} ${isJson ? 'JSON' : 'HTML'}: ${summary}`);
    } catch(e) {
        console.log(`${endpoint} -> ERROR: ${e.message}`);
    }
}

// 3. Try the full series data dump
console.log('\n\n=== Full series JSON (all keys) ===');
console.log(JSON.stringify(series, null, 2).substring(0, 5000));
