// PostgreSQL-backed hash cache helper. All calls are best-effort and no-op when
// not configured or when the driver is unavailable.

import * as config from '../config.js';
import { closePool, getPool, initPool } from './postgres-client.js';

let initTried = false;
let isClosing = false;
let cleanupIntervalId = null;
let initPromise = null;
const debug = (process.env.DEBRID_DEBUG_LOGS === 'true' || process.env.RD_DEBUG_LOGS === 'true' || process.env.SQLITE_DEBUG_LOGS === 'true' || process.env.DEBUG_SQLITE === 'true');

function isEnabled() {
  return Boolean(config.SQLITE_CACHE_ENABLED);
}

async function ensureConnected() {
  if (isClosing) {
    if (debug) console.log('[POSTGRES-CACHE] Not connecting: shutting down in progress');
    return false;
  }
  if (!isEnabled()) {
    if (!initTried) {
      console.log('[POSTGRES-CACHE] Cache disabled');
      initTried = true;
    }
    return false;
  }

  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      const pool = await initPool();
      await pool.query(`
        CREATE TABLE IF NOT EXISTS hash_cache (
          provider TEXT NOT NULL,
          hash TEXT NOT NULL,
          cached BOOLEAN DEFAULT FALSE,
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          PRIMARY KEY (provider, hash)
        )
      `);
      await pool.query('CREATE INDEX IF NOT EXISTS idx_hash_cache_updated_at ON hash_cache(updated_at)');

      if (!initTried) {
        console.log('[POSTGRES-CACHE] Cache enabled');
        initTried = true;
      }
      return true;
    } catch (e) {
      if (!initTried) {
        console.log(`[POSTGRES-CACHE] Init failed: ${e?.message || e}`);
        initTried = true;
      }
      initPromise = null;
      return false;
    }
  })();

  return initPromise;
}

export async function checkHashesCached(provider, hashes = []) {
  if (debug) {
    console.log(`[POSTGRES-CACHE] [${provider}] Starting hash check for ${hashes.length} hashes`);
  }

  const ok = await ensureConnected();
  if (!ok || !Array.isArray(hashes) || hashes.length === 0) {
    if (debug) {
      console.log(`[POSTGRES-CACHE] [${provider}] Connection not OK (${!ok}) or no hashes (${hashes.length}), returning empty set`);
    }
    return new Set();
  }

  try {
    const lowered = hashes.map((hash) => String(hash).toLowerCase());
    const sql = `
      SELECT DISTINCT hash
      FROM hash_cache
      WHERE provider = $1
        AND hash = ANY($2)
        AND cached = true
    `;

    const pool = getPool();
    const startTime = Date.now();
    const result = await pool.query(sql, [String(provider).toLowerCase(), lowered]);
    const duration = Date.now() - startTime;

    const hits = new Set(result.rows.map((row) => String(row.hash).toLowerCase()));

    if (debug) {
      const sample = Array.from(hits).slice(0, 5);
      console.log(`[POSTGRES-CACHE] [${provider}] DB hash check: asked=${lowered.length} hits=${hits.size} sample=[${sample.join(', ')}] took=${duration}ms`);
    }
    return hits;
  } catch (error) {
    if (debug) {
      console.error(`[POSTGRES-CACHE] [${provider}] Error in hash check: ${error.message}`);
    }
    return new Set();
  }
}

export async function upsertHashes(provider, statuses = []) {
  if (debug) {
    console.log(`[POSTGRES-CACHE] [${provider}] Starting bulk upsert for ${statuses.length} statuses`);
  }

  const ok = await ensureConnected();
  if (!ok || !Array.isArray(statuses) || statuses.length === 0) {
    if (debug) {
      console.log(`[POSTGRES-CACHE] [${provider}] Connection not OK (${!ok}) or no statuses (${statuses.length}), returning false`);
    }
    return false;
  }

  const pool = getPool();
  const sql = `
    INSERT INTO hash_cache (provider, hash, cached, updated_at)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (provider, hash)
    DO UPDATE SET cached = EXCLUDED.cached, updated_at = EXCLUDED.updated_at
  `;

  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const status of statuses) {
        const hash = String(status?.hash || '').toLowerCase();
        const cached = Boolean(status?.cached);
        if (!hash) continue;
        await client.query(sql, [String(provider).toLowerCase(), hash, cached]);
      }
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      console.error(`[POSTGRES-CACHE] [${provider}] Error in bulk upsert: ${error.message}`);
      return false;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error(`[POSTGRES-CACHE] [${provider}] Error obtaining client: ${error.message}`);
    return false;
  }
}

function setupCleanupJob() {
  if (cleanupIntervalId) {
    clearInterval(cleanupIntervalId);
    cleanupIntervalId = null;
  }

  const ttlDays = parseInt(process.env.SQLITE_CACHE_TTL_DAYS || '0', 10);
  if (ttlDays > 0) {
    cleanupIntervalId = setInterval(async () => {
      try {
        const pool = getPool();
        const startTime = Date.now();
        const result = await pool.query(
          'DELETE FROM hash_cache WHERE updated_at < NOW() - ($1::int * INTERVAL \'1 day\')',
          [ttlDays]
        );
        const duration = Date.now() - startTime;

        if (result.rowCount > 0) {
          console.log(`[POSTGRES-CACHE] Cleaned up ${result.rowCount} expired hash cache entries in ${duration}ms`);
        } else if (debug) {
          console.log(`[POSTGRES-CACHE] No expired hash cache entries to clean up (checked in ${duration}ms)`);
        }
      } catch (error) {
        console.error(`[POSTGRES-CACHE] Error cleaning up expired hash cache entries: ${error.message}`);
      }
    }, 30 * 60 * 1000);
  } else if (debug) {
    console.log('[POSTGRES-CACHE] TTL cleanup not configured (SQLITE_CACHE_TTL_DAYS is 0 or not set)');
  }
}

export async function closeConnection() {
  console.log('[POSTGRES-CACHE] Closing Postgres connection...');
  isClosing = true;

  if (cleanupIntervalId) {
    clearInterval(cleanupIntervalId);
    cleanupIntervalId = null;
  }

  try {
    await closePool();
    console.log('[POSTGRES-CACHE] Postgres pool closed');
  } catch (error) {
    console.error(`[POSTGRES-CACHE] Error closing Postgres pool: ${error.message}`);
  }

  initTried = false;
  initPromise = null;
  isClosing = false;
}

export async function initCleanup() {
  if (await ensureConnected()) {
    setupCleanupJob();
  }
}

export { isEnabled };

export default { checkHashesCached, upsertHashes, closeConnection, initCleanup, isEnabled };
