import * as config from '../config.js';
import * as postgresCache from './postgres-cache.js';
import * as sqliteCache from './sqlite-cache.js';

const backend = config.CACHE_BACKEND === 'postgres' ? postgresCache : sqliteCache;

export const {
  upsertCachedMagnet,
  upsertCachedMagnets,
  getCachedHashes,
  getCachedRecord,
  getReleaseCounts,
  clearSearchCache,
  clearTorrentCache,
  clearAllCache,
  closeSqlite,
  isEnabled,
  getCachedSearchResults,
  initSqlite,
  getDatabase
} = backend;

export default backend;
