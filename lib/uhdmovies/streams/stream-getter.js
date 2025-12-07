import { fetchAndSearchMetadata } from './metadata-fetcher.js';
import { extractAndValidateLinks } from './link-validator.js';
import { extractLinksWithoutValidation } from './link-validator-preview.js';
import { formatStreamsWithFlags } from './stream-formatter.js';
import { extractTvShowDownloadLinks } from '../extraction/tv/links.js';
import { extractDownloadLinks } from '../extraction/movie/links.js';
import { resolveUHDMoviesUrl } from '../resolvers/url-resolver.js';

/**
 * Check if lazy-load mode is enabled (default: true)
 */
function isLazyLoadEnabled() {
  return process.env.DISABLE_HTTP_STREAM_LAZY_LOAD !== 'true';
}

// Main function to get streams for TMDB content
// REFACTORED: Broken down from ~750 lines to ~80 lines with helper modules
export async function getUHDMoviesStreams(imdbId, tmdbId, mediaType = 'movie', season = null, episode = null, config = {}) {
  // Normalize mediaType: 'series' -> 'tv' for consistent internal handling
  const normalizedMediaType = mediaType === 'series' ? 'tv' : mediaType;
  console.log(`[UHDMovies] Attempting to fetch streams for TMDB ID: ${tmdbId}, Type: ${normalizedMediaType}${normalizedMediaType === 'tv' ? `, S:${season}E:${episode}` : ''}`);

  // Create unique timer IDs to prevent duplicates when concurrent requests for same content
  const requestId = Math.random().toString(36).substring(7);

  try {
    // 1. Fetch metadata from Cinemeta and search UHDMovies
    const { mediaInfo, matchingResult, scoredResults, matchingResults } = await fetchAndSearchMetadata(
      imdbId,
      tmdbId,
      normalizedMediaType,
      season,
      requestId
    );

    // Check if we found a match
    if (!matchingResult) {
      console.log(`[UHDMovies] No matching content found.`);
      return [];
    }

    // 2. Extract and validate SID links from the matched page
    let cachedLinks;

    // CHECK FOR LAZY-LOAD MODE
    if (isLazyLoadEnabled()) {
      console.log('[UHDMovies] Lazy-load enabled: skipping expensive SID validation (8s per link!)');
      console.log('[UHDMovies] Preview streams will be returned instantly - validation happens on click');

      // Use fast preview mode - no validation!
      cachedLinks = await extractLinksWithoutValidation(
        matchingResult,
        matchingResults,
        scoredResults,
        null,
        normalizedMediaType,
        season,
        episode,
        mediaInfo.year,
        extractTvShowDownloadLinks,
        extractDownloadLinks
      );
    } else {
      // LEGACY MODE: Full validation (SLOW - 8s timeout per link!)
      console.log('[UHDMovies] Lazy-load disabled: validating all SID links (legacy mode - SLOW!)');

      cachedLinks = await extractAndValidateLinks(
        matchingResult,
        matchingResults,
        scoredResults,
        null, // downloadInfo - not needed anymore
        normalizedMediaType,
        season,
        episode,
        mediaInfo.year,
        extractTvShowDownloadLinks,
        extractDownloadLinks
      );
    }

    // Only resolve links if NOT in lazy load mode, otherwise return SID URLs for lazy resolution
    let validStreams = [];
    if (!isLazyLoadEnabled() && cachedLinks && cachedLinks.length > 0) {
      // Eager resolution mode: resolve all links now (slower but validates now)
      console.log(`[UHDMovies] Resolving ${cachedLinks.length} link(s) to final direct URLs (eager mode)`);
      const resolvedLinks = [];
      const results = await Promise.allSettled(
        cachedLinks.map(async (link) => {
          const sidUrl = link.url || link.link;
          const resolved = await resolveUHDMoviesUrl(sidUrl);
          const finalUrl = typeof resolved === 'string' ? resolved : resolved?.url;
          if (finalUrl && !finalUrl.includes('googleusercontent.com')) {
            const resolvedSize = typeof resolved === 'object' ? resolved.size : null;
            const resolvedName = typeof resolved === 'object' ? resolved.fileName : null;
            return {
              ...link,
              url: finalUrl,
              needsResolution: false,
              size: resolvedSize || link.size,
              rawQuality: resolvedName || link.rawQuality,
              fullTitle: resolvedName || link.fullTitle
            };
          }
          return null;
        })
      );
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) resolvedLinks.push(r.value);
      }

      // Check if we have any valid links after eager resolution
      if (!resolvedLinks || resolvedLinks.length === 0) {
        console.log('[UHDMovies] No valid direct URLs found after eager resolution.');
        return [];
      }

      validStreams = formatStreamsWithFlags(resolvedLinks);
    } else if (cachedLinks && cachedLinks.length > 0) {
      // Lazy load mode: return SID URLs for resolution on demand (faster response)
      console.log(`[UHDMovies] Returning ${cachedLinks.length} SID URLs for lazy resolution (faster response)`);

      // Format cached links as streams with encoded URLs for lazy resolution
      validStreams = formatStreamsWithFlags(cachedLinks.map(link => ({
        ...link,
        url: link.url || link.link,  // Keep the SID URL
        needsResolution: true,
        size: link.size,
        rawQuality: link.rawQuality,
        fullTitle: link.fullTitle
      })));
    }

    return validStreams;

  } catch (error) {
    console.error(`[UHDMovies] A critical error occurred in getUHDMoviesStreams for ${tmdbId}: ${error.message}`);
    if (error.stack) console.error(error.stack);
    return [];
  }
}
