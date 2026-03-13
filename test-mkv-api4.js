import axios from 'axios';
import { SocksProxyAgent } from 'socks-proxy-agent';

const agent = new SocksProxyAgent('socks5h://100.104.177.44:1080');

// Get the page via FlareSolverr for cookies and tokens
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
const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');

console.log('Token:', token);
console.log('API path:', apiPath);
console.log('CSRF:', csrf);

// Try POST with form-urlencoded (the token as form data)
console.log('\n--- POST with form-urlencoded ---');
try {
    const postResp = await axios.post(`https://mkvdrama.net${apiPath}`,
        `_csrf=${encodeURIComponent(csrf)}&token=${encodeURIComponent(token)}`,
        {
            httpsAgent: agent,
            httpAgent: agent,
            headers: {
                'User-Agent': userAgent,
                'Cookie': cookieStr,
                'Content-Type': 'application/x-www-form-urlencoded',
                'Referer': 'https://mkvdrama.net/yesterday-2026',
                'Origin': 'https://mkvdrama.net',
                'X-Requested-With': 'XMLHttpRequest',
                'X-CSRF-Token': csrf
            },
            timeout: 15000,
            maxRedirects: 0,
            validateStatus: s => s < 500
        }
    );
    console.log('Status:', postResp.status);
    console.log('Headers:', JSON.stringify(postResp.headers));
    const data = typeof postResp.data === 'string' ? postResp.data.substring(0, 3000) : JSON.stringify(postResp.data, null, 2).substring(0, 3000);
    console.log('Response:', data);
} catch(e) {
    console.log('POST form failed:', e.response?.status, e.message);
}

// Try POST with just CSRF header and token in body
console.log('\n--- POST with JSON body (various formats) ---');
const bodies = [
    { _csrf: csrf },
    { csrf_token: csrf },
    { download_token: token },
    `_csrf=${encodeURIComponent(csrf)}`,
    `token=${encodeURIComponent(token)}&_csrf=${encodeURIComponent(csrf)}`,
];

for (const body of bodies) {
    const isStr = typeof body === 'string';
    try {
        const postResp = await axios.post(`https://mkvdrama.net${apiPath}`,
            body,
            {
                httpsAgent: agent,
                httpAgent: agent,
                headers: {
                    'User-Agent': userAgent,
                    'Cookie': cookieStr,
                    'Content-Type': isStr ? 'application/x-www-form-urlencoded' : 'application/json',
                    'Referer': 'https://mkvdrama.net/yesterday-2026',
                    'Origin': 'https://mkvdrama.net',
                    'X-CSRF-Token': csrf
                },
                timeout: 15000,
                validateStatus: s => true
            }
        );
        const data = typeof postResp.data === 'string' ? postResp.data.substring(0, 200) : JSON.stringify(postResp.data).substring(0, 200);
        const title = typeof postResp.data === 'string' ? (postResp.data.match(/<title>([^<]+)/)?.[1] || '') : '';
        console.log(`Body: ${JSON.stringify(body).substring(0,100)} -> ${postResp.status} ${title}`);
    } catch(e) {
        console.log(`Body: ${JSON.stringify(body).substring(0,100)} -> ERROR: ${e.message}`);
    }
}

// Try using FlareSolverr to POST
console.log('\n--- FlareSolverr POST ---');
try {
    const fsResp = await axios.post('http://100.104.177.44:8191/v1', {
        cmd: 'request.post',
        url: `https://mkvdrama.net${apiPath}`,
        postData: `_csrf=${encodeURIComponent(csrf)}&token=${encodeURIComponent(token)}`,
        cookies: cookies,
        maxTimeout: 60000
    }, { timeout: 65000 });

    const apiHtml = fsResp.data?.solution?.response || '';
    const title = apiHtml.match(/<title>([^<]+)/)?.[1] || '';
    console.log('FlareSolverr POST status:', fsResp.data?.solution?.status);
    console.log('Title:', title);
    console.log('Response length:', apiHtml.length);

    // Check for download content
    if (apiHtml.length > 1000 && !apiHtml.includes('Something went wrong') && !apiHtml.includes('Bad request')) {
        console.log('SUCCESS - got content');

        // Look for download links
        const ouoLinks = [...apiHtml.matchAll(/href="([^"]*ouo[^"]*)"/gi)].map(m => m[1]);
        const filecryptLinks = [...apiHtml.matchAll(/href="([^"]*filecrypt[^"]*)"/gi)].map(m => m[1]);
        const pixeldrainLinks = [...apiHtml.matchAll(/href="([^"]*pixeldrain[^"]*)"/gi)].map(m => m[1]);
        const allLinks = [...apiHtml.matchAll(/href="(https?:\/\/[^"]+)"/gi)].map(m => m[1]);

        console.log('OUO links:', ouoLinks);
        console.log('Filecrypt links:', filecryptLinks);
        console.log('Pixeldrain links:', pixeldrainLinks);
        console.log('All external links:', allLinks.filter(l => !l.includes('mkvdrama')));

        // Show the main content
        const bodyContent = apiHtml.match(/<body[^>]*>([\s\S]*)<\/body>/i);
        if (bodyContent) {
            // Strip scripts and styles
            const cleaned = bodyContent[1].replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
            console.log('\nCleaned body (first 5000):');
            console.log(cleaned.substring(0, 5000));
        }
    }
} catch(e) {
    console.log('FlareSolverr POST failed:', e.message);
}
