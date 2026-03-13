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

// Search for download-related code
const searchTerms = ['download-token', 'download-api', 'download_token', 'downloadToken', 'dl/', '/dl', 'token', 'csrf'];
for (const term of searchTerms) {
    let idx = 0;
    let count = 0;
    while ((idx = js.indexOf(term, idx)) !== -1) {
        if (count === 0) {
            console.log(`\n=== "${term}" found at ${idx} ===`);
            console.log(js.substring(Math.max(0, idx - 300), idx + 500));
        }
        count++;
        idx += term.length;
    }
    if (count > 0) console.log(`(${count} total occurrences)`);
}
