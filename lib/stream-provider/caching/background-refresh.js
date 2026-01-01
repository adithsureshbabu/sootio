/**
 * Background cache refresh functionality
 * Keeps cache fresh without blocking user requests
 */

import { storeCacheResults } from './cache-manager.js';

function getCacheResultKey(item, provider) {
  if (!item) return null;
  if (provider === 'httpstreaming' && item.url) {
    return `url:${String(item.url).toLowerCase()}`;
  }
  const hash = item.hash || item.infoHash || item.InfoHash;
  if (hash) return `hash:${String(hash).toLowerCase()}`;
  const name = item.name || item.title || item.Title;
  if (name) return `name:${String(name).toLowerCase()}`;
  return null;
}

function mergeCacheResults(existingResults, freshResults, provider) {
  const merged = [];
  const indexByKey = new Map();
  const preferFresh = provider === 'httpstreaming';

  const addResult = (item, allowOverwrite) => {
    const key = getCacheResultKey(item, provider);
    if (!key) {
      merged.push(item);
      return false;
    }
    if (!indexByKey.has(key)) {
      indexByKey.set(key, merged.length);
      merged.push(item);
      return true;
    }
    if (allowOverwrite) {
      merged[indexByKey.get(key)] = item;
    }
    return false;
  };

  (existingResults || []).forEach(item => addResult(item, false));
  let newCount = 0;
  (freshResults || []).forEach(item => {
    const wasNew = addResult(item, preferFresh);
    if (wasNew) newCount += 1;
  });

  return { merged, newCount };
}

/**
 * Background task to refresh cache with new data
 * Runs asynchronously without blocking the main request
 *
 * @param {string} provider - Debrid provider name
 * @param {string} type - Content type ('movie' or 'series')
 * @param {string} id - Content ID
 * @param {Object} config - User configuration
 * @param {Function} searchFn - Function to execute the search
 * @param {string} cacheKey - Cache key for storage
 * @param {Array} existingResults - Current cached results
 * @returns {Promise<void>}
 */
export async function refreshCacheInBackground(provider, type, id, config, searchFn, cacheKey, existingResults) {
  try {
    console.log(`[CACHE] Starting background refresh for ${cacheKey}`);

    // Get fresh results with the search function
    const freshResults = await searchFn(true);

    if (freshResults && freshResults.length > 0) {
      // Process fresh results and update cache with any that are not already cached
      const nonPersonalFresh = freshResults.filter(r => !r.isPersonal);

      if (nonPersonalFresh.length > 0) {
        const existingKeys = new Set(
          (existingResults || [])
            .map(item => getCacheResultKey(item, provider))
            .filter(Boolean)
        );

        const newFreshCount = nonPersonalFresh.reduce((count, item) => {
          const key = getCacheResultKey(item, provider);
          if (!key || !existingKeys.has(key)) return count + 1;
          return count;
        }, 0);

        if (newFreshCount > 0) {
          const { merged } = mergeCacheResults(existingResults, nonPersonalFresh, provider);
          console.log(`[CACHE] Background refresh found ${newFreshCount} new results to cache for ${cacheKey}`);
          await storeCacheResults(null, cacheKey, merged, type, provider);
        } else {
          console.log(`[CACHE] Background refresh: no new results to cache for ${cacheKey}`);
        }
      }
    }

    console.log(`[CACHE] Background refresh completed for ${cacheKey}`);
  } catch (err) {
    console.error(`[CACHE] Background refresh failed for ${cacheKey}:`, err.message);
  }
}
