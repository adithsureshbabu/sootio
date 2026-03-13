import axios from 'axios';
import { SocksProxyAgent } from 'socks-proxy-agent';

const agent = new SocksProxyAgent('socks5h://100.104.177.44:1080');

// Get the page first
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

// It's a FastAPI backend that expects JSON body
// The 422 error says "field required" in "body" - need to figure out the field name
// Token format: "8001:signature:timestamp:hash"

const jsonBodies = [
    { token: token },
    { download_token: token },
    { t: token },
    { auth: token },
    { key: token },
    { signature: token },
    // Maybe just the signature part
    { token: token.split(':')[1] },
    // Maybe separate fields
    { series_id: 8001, token: token.split(':')[1], ts: token.split(':')[2], hash: token.split(':')[3] },
    // Maybe the whole token as a single field with different names
    { dl_token: token },
    { access_token: token },
    { verification: token },
    { code: token },
    { data: token },
    { payload: token },
];

for (const body of jsonBodies) {
    try {
        const postResp = await axios.post(`https://mkvdrama.net${apiPath}`,
            body,
            {
                httpsAgent: agent,
                httpAgent: agent,
                headers: {
                    'User-Agent': userAgent,
                    'Cookie': cookieStr,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'Referer': 'https://mkvdrama.net/yesterday-2026',
                    'Origin': 'https://mkvdrama.net',
                    'X-CSRF-Token': csrf
                },
                timeout: 15000,
                validateStatus: s => true
            }
        );

        const isJson = typeof postResp.data === 'object';
        const data = isJson ? postResp.data : postResp.data.substring(0, 200);

        if (postResp.status === 200) {
            console.log(`SUCCESS with body: ${JSON.stringify(body).substring(0, 80)}`);
            console.log('Response:', JSON.stringify(postResp.data).substring(0, 3000));
            process.exit(0);
        } else if (postResp.status === 422) {
            const detail = isJson ? JSON.stringify(postResp.data.detail) : '';
            // Check if it gives more info about which fields are wrong/missing
            if (detail !== '[{"type":"missing","loc":["body"],"msg":"Field required","input":null}]') {
                console.log(`Body ${JSON.stringify(body).substring(0, 60)} -> ${postResp.status}: ${detail.substring(0, 200)}`);
            }
        } else {
            console.log(`Body ${JSON.stringify(body).substring(0, 60)} -> ${postResp.status}`);
        }
    } catch(e) {
        console.log(`Body ${JSON.stringify(body).substring(0, 60)} -> ERROR: ${e.message}`);
    }
}

console.log('\nAll body attempts returned 422 "Field required"');

// Let's try sending an empty JSON object to see which fields are required
console.log('\n--- Empty body ---');
try {
    const postResp = await axios.post(`https://mkvdrama.net${apiPath}`,
        {},
        {
            httpsAgent: agent,
            httpAgent: agent,
            headers: {
                'User-Agent': userAgent,
                'Cookie': cookieStr,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Referer': 'https://mkvdrama.net/yesterday-2026',
                'Origin': 'https://mkvdrama.net',
                'X-CSRF-Token': csrf
            },
            timeout: 15000,
            validateStatus: s => true
        }
    );
    console.log('Status:', postResp.status);
    console.log('Response:', JSON.stringify(postResp.data, null, 2));
} catch(e) {
    console.log('ERROR:', e.message);
}

// Maybe it's not actually JSON but form-encoded with specific Cloudflare challenge fields
// Let's try with cf_clearance cookie explicitly and form data
console.log('\n--- Form data with cf challenge ---');
try {
    const postResp = await axios.post(`https://mkvdrama.net${apiPath}`,
        `download_token=${encodeURIComponent(token)}&csrf_token=${encodeURIComponent(csrf)}`,
        {
            httpsAgent: agent,
            httpAgent: agent,
            headers: {
                'User-Agent': userAgent,
                'Cookie': cookieStr,
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept': 'application/json, text/html, */*',
                'Referer': 'https://mkvdrama.net/yesterday-2026',
                'Origin': 'https://mkvdrama.net',
                'X-CSRF-Token': csrf,
                'X-Requested-With': 'XMLHttpRequest'
            },
            timeout: 15000,
            validateStatus: s => true
        }
    );
    console.log('Status:', postResp.status);
    const isJson = typeof postResp.data === 'object';
    console.log('Response:', isJson ? JSON.stringify(postResp.data).substring(0, 1000) : postResp.data.substring(0, 500));
} catch(e) {
    console.log('ERROR:', e.message);
}
