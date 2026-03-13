import axios from 'axios';

// Get the rendered page via FlareSolverr
const resp = await axios.post('http://100.104.177.44:8191/v1', {
    cmd: 'request.get',
    url: 'https://mkvdrama.net/yesterday-2026',
    maxTimeout: 60000
}, { timeout: 65000 });

const html = resp.data?.solution?.response || '';
const cookies = resp.data?.solution?.cookies || [];
const userAgent = resp.data?.solution?.userAgent || '';

// Extract tokens
const tokenMatch = html.match(/data-download-token="([^"]+)"/);
const apiPathMatch = html.match(/data-download-api-path="([^"]+)"/);
const csrfMatch = html.match(/name="csrf-token" content="([^"]+)"/);

const token = tokenMatch?.[1];
const apiPath = apiPathMatch?.[1];
const csrf = csrfMatch?.[1];

console.log('Token:', token);
console.log('API path:', apiPath);
console.log('CSRF:', csrf);
console.log('User-Agent:', userAgent);

// Build cookie string
const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
console.log('Cookies:', cookieStr.substring(0, 200));

// Look for the "epx" elements (episode list)
const epxMatches = [...html.matchAll(/class="epx"[\s\S]*?<\/div>/gi)];
console.log('\n--- Episode elements (epx) ---');
epxMatches.forEach((m, i) => console.log(`  Episode ${i+1}:`, m[0].substring(0, 300)));

// Look for episode list container
const eplisterMatch = html.match(/class="[^"]*eplister[^"]*"[\s\S]{0,5000}/i);
if (eplisterMatch) {
    console.log('\n--- Episode lister ---');
    console.log(eplisterMatch[0].substring(0, 3000));
}

// Try calling the API with proper auth headers
console.log('\n--- Trying download API with proper headers ---');
const apiUrl = `https://mkvdrama.net${apiPath}`;

try {
    // Use FlareSolverr with cookies from the series page
    const apiResp = await axios.post('http://100.104.177.44:8191/v1', {
        cmd: 'request.get',
        url: apiUrl,
        maxTimeout: 60000,
        cookies: cookies
    }, { timeout: 65000 });

    const apiHtml = apiResp.data?.solution?.response || '';
    console.log('API response length:', apiHtml.length);

    // Check for download links in the API response
    const ouoLinks = apiHtml.match(/ouo\.[a-z]+\/[a-zA-Z0-9]+/gi) || [];
    const filecryptLinks = apiHtml.match(/filecrypt\.[a-z]+\/[a-zA-Z0-9]+/gi) || [];
    const pixeldrainLinks = apiHtml.match(/pixeldrain\.com\/[a-zA-Z0-9/]+/gi) || [];
    console.log('OUO links:', ouoLinks.length);
    console.log('Filecrypt links:', filecryptLinks.length);
    console.log('Pixeldrain links:', pixeldrainLinks.length);

    // Show all hrefs
    const hrefs = [...apiHtml.matchAll(/href="([^"]+)"/gi)].map(m => m[1]);
    const interesting = hrefs.filter(h => /ouo|filecrypt|pixel|download|dl/i.test(h));
    console.log('Interesting hrefs:', interesting.length);
    interesting.forEach(h => console.log(' ', h));

    // Check if it's an error page
    if (apiHtml.includes('Something went wrong') || apiHtml.includes('error')) {
        console.log('ERROR: API returned error page');
        // Show error content
        const errorMatch = apiHtml.match(/class="[^"]*error[^"]*"[\s\S]*?<\/div>/i);
        if (errorMatch) console.log('Error:', errorMatch[0].substring(0, 500));
    }

    // Show the main content area
    const mainContent = apiHtml.match(/class="entry-content"[\s\S]*?<\/div>/i);
    if (mainContent) {
        console.log('\nEntry content:', mainContent[0].substring(0, 2000));
    }

    // Show any data attributes
    const dataAttrs = [...apiHtml.matchAll(/data-[\w-]+="([^"]{10,})"/gi)];
    console.log('\nData attrs:');
    dataAttrs.filter(d => /download|link|url|episode|file/i.test(d[0])).forEach(d => console.log('  ', d[0].substring(0, 200)));

    // Show first 5000 chars of body content
    const bodyMatch = apiHtml.match(/<body[\s\S]*?>([\s\S]{0,5000})/i);
    if (bodyMatch) {
        console.log('\n--- Body (first 5000) ---');
        console.log(bodyMatch[1]);
    }
} catch(e) {
    console.log('API call failed:', e.message);
}
