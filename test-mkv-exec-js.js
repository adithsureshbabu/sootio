import axios from 'axios';

// FlareSolverr v3 doesn't have native JS execution
// But we can try using the Puppeteer-like approach by navigating and waiting
// Let's check if FlareSolverr supports any execute/evaluate commands

// First, try using request.get with a special URL that triggers JS execution
// Actually, let me try: navigate to the page, then use FlareSolverr's cookies to
// intercept the API call that the page makes to load downloads

// Step 1: Get the page with FlareSolverr
console.log('Step 1: Getting page with FlareSolverr...');
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
console.log('CSRF:', csrf);

// Step 2: Try using FlareSolverr's POST with the proper format
// The API expects a form POST with specific fields
// Looking at the pattern: the JS obfuscation queries for [data-download_token]
// and the `_token\x22]` pattern in the JS suggests the form field might be '_token'

// Let me try variations with FlareSolverr POST (it passes through Cloudflare)
const formVariants = [
    `download_token=${encodeURIComponent(token)}`,
    `_token=${encodeURIComponent(token)}`,
    `token=${encodeURIComponent(token)}`,
    `download_token=${encodeURIComponent(token)}&_csrf_token=${encodeURIComponent(csrf)}`,
    // Try with CSRF as a different name
    `download_token=${encodeURIComponent(token)}&csrf_token=${encodeURIComponent(csrf)}`,
    // The "fe_csrf_token" is in the session cookie (seen in the cookie name "LkpgcDuljxiVttMcsesion" which decodes to a JSON with "fe_csrf_token")
];

// Let me first decode the session cookie
const sessionCookie = cookies.find(c => c.name.includes('sesion'));
if (sessionCookie) {
    try {
        // The cookie value is base64 encoded before the dot
        const parts = sessionCookie.value.split('.');
        const decoded = Buffer.from(parts[0], 'base64').toString('utf8');
        console.log('\nSession cookie decoded:', decoded);
    } catch(e) {
        console.log('Failed to decode session cookie:', e.message);
    }
}

// Step 3: Now let me try using the session's CSRF token from the cookie
// The decoded session likely has fe_csrf_token
let feCsrfToken = csrf;
if (sessionCookie) {
    try {
        const parts = sessionCookie.value.split('.');
        const decoded = JSON.parse(Buffer.from(parts[0], 'base64').toString('utf8'));
        if (decoded.fe_csrf_token) {
            feCsrfToken = decoded.fe_csrf_token;
            console.log('FE CSRF token from session:', feCsrfToken);
        }
    } catch(e) {}
}

// Step 4: Try POST via FlareSolverr with fe_csrf_token
console.log('\n--- Trying POST with fe_csrf_token ---');
for (const formData of formVariants) {
    try {
        const postResp = await axios.post('http://100.104.177.44:8191/v1', {
            cmd: 'request.post',
            url: `https://mkvdrama.net${apiPath}`,
            postData: formData,
            cookies: cookies,
            maxTimeout: 30000
        }, { timeout: 35000 });

        const apiHtml = postResp.data?.solution?.response || '';
        const title = apiHtml.match(/<title>([^<]+)/)?.[1] || 'no title';
        const status = postResp.data?.solution?.status;

        if (status === 200 && !title.includes('Bad') && !title.includes('wrong') && !title.includes('error')) {
            console.log(`SUCCESS with form: ${formData.substring(0, 50)}`);
            console.log('Title:', title);
            console.log('Response:', apiHtml.substring(0, 3000));
            break;
        } else {
            console.log(`Form "${formData.substring(0, 50)}..." -> ${status} ${title}`);
        }
    } catch(e) {
        console.log(`Form "${formData.substring(0, 50)}..." -> ERROR: ${e.message}`);
    }
}

// Step 5: Maybe the token needs to go in a header. Try X-Download-Token or similar
console.log('\n--- Trying with custom headers via direct POST ---');
import { SocksProxyAgent } from 'socks-proxy-agent';
const agent = new SocksProxyAgent('socks5h://100.104.177.44:1080');

const headerVariants = [
    { 'X-Download-Token': token },
    { 'X-Token': token },
    { 'Authorization': `Token ${token}` },
    { 'X-CSRF-Token': csrf, 'X-Download-Token': token },
];

for (const extraHeaders of headerVariants) {
    try {
        const postResp = await axios.post(`https://mkvdrama.net${apiPath}`,
            '',
            {
                httpsAgent: agent,
                httpAgent: agent,
                headers: {
                    'User-Agent': userAgent,
                    'Cookie': cookieStr,
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Referer': 'https://mkvdrama.net/yesterday-2026',
                    'Origin': 'https://mkvdrama.net',
                    ...extraHeaders
                },
                timeout: 15000,
                validateStatus: s => true
            }
        );
        const isJson = typeof postResp.data === 'object';
        const title = isJson ? '' : (postResp.data?.match(/<title>([^<]+)/)?.[1] || '');
        const summary = isJson ? JSON.stringify(postResp.data).substring(0, 200) : title;

        if (postResp.status === 200 && !summary.includes('Bad') && !summary.includes('wrong')) {
            console.log(`SUCCESS with headers: ${JSON.stringify(extraHeaders).substring(0, 80)}`);
            console.log('Response:', isJson ? JSON.stringify(postResp.data).substring(0, 2000) : postResp.data.substring(0, 2000));
            break;
        } else {
            console.log(`Headers ${JSON.stringify(Object.keys(extraHeaders))} -> ${postResp.status} ${summary}`);
        }
    } catch(e) {
        console.log(`Headers -> ERROR: ${e.message}`);
    }
}
