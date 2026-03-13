import axios from 'axios';

const resp = await axios.post('http://100.104.177.44:8191/v1', {
    cmd: 'request.get',
    url: 'https://mkvdrama.net/yesterday-2026',
    maxTimeout: 60000
}, { timeout: 65000 });

const html = resp.data?.solution?.response || '';

// Extract the window.settings script
const settingsMatch = html.match(/window\.settings[\s\S]*?<\/script>/);
if (settingsMatch) {
    console.log('=== window.settings ===');
    console.log(settingsMatch[0]);
}

// Now let's look at the obfuscated site.bundle.js more carefully
// The token, API, mlx etc. are probably encoded as hex/unicode strings in the obfuscation
import { SocksProxyAgent } from 'socks-proxy-agent';
const agent = new SocksProxyAgent('socks5h://100.104.177.44:1080');

const jsResp = await axios.get('https://mkvdrama.net/static/js/dist/site.bundle.js?v=084feeeb7688', {
    httpsAgent: agent,
    httpAgent: agent,
    headers: { 'User-Agent': 'Mozilla/5.0' },
    timeout: 15000
});

const js = jsResp.data;

// The obfuscation uses string array + rotation. Let me find the string array.
// Look for large arrays of strings
const arrayMatch = js.match(/var\s+\w+\s*=\s*\[([^\]]{1000,})\]/);
if (arrayMatch) {
    console.log('\n=== Found string array (first 3000 chars) ===');
    console.log(arrayMatch[0].substring(0, 3000));
}

// Look for common obfuscation patterns - hex strings
const hexStrings = [...js.matchAll(/'0x[a-f0-9]+'/gi)];
console.log('\nHex strings count:', hexStrings.length);

// Look for the string array function
const strFuncMatch = js.match(/function\s+\w+\(\w+,\s*\w+\)\s*\{[^}]*return\s+\w+\[/);
if (strFuncMatch) {
    console.log('\n=== String decoder function ===');
    console.log(strFuncMatch[0]);
}

// Let's try a different approach - search for encoded versions of key strings
// 'download-token' in various encodings
const searchPatterns = [
    'download', // plain
    '646f776e6c6f6164', // hex for 'download'
    'ZG93bmxvYWQ', // base64 for 'download'
    'mlx', // the root id
    '6d6c78', // hex for 'mlx'
    'token',
    '746f6b656e', // hex for 'token'
    'api-path',
    'api_path',
];

for (const pat of searchPatterns) {
    const idx = js.indexOf(pat);
    if (idx > -1) {
        console.log(`\nFound "${pat}" at ${idx}:`);
        console.log(js.substring(Math.max(0, idx - 100), idx + 200));
    }
}

// Look for common patterns used in obfuscated code to make HTTP requests
// Usually uses something like `new (window['XMLHttp'+'Request']())` or `window.fetch`
const windowRefs = [...js.matchAll(/window\[/gi)];
console.log('\nwindow[] references:', windowRefs.length);

// Check for encoded strings that decode to our target strings
// The obfuscation often uses a large array of strings and a rotation function
// Let me extract the first large array and check its contents
const firstBigArray = js.match(/=\s*\[((?:'[^']*',?\s*){20,})\]/);
if (firstBigArray) {
    const strings = firstBigArray[1].match(/'([^']*)'/g)?.map(s => s.slice(1, -1));
    if (strings) {
        console.log(`\n=== String array (${strings.length} items) ===`);
        // Filter for interesting strings
        const interesting = strings.filter(s =>
            /download|token|fetch|post|mlx|api|path|csrf|header|content|episode/i.test(s)
        );
        console.log('Interesting strings:', interesting);

        // Also show ALL strings for analysis
        console.log('\nAll strings:');
        strings.forEach((s, i) => console.log(`  ${i}: ${s}`));
    }
}
