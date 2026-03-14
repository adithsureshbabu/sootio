Add a new link resolver for HTTP stream URL resolution chains.

Arguments: $ARGUMENTS
Format: `<resolver-name> <domain-pattern>`
Example: `pixeldrain pixeldrain.com`
Example: `doodstream doodstream.com`

Link resolvers convert indirect hosting pages (e.g. HubCloud, VixSrc, PixelDrain) into direct video stream URLs.

## Instructions

### Step 1 — Read existing resolvers

Read both files:
- `lib/http-streams/resolvers/http-resolver.js` — main dispatch resolver, understand how domains are matched and routed
- `lib/http-streams/resolvers/link-processor.js` — link processing utilities

Note the dispatch pattern: the resolver checks the URL against known domain patterns and calls the appropriate handler.

### Step 2 — Decide implementation approach

**Option A — Add a case to the existing http-resolver.js** (preferred for simple resolvers):
If the domain just needs a fetch + HTML parse to find a direct link, add a case to the existing dispatch map in `http-resolver.js`.

**Option B — Create a standalone resolver module** (for complex resolvers):
If the resolver needs significant logic (multi-step redirects, JS evaluation, token extraction), create `lib/http-streams/resolvers/<name>-resolver.js`.

### Step 3A — Add to existing resolver (Option A)

Read `lib/http-streams/resolvers/http-resolver.js` in full, then add a handler for the new domain.

The general pattern for a simple resolver case:

```javascript
// Inside the domain dispatch in http-resolver.js:
if (url.includes('<domain-pattern>')) {
    return resolve<Name>Url(url);
}

// Handler function:
async function resolve<Name>Url(url) {
    try {
        const response = await makeRequest(url, { parseHTML: true });
        if (!response?.document) return null;
        const $ = response.document;

        // TODO: find the direct video link in the page
        // Common patterns:
        // 1. Direct <video src="..."> or <source src="...">
        const videoSrc = $('video source, video[src]').first().attr('src') ||
                         $('video').first().attr('src');
        if (videoSrc) return videoSrc;

        // 2. Download button href
        const downloadHref = $('a.download-btn, a[href*=".mp4"], a[href*=".mkv"]').first().attr('href');
        if (downloadHref) return downloadHref;

        // 3. JSON config in a script tag
        const scriptContent = $('script').text();
        const urlMatch = scriptContent.match(/"(?:file|src|url)"\s*:\s*"(https?:\/\/[^"]+\.(?:mp4|mkv|m3u8)[^"]*)"/);
        if (urlMatch) return urlMatch[1];

        return null;
    } catch (error) {
        console.error(`[Resolver] <Name> failed for ${url}: ${error.message}`);
        return null;
    }
}
```

### Step 3B — Create standalone resolver module (Option B)

Create `lib/http-streams/resolvers/<name>-resolver.js`:

```javascript
/**
 * <Name> Link Resolver
 * Resolves <domain-pattern> URLs to direct video streams.
 */

import { makeRequest } from '../utils/http.js';

/**
 * Resolve a <Name> URL to a direct video stream URL.
 * @param {string} url - <Name> URL (e.g. https://<domain>/file/abc123)
 * @returns {Promise<string|null>} Direct video URL or null
 */
export async function resolve<Name>Url(url) {
    try {
        // Step 1: fetch the page
        const response = await makeRequest(url, { parseHTML: true });
        if (!response?.document) return null;
        const $ = response.document;

        // TODO: implement the actual extraction logic for this hoster
        // Common patterns to try:

        // Direct video source
        const videoSrc = $('video source[src], video[src]').first().attr('src');
        if (videoSrc && /\.(mp4|mkv|m3u8)/.test(videoSrc)) return videoSrc;

        // API token extraction (some hosters use a token to build the final URL)
        const scripts = $('script').map((_, s) => $(s).html()).get().join('\n');
        const tokenMatch = scripts.match(/(?:file|src|url)\s*[:=]\s*['"]([^'"]+\.(?:mp4|mkv|m3u8)[^'"]*)['"]/)
        if (tokenMatch) return tokenMatch[1];

        // Redirect via response headers (for services that 302 to CDN)
        if (response.url && response.url !== url) return response.url;

        console.log(`[<Name>Resolver] Could not extract direct URL from ${url}`);
        return null;

    } catch (error) {
        console.error(`[<Name>Resolver] Failed for ${url}: ${error.message}`);
        return null;
    }
}
```

Then register the new resolver in `lib/http-streams/resolvers/http-resolver.js` by adding it to the dispatch logic.

### Step 4 — Export from http-streams/index.js (only for Option B)

Read `lib/http-streams/index.js` and add:

```javascript
export { resolve<Name>Url } from './resolvers/<name>-resolver.js';
```

### Step 5 — Summary

Report:
- Files created/modified
- Domain pattern registered: `<domain-pattern>`
- Remind the user to:
  1. Test the resolver with a real URL from the target hoster
  2. Fill in the `TODO` extraction logic based on the hoster's actual page structure
  3. Handle edge cases: Cloudflare protection, token-based URLs, regional restrictions
