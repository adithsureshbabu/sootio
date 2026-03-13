import { config } from 'dotenv';
config();

const { resolveHttpStreamUrl } = await import('./lib/http-streams/resolvers/http-resolver.js');

// Test resolving one of the ouo.io links
const testUrls = [
    'https://ouo.io/1VfaFd',  // 1080p
    'https://ouo.io/qxHFNNJ', // 720p
];

for (const url of testUrls) {
    console.log(`\n=== Resolving: ${url} ===`);
    try {
        const resolved = await resolveHttpStreamUrl(url);
        console.log('Resolved:', resolved);
        if (resolved) {
            // Check if the resolved URL is a video
            const isVideo = /pixeldrain|\.mp4|\.mkv|video/i.test(resolved);
            console.log('Is video URL:', isVideo);
        }
    } catch (e) {
        console.error('Resolution failed:', e.message);
    }
}
