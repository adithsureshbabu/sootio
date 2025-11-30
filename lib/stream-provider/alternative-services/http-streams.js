/**
 * HTTP streaming services with SQLite caching
 * Wraps 4KHDHub, HDHub4u, MKVCinemas, UHDMovies, and MoviesDrive
 * with the shared cache-manager flow.
 */

import { get4KHDHubStreams, getHDHub4uStreams, getMKVCinemasStreams } from '../../http-streams.js';
import { getUHDMoviesStreams } from '../../uhdmovies.js';
import { getMoviesDriveStreams } from '../../moviesdrive.js';
import { getCachedTorrents } from '../caching/cache-manager.js';
import { wrapHttpStreamsWithResolver } from '../utils/url-validation.js';
import { withTimeout, HTTP_STREAMING_TIMEOUT_MS } from '../config/timeouts.js';

function buildCacheKey(id, suffix, season, episode) {
  if (season != null && episode != null) {
    return `${id}-${suffix}-${season}:${episode}`;
  }
  return `${id}-${suffix}`;
}

/**
 * Fetch HTTP streaming results with SQLite caching.
 * Supports both movies and series (season/episode provided via options).
 */
export async function getHttpStreamingStreams(config, type, id, options = {}) {
  const { season = null, episode = null } = options;

  const use4KHDHub = config.http4khdhub !== false;
  const useHDHub4u = config.httpHDHub4u !== false;
  const useUHDMovies = config.httpUHDMovies !== false;
  const useMoviesDrive = config.httpMoviesDrive !== false;
  const useMKVCinemas = config.httpMKVCinemas !== false;

  const resolverWrapper = streams => wrapHttpStreamsWithResolver(streams, config.host);
  const tasks = [];

  const addTask = (label, cacheKey, searchFn) => {
    tasks.push(
      withTimeout(
        getCachedTorrents('httpstreaming', type, cacheKey, config, searchFn)
          .then(resolverWrapper),
        HTTP_STREAMING_TIMEOUT_MS,
        label
      )
    );
  };

  if (use4KHDHub) {
    addTask(
      '4KHDHub',
      buildCacheKey(id, '4khdhub', season, episode),
      () => get4KHDHubStreams(id, type, season, episode, config)
    );
  }

  if (useHDHub4u) {
    addTask(
      'HDHub4u',
      buildCacheKey(id, 'hdhub4u', season, episode),
      () => getHDHub4uStreams(id, type, season, episode)
    );
  }

  if (useMKVCinemas) {
    addTask(
      'MKVCinemas',
      buildCacheKey(id, 'mkvcinemas', season, episode),
      () => getMKVCinemasStreams(id, type, season, episode, config)
    );
  }

  if (useUHDMovies) {
    addTask(
      'UHDMovies',
      buildCacheKey(id, 'uhdmovies', season, episode),
      () => getUHDMoviesStreams(id, id, type, season, episode, config)
    );
  }

  if (useMoviesDrive) {
    addTask(
      'MoviesDrive',
      buildCacheKey(id, 'moviesdrive', season, episode),
      () => getMoviesDriveStreams(id, id, type, season, episode, config)
    );
  }

  if (tasks.length === 0) {
    return [];
  }

  const settled = await Promise.allSettled(tasks);

  return settled
    .filter(result => result.status === 'fulfilled')
    .flatMap(result => (Array.isArray(result.value) ? result.value : []))
    .filter(Boolean);
}
