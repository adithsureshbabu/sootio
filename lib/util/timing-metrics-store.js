/**
 * Timing Metrics Store
 * Records provider response times for adaptive timeout calculation.
 * Supports PostgreSQL and SQLite backends based on CACHE_BACKEND config.
 */
import * as config from '../config.js';
import { getPool, initPool } from './postgres-client.js';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Module state
let sqliteDb = null;
let initPromise = null;
let writeQueue = [];
let flushIntervalId = null;
let cleanupIntervalId = null;

// Configuration
const FLUSH_INTERVAL_MS = 5000;      // Flush writes every 5 seconds
const MAX_QUEUE_SIZE = 100;          // Force flush if queue exceeds this
const RETENTION_MS = 24 * 60 * 60 * 1000; // Keep metrics for 24 hours
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // Cleanup every hour

const debug = process.env.TIMING_METRICS_DEBUG === 'true';

/**
 * Get the appropriate backend based on config
 */
function getBackend() {
  return config.CACHE_BACKEND === 'postgres' ? 'postgres' : 'sqlite';
}

/**
 * Normalize provider name for consistent storage
 */
function normalizeProvider(provider) {
  return String(provider || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Ensure data directory exists
 */
function ensureDataDirectory() {
  const dataDir = join(__dirname, '..', '..', 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
    if (debug) console.log(`[TIMING-METRICS] Created data directory: ${dataDir}`);
  }
  return dataDir;
}

/**
 * Initialize PostgreSQL schema
 */
async function initPostgresSchema() {
  const pool = await initPool();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS timing_metrics (
      id SERIAL PRIMARY KEY,
      provider TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result_count INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_timing_provider_created
    ON timing_metrics(provider, created_at DESC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_timing_created_at
    ON timing_metrics(created_at)
  `);

  if (debug) console.log('[TIMING-METRICS] PostgreSQL schema initialized');
}

/**
 * Initialize SQLite schema
 */
function initSqliteSchema() {
  const dataDir = ensureDataDirectory();
  const dbPath = join(dataDir, 'timing-metrics.db');

  sqliteDb = new Database(dbPath, { WAL: true });
  sqliteDb.pragma('journal_mode = WAL');
  sqliteDb.pragma('synchronous = NORMAL');
  sqliteDb.pragma('cache_size = 1000');
  sqliteDb.pragma('temp_store = memory');

  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS timing_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result_count INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    )
  `);

  sqliteDb.exec(`
    CREATE INDEX IF NOT EXISTS idx_timing_provider_created
    ON timing_metrics(provider, created_at DESC)
  `);

  sqliteDb.exec(`
    CREATE INDEX IF NOT EXISTS idx_timing_created_at
    ON timing_metrics(created_at)
  `);

  if (debug) console.log(`[TIMING-METRICS] SQLite schema initialized at ${dbPath}`);
}

/**
 * Initialize the timing metrics storage
 */
export async function initTimingMetrics() {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      const backend = getBackend();

      if (backend === 'postgres') {
        await initPostgresSchema();
      } else {
        initSqliteSchema();
      }

      // Start background flush for async writes
      startFlushInterval();

      // Start cleanup job
      startCleanupJob();

      console.log(`[TIMING-METRICS] Initialized with ${backend} backend`);
      return true;
    } catch (error) {
      console.error(`[TIMING-METRICS] Failed to initialize: ${error.message}`);
      initPromise = null;
      return false;
    }
  })();

  return initPromise;
}

/**
 * Start the background flush interval
 */
function startFlushInterval() {
  if (flushIntervalId) return;

  flushIntervalId = setInterval(() => {
    if (writeQueue.length > 0) {
      flushWrites().catch(err => {
        console.error('[TIMING-METRICS] Flush error:', err.message);
      });
    }
  }, FLUSH_INTERVAL_MS);

  if (debug) console.log('[TIMING-METRICS] Background flush started');
}

/**
 * Start the cleanup job
 */
function startCleanupJob() {
  if (cleanupIntervalId) return;

  cleanupIntervalId = setInterval(() => {
    cleanup().catch(err => {
      console.error('[TIMING-METRICS] Cleanup error:', err.message);
    });
  }, CLEANUP_INTERVAL_MS);

  if (debug) console.log('[TIMING-METRICS] Cleanup job started');
}

