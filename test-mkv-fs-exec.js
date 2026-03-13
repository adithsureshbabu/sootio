import axios from 'axios';

// Check FlareSolverr version
try {
    const vResp = await axios.get('http://100.104.177.44:8191/', { timeout: 5000 });
    console.log('FlareSolverr info:', JSON.stringify(vResp.data));
} catch(e) {
    console.log('Version check failed:', e.message);
}

// Try FlareSolverr with a longer wait and see if we can wait for JS
// FlareSolverr v2 doesn't have a waitSelector but we can try
const resp = await axios.post('http://100.104.177.44:8191/v1', {
    cmd: 'request.get',
    url: 'https://mkvdrama.net/yesterday-2026',
    maxTimeout: 90000,
}, { timeout: 95000 });

const html = resp.data?.solution?.response || '';
const cookies = resp.data?.solution?.cookies || [];
const userAgent = resp.data?.solution?.userAgent || '';

console.log('HTML length:', html.length);
console.log('Still has Loading...:', html.includes('Loading...'));

// The download content is loaded by JS calling the API. Let's try to replicate
// what the JS does. Looking at the token format:
// data-download-token="8001:token:timestamp:hash"
// data-download-api-path="/titles/yesterday-2026/dl/s8001-1c4cfc2e34db4d3404"
//
// The JS probably POSTs to the API path with the token as a header or cookie
// Let's try X-Download-Token header

const tokenMatch = html.match(/data-download-token="([^"]+)"/);
const apiPathMatch = html.match(/data-download-api-path="([^"]+)"/);
const csrfMatch = html.match(/name="csrf-token" content="([^"]+)"/);

const token = tokenMatch?.[1];
const apiPath = apiPathMatch?.[1];
const csrf = csrfMatch?.[1];
const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');

console.log('\nToken:', token);
console.log('API path:', apiPath);
console.log('CSRF:', csrf);

// Try FlareSolverr POST with the download token in the form
console.log('\n--- Try FlareSolverr POST with download_token ---');
try {
    const postResp = await axios.post('http://100.104.177.44:8191/v1', {
        cmd: 'request.post',
        url: `https://mkvdrama.net${apiPath}`,
        postData: `download_token=${encodeURIComponent(token)}`,
        cookies: cookies,
        maxTimeout: 60000
    }, { timeout: 65000 });

    const apiHtml = postResp.data?.solution?.response || '';
    const title = apiHtml.match(/<title>([^<]+)/)?.[1] || 'no title';
    console.log('Status:', postResp.data?.solution?.status);
    console.log('Title:', title);
    console.log('Length:', apiHtml.length);
    if (title.includes('Bad') || title.includes('wrong')) {
        console.log('FAILED');
    } else {
        console.log('Response:', apiHtml.substring(0, 3000));
    }
} catch(e) {
    console.log('Failed:', e.message);
}

// Try with _token
console.log('\n--- Try _token ---');
try {
    const postResp = await axios.post('http://100.104.177.44:8191/v1', {
        cmd: 'request.post',
        url: `https://mkvdrama.net${apiPath}`,
        postData: `_token=${encodeURIComponent(token)}&_csrf=${encodeURIComponent(csrf)}`,
        cookies: cookies,
        maxTimeout: 60000
    }, { timeout: 65000 });

    const apiHtml = postResp.data?.solution?.response || '';
    const title = apiHtml.match(/<title>([^<]+)/)?.[1] || 'no title';
    console.log('Title:', title);
    console.log('Length:', apiHtml.length);
    if (!title.includes('Bad') && !title.includes('wrong')) {
        console.log('Response:', apiHtml.substring(0, 3000));
    }
} catch(e) {
    console.log('Failed:', e.message);
}

// Try various form field names for the token
const tokenNames = ['t', 'tk', 'auth', 'key', 'dl_token', 'token', 'access_token'];
for (const name of tokenNames) {
    try {
        const postResp = await axios.post('http://100.104.177.44:8191/v1', {
            cmd: 'request.post',
            url: `https://mkvdrama.net${apiPath}`,
            postData: `${name}=${encodeURIComponent(token)}`,
            cookies: cookies,
            maxTimeout: 30000
        }, { timeout: 35000 });

        const apiHtml = postResp.data?.solution?.response || '';
        const title = apiHtml.match(/<title>([^<]+)/)?.[1] || 'no title';
        const status = postResp.data?.solution?.status;
        if (!title.includes('Bad') && !title.includes('wrong') && status !== 400 && status !== 422) {
            console.log(`SUCCESS with ${name}: Status ${status}, Title: ${title}`);
            console.log('Response:', apiHtml.substring(0, 3000));
            break;
        }
    } catch(e) {}
}
console.log('Done trying token names');
