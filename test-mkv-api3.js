import axios from 'axios';
import { SocksProxyAgent } from 'socks-proxy-agent';

const agent = new SocksProxyAgent('socks5h://100.104.177.44:1080');

// First get the page via FlareSolverr for cookies and tokens
const resp = await axios.post('http://100.104.177.44:8191/v1', {
    cmd: 'request.get',
    url: 'https://mkvdrama.net/yesterday-2026',
    maxTimeout: 60000
}, { timeout: 65000 });

const html = resp.data?.solution?.response || '';
const cookies = resp.data?.solution?.cookies || [];
const userAgent = resp.data?.solution?.userAgent || '';

const tokenMatch = html.match(/data-download-token="([^"]+)"/);
const apiPathMatch = html.match(/data-download-api-path="([^"]+)"/);
const csrfMatch = html.match(/name="csrf-token" content="([^"]+)"/);

const token = tokenMatch?.[1];
const apiPath = apiPathMatch?.[1];
const csrf = csrfMatch?.[1];

// Build cookie string
const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');

// First, let's get the site.js to understand how downloads work
console.log('--- Fetching site.js ---');
const jsUrls = [...html.matchAll(/src="([^"]*site\.[^"]*\.js[^"]*)"/gi)].map(m => m[1]);
console.log('JS files:', jsUrls);

for (const jsUrl of jsUrls) {
    const fullUrl = jsUrl.startsWith('http') ? jsUrl : `https://mkvdrama.net${jsUrl}`;
    try {
        const jsResp = await axios.get(fullUrl, {
            httpsAgent: agent,
            httpAgent: agent,
            headers: {
                'User-Agent': userAgent,
                'Cookie': cookieStr
            },
            timeout: 15000
        });
        const js = jsResp.data;
        console.log(`\nJS file ${jsUrl}: ${js.length} chars`);

        // Find download-related code
        const downloadIdx = js.indexOf('download-token');
        if (downloadIdx > -1) {
            console.log('--- download-token context ---');
            console.log(js.substring(Math.max(0, downloadIdx - 500), downloadIdx + 1000));
        }

        const apiIdx = js.indexOf('download-api');
        if (apiIdx > -1) {
            console.log('--- download-api context ---');
            console.log(js.substring(Math.max(0, apiIdx - 500), apiIdx + 1000));
        }

        // Look for fetch/axios calls related to download
        const fetchMatches = js.match(/fetch\([^)]*download[^)]*\)/gi);
        if (fetchMatches) {
            console.log('Fetch calls with download:', fetchMatches);
        }
    } catch(e) {
        console.log(`Failed to fetch ${jsUrl}:`, e.message);
    }
}

// Also try the download API as a POST with the token
console.log('\n--- Trying POST to download API ---');
const apiUrl = `https://mkvdrama.net${apiPath}`;

try {
    const postResp = await axios.post(apiUrl,
        { token: token },
        {
            httpsAgent: agent,
            httpAgent: agent,
            headers: {
                'User-Agent': userAgent,
                'Cookie': cookieStr,
                'X-CSRF-Token': csrf,
                'Content-Type': 'application/json',
                'Referer': 'https://mkvdrama.net/yesterday-2026',
                'Origin': 'https://mkvdrama.net',
                'X-Requested-With': 'XMLHttpRequest'
            },
            timeout: 15000
        }
    );
    console.log('POST response status:', postResp.status);
    const data = typeof postResp.data === 'string' ? postResp.data.substring(0, 3000) : JSON.stringify(postResp.data, null, 2).substring(0, 3000);
    console.log('POST response:', data);
} catch(e) {
    console.log('POST failed:', e.response?.status, e.response?.data ? JSON.stringify(e.response.data).substring(0, 1000) : e.message);
}

// Try GET with token as query param
console.log('\n--- Trying GET with token param ---');
try {
    const getResp = await axios.get(`${apiUrl}?token=${encodeURIComponent(token)}`, {
        httpsAgent: agent,
        httpAgent: agent,
        headers: {
            'User-Agent': userAgent,
            'Cookie': cookieStr,
            'X-CSRF-Token': csrf,
            'Referer': 'https://mkvdrama.net/yesterday-2026',
            'X-Requested-With': 'XMLHttpRequest'
        },
        timeout: 15000
    });
    console.log('GET response status:', getResp.status);
    const data = typeof getResp.data === 'string' ? getResp.data.substring(0, 3000) : JSON.stringify(getResp.data, null, 2).substring(0, 3000);
    console.log('GET response:', data);
} catch(e) {
    console.log('GET failed:', e.response?.status, e.message);
}

// Try Authorization header
console.log('\n--- Trying GET with Authorization header ---');
try {
    const getResp = await axios.get(apiUrl, {
        httpsAgent: agent,
        httpAgent: agent,
        headers: {
            'User-Agent': userAgent,
            'Cookie': cookieStr,
            'X-CSRF-Token': csrf,
            'Authorization': `Bearer ${token}`,
            'Referer': 'https://mkvdrama.net/yesterday-2026',
            'X-Requested-With': 'XMLHttpRequest'
        },
        timeout: 15000
    });
    console.log('Auth GET response status:', getResp.status);
    const data = typeof getResp.data === 'string' ? getResp.data.substring(0, 3000) : JSON.stringify(getResp.data, null, 2).substring(0, 3000);
    console.log('Auth GET response:', data);
} catch(e) {
    console.log('Auth GET failed:', e.response?.status, e.message);
}
