import axios from 'axios';

// Get the page via FlareSolverr with extra wait time for JS to execute
const resp = await axios.post('http://100.104.177.44:8191/v1', {
    cmd: 'request.get',
    url: 'https://mkvdrama.net/yesterday-2026',
    maxTimeout: 90000,
    // Wait for the download section to load
    returnOnlyCookies: false
}, { timeout: 95000 });

const html = resp.data?.solution?.response || '';
console.log('HTML length:', html.length);

// Check if downloads section has been populated
const downloadsIdx = html.indexOf('id="downloads"');
if (downloadsIdx > -1) {
    console.log('\n=== Downloads section ===');
    console.log(html.substring(downloadsIdx, downloadsIdx + 5000));
}

// Check mlx-root content
const mlxIdx = html.indexOf('id="mlx-root"');
if (mlxIdx > -1) {
    console.log('\n=== mlx-root section ===');
    // Get from mlx-root to the next major section
    const endIdx = html.indexOf('class="socialts"', mlxIdx);
    const mlxContent = html.substring(mlxIdx, endIdx > -1 ? endIdx : mlxIdx + 10000);
    console.log(mlxContent);
}

// Check if "Loading..." is still present
console.log('\nStill loading:', html.includes('Loading...'));

// Check for eplister
const eplisterIdx = html.indexOf('eplister');
if (eplisterIdx > -1) {
    const end2 = html.indexOf('</div>', eplisterIdx + 5000);
    console.log('\n=== Episode list ===');
    console.log(html.substring(eplisterIdx - 100, eplisterIdx + 3000));
}

// Look for download-related elements that might have been added by JS
const dlPatterns = ['dlbox', 'download-link', 'btn-download', 'dl-item', 'download-item', 'linkdl', 'dlbod'];
for (const p of dlPatterns) {
    if (html.includes(p)) {
        const idx = html.indexOf(p);
        console.log(`\n=== Found ${p} at ${idx} ===`);
        console.log(html.substring(Math.max(0, idx - 200), idx + 1000));
    }
}
