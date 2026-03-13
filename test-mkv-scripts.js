import axios from 'axios';

const resp = await axios.post('http://100.104.177.44:8191/v1', {
    cmd: 'request.get',
    url: 'https://mkvdrama.net/yesterday-2026',
    maxTimeout: 60000
}, { timeout: 65000 });

const html = resp.data?.solution?.response || '';

// Find ALL script tags
const scripts = [...html.matchAll(/<script[^>]*(?:src="([^"]*)")?[^>]*>([\s\S]*?)<\/script>/gi)];
console.log(`Found ${scripts.length} script tags:\n`);

scripts.forEach((m, i) => {
    const src = m[1];
    const inline = m[2]?.trim();
    if (src) {
        console.log(`${i+1}. External: ${src}`);
    } else if (inline && inline.length > 20) {
        console.log(`${i+1}. Inline (${inline.length} chars): ${inline.substring(0, 200)}`);
    } else if (inline) {
        console.log(`${i+1}. Inline: ${inline}`);
    } else {
        console.log(`${i+1}. Empty/JSON-LD`);
    }
});

// Check for dynamically injected scripts (may be in noscript or other areas)
const noscripts = [...html.matchAll(/<noscript[^>]*>([\s\S]*?)<\/noscript>/gi)];
console.log('\nNoscript tags:', noscripts.length);

// Look for any JS that mentions download
const inlineScripts = scripts.filter(m => m[2]?.trim() && m[2].length > 20);
console.log('\n=== Inline scripts mentioning download/mlx/token ===');
inlineScripts.forEach((m, i) => {
    const code = m[2].trim();
    if (/download|mlx|token|fetch|XMLHttp/i.test(code)) {
        console.log(`\nScript ${i+1} (${code.length} chars):`);
        console.log(code.substring(0, 2000));
    }
});

// The mlx-root and download section might be loaded by a React/Vue/Svelte app
// Check for __NEXT_DATA__ or similar SSR data
const nextData = html.match(/__NEXT_DATA__/);
const nuxtData = html.match(/__NUXT_DATA__/);
const svelteData = html.match(/__SVELTEKIT/);
console.log('\nFramework detection:');
console.log('Next.js:', !!nextData);
console.log('Nuxt:', !!nuxtData);
console.log('SvelteKit:', !!svelteData);

// Check for module/import scripts
const moduleScripts = scripts.filter(m => m[0].includes('type="module"'));
console.log('\nModule scripts:', moduleScripts.length);
moduleScripts.forEach(m => {
    if (m[1]) console.log('  src:', m[1]);
    else console.log('  inline:', m[2]?.substring(0, 200));
});
