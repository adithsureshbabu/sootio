import axios from 'axios';

// First get the page via FlareSolverr to extract the token and API path
const resp = await axios.post('http://100.104.177.44:8191/v1', {
    cmd: 'request.get',
    url: 'https://mkvdrama.net/yesterday-2026',
    maxTimeout: 60000
}, { timeout: 65000 });

const html = resp.data?.solution?.response || '';
const cookies = resp.data?.solution?.cookies || [];

console.log('Cookies from FlareSolverr:');
cookies.forEach(c => console.log(`  ${c.name}=${c.value?.substring(0, 50)}...`));

// Extract download token and API path
const tokenMatch = html.match(/data-download-token="([^"]+)"/);
const apiPathMatch = html.match(/data-download-api-path="([^"]+)"/);
const csrfMatch = html.match(/name="csrf-token" content="([^"]+)"/);

console.log('\nDownload token:', tokenMatch?.[1] || 'NOT FOUND');
console.log('API path:', apiPathMatch?.[1] || 'NOT FOUND');
console.log('CSRF token:', csrfMatch?.[1] || 'NOT FOUND');

if (!apiPathMatch?.[1]) {
    console.log('No API path found, exiting');
    process.exit(1);
}

// Build cookie string from FlareSolverr cookies
const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');

// Try calling the download API
const apiUrl = `https://mkvdrama.net${apiPathMatch[1]}`;
console.log('\nCalling download API:', apiUrl);

try {
    // Try with FlareSolverr first (POST)
    const apiResp = await axios.post('http://100.104.177.44:8191/v1', {
        cmd: 'request.get',
        url: apiUrl,
        maxTimeout: 60000
    }, { timeout: 65000 });

    const apiHtml = apiResp.data?.solution?.response || '';
    console.log('API response length:', apiHtml.length);
    console.log('API response (first 3000 chars):');
    console.log(apiHtml.substring(0, 3000));
} catch(e) {
    console.log('FlareSolverr request failed:', e.message);
}

// Also look for episode list elements in the original page
console.log('\n--- Looking for episode-related elements ---');
const episodePatterns = [
    /class="[^"]*episode[^"]*"/gi,
    /data-episode[^=]*="[^"]*"/gi,
    /id="[^"]*episode[^"]*"/gi,
    /class="[^"]*season[^"]*"/gi,
    /class="[^"]*eplister[^"]*"/gi,
    /class="[^"]*epx[^"]*"/gi,
];

for (const pat of episodePatterns) {
    const matches = html.match(pat);
    if (matches) {
        console.log(`Pattern ${pat}:`);
        matches.forEach(m => console.log('  ', m));
    }
}

// Look for any hidden/dynamic elements with episode data
const episodeAreaMatch = html.match(/episod[\s\S]{0,5000}/i);
if (episodeAreaMatch) {
    console.log('\n--- Episode area ---');
    console.log(episodeAreaMatch[0].substring(0, 2000));
}