/**
 * Flush queued writes to database
 */
async function flushWrites() {
  if (writeQueue.length === 0) return;

  const toWrite = writeQueue.splice(0, writeQueue.length);
  const backend = getBackend();

  try {
    if (backend === 'postgres') {
      await flushPostgres(toWrite);
    } else {
      flushSqlite(toWrite);
    }

    if (debug) console.log(`[TIMING-METRICS] Flushed ${toWrite.length} metrics`);
  } catch (error) {
    console.error(`[TIMING-METRICS] Failed to flush ${toWrite.length} metrics:`, error.message);
    // Don't re-queue on failure to avoid memory buildup
  }
}

/**
 * Flush writes to PostgreSQL
 */
async function flushPostgres(metrics) {
  const pool = getPool();

  // Build batch insert
  const values = [];
  const params = [];
  let paramIndex = 1;

  for (const m of metrics) {
    values.push(`($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, to_timestamp($${paramIndex++} / 1000.0))`);
    params.push(m.provider, m.duration_ms, m.status, m.result_count, m.timestamp);
  }

  const sql = `
    INSERT INTO timing_metrics (provider, duration_ms, status, result_count, created_at)
    VALUES ${values.join(', ')}
  `;

  await pool.query(sql, params);
}

/**
 * Flush writes to SQLite
 */
