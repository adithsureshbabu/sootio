import { config } from 'dotenv';
config();

const { loadMkvDramaContent } = await import('./lib/http-streams/providers/mkvdrama/search.js');
const { getMkvDramaStreams } = await import('./lib/http-streams/providers/mkvdrama/streams.js');

console.log('=== Step 1: loadMkvDramaContent ===');
const content = await loadMkvDramaContent('https://mkvdrama.net/yesterday-2026', null, { season: 1, episode: 1 });
console.log('Title:', content.title);
console.log('Download links:', content.downloadLinks?.length || 0);
if (content.downloadLinks?.length > 0) {
    content.downloadLinks.forEach((l, i) => {
        console.log(`  ${i + 1}. label="${l.label}" quality="${l.quality}" url=${l.url} ep=${l.episodeStart}-${l.episodeEnd}`);
    });
}
console.log('blockedReason:', content.blockedReason || 'none');

console.log('\n=== Step 2: getMkvDramaStreams for tt38856481 S1E1 ===');
const streams = await getMkvDramaStreams('tt38856481', 'series', 1, 1, {});
console.log('Found', streams.length, 'streams:');
streams.forEach((s, i) => {
    console.log(`  ${i + 1}. ${s.name?.replace(/\n/g, ' | ')} - ${s.title?.replace(/\n/g, ' | ')}`);
    if (s.url) console.log('     URL:', s.url.substring(0, 150));
});
