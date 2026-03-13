import axios from 'axios';

const resp = await axios.post('http://100.104.177.44:8191/v1', {
    cmd: 'request.get',
    url: 'https://mkvdrama.net/yesterday-2026',
    maxTimeout: 60000
}, { timeout: 65000 });

const html = resp.data?.solution?.response || '';

// Find 720p and 1080p context
for (const p of ['720p', '1080p']) {
    const idx = html.indexOf(p);
    if (idx > -1) {
        console.log('--- ' + p + ' context ---');
        console.log(html.substring(Math.max(0, idx - 500), idx + 500));
        console.log();
    }
}

// Find all href links - filter for non-static ones
const allHrefs = [...html.matchAll(/href=["']([^"']+)["']/gi)].map(m => m[1]);
const interesting = allHrefs.filter(h => {
    if (/static|fonts\.g|\.css|favicon|google|manifest/.test(h)) return false;
    if (h === '#' || h === '/') return false;
    return true;
});
console.log('Interesting hrefs:');
interesting.forEach(h => console.log(' ', h));

// Also search for onclick or data attributes that might contain download URLs
const dataAttrs = [...html.matchAll(/data-[\w-]+="([^"]+)"/gi)].map(m => m[0] + ' = ' + m[1]);
console.log('\nData attributes with URLs:');
dataAttrs.filter(d => /http|download|link/i.test(d)).forEach(d => console.log(' ', d));

// Check for JavaScript that loads download links dynamically
const scriptBlocks = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]).filter(s => s.length > 50);
console.log('\nScript blocks with download/episode content:');
scriptBlocks.forEach((s, i) => {
    if (/download|episode|720|1080|ouo|filecrypt|pixeldrain/i.test(s)) {
        console.log(`\n  Script block ${i} (${s.length} chars):`);
        console.log(s.substring(0, 2000));
    }
});