function flushSqlite(metrics) {
  if (!sqliteDb) return;

  const stmt = sqliteDb.prepare(`
    INSERT INTO timing_metrics (provider, duration_ms, status, result_count, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  const insertMany = sqliteDb.transaction((items) => {
    for (const m of items) {
      stmt.run(m.provider, m.duration_ms, m.status, m.result_count, m.timestamp);
    }
  });

  insertMany(metrics);
}

/**
 * Record a timing metric for a provider
 * Non-blocking - queues writes for background processing
 */
export function recordTiming(provider, durationMs, status, resultCount = 0) {
  // Silently skip if not initialized
  if (!initPromise) return;

  const metric = {
    provider: normalizeProvider(provider),
    duration_ms: Math.round(durationMs),
    status, // 'success', 'timeout', 'error'
    result_count: resultCount,
    timestamp: Date.now()
  };

  writeQueue.push(metric);

  // Force flush if queue is too large
  if (writeQueue.length >= MAX_QUEUE_SIZE) {
    flushWrites().catch(err =>
      console.error('[TIMING-METRICS] Flush error:', err.message)
    );
  }
}

/**
 * Get P95 response time for a provider (PostgreSQL)
 */
async function getP95Postgres(provider, cutoffTime, minSamples) {
  const pool = getPool();

  // Use PERCENTILE_CONT for accurate P95 calculation
  const result = await pool.query(`
    WITH filtered AS (
      SELECT duration_ms
      FROM timing_metrics
      WHERE provider = $1
        AND status = 'success'
        AND created_at >= to_timestamp($2 / 1000.0)
    )
    SELECT
      COUNT(*) as sample_count,
      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms) as p95
    FROM filtered
  `, [provider, cutoffTime]);

  const row = result.rows[0];
  if (!row || row.sample_count < minSamples) {
    return null;
  }

  return Math.round(row.p95);
}

/**
 * Get P95 response time for a provider (SQLite)
 */
function getP95Sqlite(provider, cutoffTime, minSamples) {
  if (!sqliteDb) return null;

  // SQLite doesn't have PERCENTILE_CONT, so we calculate manually
  // First get count
  const countResult = sqliteDb.prepare(`
    SELECT COUNT(*) as cnt
    FROM timing_metrics
    WHERE provider = ?
      AND status = 'success'
      AND created_at >= ?
  `).get(provider, cutoffTime);

  if (!countResult || countResult.cnt < minSamples) {
    return null;
  }

  const count = countResult.cnt;
  const p95Index = Math.floor(count * 0.95);

  // Get the value at P95 position
  const result = sqliteDb.prepare(`
    SELECT duration_ms
    FROM timing_metrics
    WHERE provider = ?
      AND status = 'success'
      AND created_at >= ?
    ORDER BY duration_ms ASC
    LIMIT 1 OFFSET ?
  `).get(provider, cutoffTime, p95Index);

  return result ? result.duration_ms : null;
}

/**
 * Get P95 response time for a provider
 */
export async function getP95(provider, options = {}) {
  const {
    windowMs = 60 * 60 * 1000, // 1 hour default
    minSamples = 10
  } = options;

  // Ensure initialized
  if (!initPromise) {
    await initTimingMetrics();
  }

  const normalizedProvider = normalizeProvider(provider);
  const backend = getBackend();
  const cutoffTime = Date.now() - windowMs;

  try {
    if (backend === 'postgres') {
      return await getP95Postgres(normalizedProvider, cutoffTime, minSamples);
    } else {
      return getP95Sqlite(normalizedProvider, cutoffTime, minSamples);
    }
  } catch (error) {
    console.error(`[TIMING-METRICS] Error getting P95 for ${provider}:`, error.message);
    return null;
  }
}

/**
 * Get statistics for a provider (PostgreSQL)
 */
async function getStatsPostgres(provider, cutoffTime) {
  const pool = getPool();

  const result = await pool.query(`
    SELECT
      COUNT(*) as total_count,
      COUNT(*) FILTER (WHERE status = 'success') as success_count,
      COUNT(*) FILTER (WHERE status = 'timeout') as timeout_count,
      COUNT(*) FILTER (WHERE status = 'error') as error_count,
      AVG(duration_ms) FILTER (WHERE status = 'success') as avg_duration,
      PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE status = 'success') as p50,
      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE status = 'success') as p95,
      MIN(duration_ms) FILTER (WHERE status = 'success') as min_duration,
      MAX(duration_ms) FILTER (WHERE status = 'success') as max_duration
    FROM timing_metrics
    WHERE provider = $1
      AND created_at >= to_timestamp($2 / 1000.0)
  `, [provider, cutoffTime]);

  const row = result.rows[0];
  if (!row || row.total_count === 0) {
    return null;
  }

  return {
    totalCount: parseInt(row.total_count),
    successCount: parseInt(row.success_count),
    timeoutCount: parseInt(row.timeout_count),
    errorCount: parseInt(row.error_count),
    avgDuration: row.avg_duration ? Math.round(row.avg_duration) : null,
    p50: row.p50 ? Math.round(row.p50) : null,
    p95: row.p95 ? Math.round(row.p95) : null,
    minDuration: row.min_duration,
    maxDuration: row.max_duration,
    successRate: row.total_count > 0 ? (row.success_count / row.total_count * 100).toFixed(1) : 0
  };
}

/**
 * Get statistics for a provider (SQLite)
 */
function getStatsSqlite(provider, cutoffTime) {
  if (!sqliteDb) return null;

  const result = sqliteDb.prepare(`
    SELECT
      COUNT(*) as total_count,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
      SUM(CASE WHEN status = 'timeout' THEN 1 ELSE 0 END) as timeout_count,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_count,
      AVG(CASE WHEN status = 'success' THEN duration_ms ELSE NULL END) as avg_duration,
      MIN(CASE WHEN status = 'success' THEN duration_ms ELSE NULL END) as min_duration,
      MAX(CASE WHEN status = 'success' THEN duration_ms ELSE NULL END) as max_duration
    FROM timing_metrics
    WHERE provider = ?
      AND created_at >= ?
  `).get(provider, cutoffTime);

  if (!result || result.total_count === 0) {
    return null;
  }

  // Calculate P50 and P95 separately for SQLite
  let p50 = null;
  let p95 = null;

  if (result.success_count > 0) {
    const p50Index = Math.floor(result.success_count * 0.50);
    const p95Index = Math.floor(result.success_count * 0.95);

    const p50Result = sqliteDb.prepare(`
      SELECT duration_ms FROM timing_metrics
      WHERE provider = ? AND status = 'success' AND created_at >= ?
      ORDER BY duration_ms ASC LIMIT 1 OFFSET ?
    `).get(provider, cutoffTime, p50Index);

    const p95Result = sqliteDb.prepare(`
      SELECT duration_ms FROM timing_metrics
      WHERE provider = ? AND status = 'success' AND created_at >= ?
      ORDER BY duration_ms ASC LIMIT 1 OFFSET ?
    `).get(provider, cutoffTime, p95Index);

    p50 = p50Result ? p50Result.duration_ms : null;
    p95 = p95Result ? p95Result.duration_ms : null;
  }

  return {
    totalCount: result.total_count,
    successCount: result.success_count,
    timeoutCount: result.timeout_count,
    errorCount: result.error_count,
    avgDuration: result.avg_duration ? Math.round(result.avg_duration) : null,
    p50,
    p95,
    minDuration: result.min_duration,
    maxDuration: result.max_duration,
    successRate: result.total_count > 0 ? (result.success_count / result.total_count * 100).toFixed(1) : 0
  };
}

/**
 * Get statistics for a provider
 */
export async function getProviderStats(provider, windowMs = 60 * 60 * 1000) {
  // Ensure initialized
  if (!initPromise) {
    await initTimingMetrics();
  }

  const normalizedProvider = normalizeProvider(provider);
  const backend = getBackend();
  const cutoffTime = Date.now() - windowMs;

  try {
    if (backend === 'postgres') {
      return await getStatsPostgres(normalizedProvider, cutoffTime);
    } else {
      return getStatsSqlite(normalizedProvider, cutoffTime);
    }
  } catch (error) {
    console.error(`[TIMING-METRICS] Error getting stats for ${provider}:`, error.message);
    return null;
  }
}

/**
 * Get all provider statistics
 */
export async function getAllProviderStats(windowMs = 60 * 60 * 1000) {
  // Ensure initialized
  if (!initPromise) {
    await initTimingMetrics();
  }

  const backend = getBackend();
  const cutoffTime = Date.now() - windowMs;
  const stats = {};

  try {
    if (backend === 'postgres') {
      const pool = getPool();
      const result = await pool.query(`
        SELECT DISTINCT provider FROM timing_metrics
        WHERE created_at >= to_timestamp($1 / 1000.0)
      `, [cutoffTime]);

      for (const row of result.rows) {
        stats[row.provider] = await getStatsPostgres(row.provider, cutoffTime);
      }
    } else if (sqliteDb) {
      const providers = sqliteDb.prepare(`
        SELECT DISTINCT provider FROM timing_metrics
        WHERE created_at >= ?
      `).all(cutoffTime);

      for (const row of providers) {
        stats[row.provider] = getStatsSqlite(row.provider, cutoffTime);
      }
    }

    return stats;
  } catch (error) {
    console.error('[TIMING-METRICS] Error getting all provider stats:', error.message);
    return {};
  }
}

/**
 * Clean up old metrics
 */
export async function cleanup() {
  const backend = getBackend();
  const cutoffTime = Date.now() - RETENTION_MS;

  try {
    if (backend === 'postgres') {
      const pool = getPool();
      const result = await pool.query(
        'DELETE FROM timing_metrics WHERE created_at < to_timestamp($1 / 1000.0)',
        [cutoffTime]
      );
      if (result.rowCount > 0) {
        console.log(`[TIMING-METRICS] Cleaned up ${result.rowCount} old metrics`);
      }
    } else if (sqliteDb) {
      const result = sqliteDb.prepare(
        'DELETE FROM timing_metrics WHERE created_at < ?'
      ).run(cutoffTime);
      if (result.changes > 0) {
        console.log(`[TIMING-METRICS] Cleaned up ${result.changes} old metrics`);
      }
    }
  } catch (error) {
    console.error('[TIMING-METRICS] Cleanup error:', error.message);
  }
}

/**
 * Shutdown the timing metrics store
 */
export async function shutdown() {
  // Flush remaining writes
  if (writeQueue.length > 0) {
    await flushWrites();
  }

  // Clear intervals
  if (flushIntervalId) {
    clearInterval(flushIntervalId);
    flushIntervalId = null;
  }

  if (cleanupIntervalId) {
    clearInterval(cleanupIntervalId);
    cleanupIntervalId = null;
  }

  // Close SQLite connection
  if (sqliteDb) {
    sqliteDb.close();
    sqliteDb = null;
  }

  initPromise = null;
  console.log('[TIMING-METRICS] Shutdown complete');
}
