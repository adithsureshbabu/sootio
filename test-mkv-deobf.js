import axios from 'axios';
import { SocksProxyAgent } from 'socks-proxy-agent';

const agent = new SocksProxyAgent('socks5h://100.104.177.44:1080');

const jsResp = await axios.get('https://mkvdrama.net/static/js/dist/site.bundle.js?v=084feeeb7688', {
    httpsAgent: agent,
    httpAgent: agent,
    headers: { 'User-Agent': 'Mozilla/5.0' },
    timeout: 15000
});

const js = jsResp.data;
console.log('JS length:', js.length);

// Find all fetch() calls
const fetchCalls = [...js.matchAll(/fetch\s*\(/gi)];
console.log('\nfetch() calls:', fetchCalls.length);
fetchCalls.forEach((m, i) => {
    console.log(`\n  fetch #${i+1} at ${m.index}:`);
    console.log(js.substring(m.index, m.index + 500));
});

// Find all XMLHttpRequest
const xhrCalls = [...js.matchAll(/XMLHttpRequest/gi)];
console.log('\n\nXMLHttpRequest calls:', xhrCalls.length);

// Find all axios calls
const axiosCalls = [...js.matchAll(/axios/gi)];
console.log('axios calls:', axiosCalls.length);

// Look for POST method references
const postRefs = [...js.matchAll(/['"]POST['"]/gi)];
console.log('\nPOST references:', postRefs.length);
postRefs.forEach((m, i) => {
    console.log(`\n  POST #${i+1} at ${m.index}:`);
    console.log(js.substring(Math.max(0, m.index - 300), m.index + 300));
});

// Look for /dl/ or /titles/ in the JS
const dlRefs = [...js.matchAll(/\/dl\//gi)];
console.log('\n/dl/ references:', dlRefs.length);

const titlesRefs = [...js.matchAll(/\/titles\//gi)];
console.log('/titles/ references:', titlesRefs.length);

// Look for mlx-root
const mlxRefs = [...js.matchAll(/mlx/gi)];
console.log('\nmlx references:', mlxRefs.length);
mlxRefs.forEach((m, i) => {
    console.log(`  mlx #${i+1} at ${m.index}:`);
    console.log(js.substring(Math.max(0, m.index - 200), m.index + 300));
});

// Look for download-api-path
const dapRefs = [...js.matchAll(/download.api/gi)];
console.log('\ndownload-api references:', dapRefs.length);
dapRefs.forEach((m, i) => {
    console.log(`  #${i+1} at ${m.index}:`);
    console.log(js.substring(Math.max(0, m.index - 300), m.index + 500));
});
