import * as config from '../config.js';
import * as postgresHashCache from './postgres-hash-cache.js';
import * as sqliteHashCache from './sqlite-hash-cache.js';

const backend = config.CACHE_BACKEND === 'postgres' ? postgresHashCache : sqliteHashCache;

export const { checkHashesCached, upsertHashes, closeConnection, initCleanup, isEnabled } = backend;

export default backend;
