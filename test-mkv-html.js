import axios from 'axios';

// Get the full rendered page via FlareSolverr
const resp = await axios.post('http://100.104.177.44:8191/v1', {
    cmd: 'request.get',
    url: 'https://mkvdrama.net/yesterday-2026',
    maxTimeout: 60000
}, { timeout: 65000 });

const html = resp.data?.solution?.response || '';
console.log('HTML length:', html.length);

// Find the episode list section
const eplIdx = html.indexOf('eplister');
if (eplIdx > -1) {
    console.log('\n=== Episode list section ===');
    console.log(html.substring(eplIdx - 100, eplIdx + 5000));
}

// Find the episodedl/download section
const dlIdx = html.indexOf('episodedl');
if (dlIdx > -1) {
    console.log('\n=== Episode download section ===');
    console.log(html.substring(dlIdx - 100, dlIdx + 5000));
} else {
    console.log('No episodedl found');
}

// Find all elements with "ep" in class name
const epClasses = [...html.matchAll(/class="([^"]*ep[^"]*)"/gi)].map(m => m[1]);
console.log('\n=== Classes with "ep" ===');
const unique = [...new Set(epClasses)];
unique.forEach(c => console.log(' ', c));

// Find the bixbox sections
const bixboxes = [...html.matchAll(/class="bixbox[^"]*"[\s\S]*?(?=class="bixbox|$)/gi)];
console.log('\n=== Bixbox sections ===');
bixboxes.forEach((m, i) => {
    const section = m[0].substring(0, 500);
    console.log(`\nBixbox ${i+1}:`, section);
});

// Look for data-download attributes more broadly
const downloadDataAttrs = [...html.matchAll(/data-download[^=]*="[^"]*"/gi)];
console.log('\n=== All data-download attributes ===');
downloadDataAttrs.forEach(m => console.log(' ', m[0]));

// Look for the actual episode download area with all its HTML
const dlAreaIdx = html.indexOf('data-download-token');
if (dlAreaIdx > -1) {
    console.log('\n=== Download token area (5000 chars around it) ===');
    console.log(html.substring(Math.max(0, dlAreaIdx - 2000), dlAreaIdx + 3000));
}
