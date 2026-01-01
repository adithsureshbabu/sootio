import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import pg from 'pg';

const { Pool } = pg;

const SQLITE_DIR = process.env.SQLITE_DATA_DIR || '/app/data';
const CACHE_DB = path.join(SQLITE_DIR, 'cache.db');
const HASH_DB = path.join(SQLITE_DIR, 'hash-cache.db');

const BATCH_SIZE = parseInt(process.env.MIGRATION_BATCH_SIZE || '1000', 10);

function normalizeSize(value) {
  if (value == null) return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.round(num);
}

function buildPgConfig() {
  const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;
  const baseConfig = connectionString
    ? { connectionString }
    : {
        host: process.env.POSTGRES_HOST || 'localhost',
        port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
        user: process.env.POSTGRES_USER || 'sootio',
        password: process.env.POSTGRES_PASSWORD || 'sootio',
        database: process.env.POSTGRES_DB || 'sootio'
      };

  if (process.env.POSTGRES_SSL === 'true') {
    return {
      ...baseConfig,
      ssl: { rejectUnauthorized: false }
    };
  }

  return baseConfig;
}

async function ensureSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cache (
      service TEXT NOT NULL,
      hash TEXT NOT NULL,
      file_name TEXT,
      size BIGINT,
      data TEXT,
      release_key TEXT,
      category TEXT,
      resolution TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ,
      PRIMARY KEY (service, hash)
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_cache_release_key ON cache(service, release_key)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_cache_expires_at ON cache(expires_at)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_cache_hash_service ON cache(hash, service)');

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
}

async function migrateCache(pool) {
  if (!fs.existsSync(CACHE_DB)) {
    console.log(`[MIGRATE] cache.db not found at ${CACHE_DB}, skipping.`);
    return;
  }

  const sqlite = new Database(CACHE_DB, { readonly: true });
  const stmt = sqlite.prepare(`
    SELECT service, hash, fileName, size, data, releaseKey, category, resolution, createdAt, updatedAt, expiresAt
    FROM cache
  `);

  const sql = `
    INSERT INTO cache
      (service, hash, file_name, size, data, release_key, category, resolution, created_at, updated_at, expires_at)
    VALUES
      ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    ON CONFLICT (service, hash)
    DO UPDATE SET
      file_name = EXCLUDED.file_name,
      size = EXCLUDED.size,
      data = EXCLUDED.data,
      release_key = EXCLUDED.release_key,
      category = EXCLUDED.category,
      resolution = EXCLUDED.resolution,
      updated_at = EXCLUDED.updated_at,
      expires_at = EXCLUDED.expires_at
  `;

  const client = await pool.connect();
  let total = 0;
  let batchCount = 0;
  const start = Date.now();

  try {
    await client.query('BEGIN');
    for (const row of stmt.iterate()) {
      const service = String(row.service || '').toLowerCase();
      const hash = String(row.hash || '').toLowerCase();
      if (!service || !hash) continue;

      const createdAt = row.createdAt || new Date().toISOString();
      const updatedAt = row.updatedAt || createdAt;
      const expiresAt = row.expiresAt || null;

      await client.query(sql, [
        service,
        hash,
        row.fileName || null,
        normalizeSize(row.size),
        row.data || null,
        row.releaseKey || null,
        row.category || null,
        row.resolution || null,
        createdAt,
        updatedAt,
        expiresAt
      ]);

      total += 1;
      batchCount += 1;

      if (batchCount >= BATCH_SIZE) {
        await client.query('COMMIT');
        await client.query('BEGIN');
        batchCount = 0;
        console.log(`[MIGRATE] cache.db: ${total} rows migrated...`);
      }
    }

    await client.query('COMMIT');
    const duration = Date.now() - start;
    console.log(`[MIGRATE] cache.db: migrated ${total} rows in ${duration}ms`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    sqlite.close();
  }
}

async function migrateHashCache(pool) {
  if (!fs.existsSync(HASH_DB)) {
    console.log(`[MIGRATE] hash-cache.db not found at ${HASH_DB}, skipping.`);
    return;
  }

  const sqlite = new Database(HASH_DB, { readonly: true });
  const stmt = sqlite.prepare('SELECT provider, hash, cached, updatedAt FROM hash_cache');

  const sql = `
    INSERT INTO hash_cache (provider, hash, cached, updated_at)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (provider, hash)
    DO UPDATE SET cached = EXCLUDED.cached, updated_at = EXCLUDED.updated_at
  `;

  const client = await pool.connect();
  let total = 0;
  let batchCount = 0;
  const start = Date.now();

  try {
    await client.query('BEGIN');
    for (const row of stmt.iterate()) {
      const provider = String(row.provider || '').toLowerCase();
      const hash = String(row.hash || '').toLowerCase();
      if (!provider || !hash) continue;

      const updatedAt = row.updatedAt || new Date().toISOString();
      const cached = Boolean(row.cached);

      await client.query(sql, [provider, hash, cached, updatedAt]);

      total += 1;
      batchCount += 1;

      if (batchCount >= BATCH_SIZE) {
        await client.query('COMMIT');
        await client.query('BEGIN');
        batchCount = 0;
        console.log(`[MIGRATE] hash-cache.db: ${total} rows migrated...`);
      }
    }

    await client.query('COMMIT');
    const duration = Date.now() - start;
    console.log(`[MIGRATE] hash-cache.db: migrated ${total} rows in ${duration}ms`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    sqlite.close();
  }
}

async function main() {
  const pool = new Pool(buildPgConfig());

  try {
    await ensureSchema(pool);
    await migrateCache(pool);
    await migrateHashCache(pool);
  } catch (error) {
    console.error(`[MIGRATE] Failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

await main();
