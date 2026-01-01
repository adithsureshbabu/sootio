import pg from 'pg';
import * as config from '../config.js';

const { Pool } = pg;

let pool = null;
let initPromise = null;

function buildPoolConfig() {
  const connectionString = config.POSTGRES_URL || config.DATABASE_URL;
  const baseConfig = connectionString
    ? { connectionString }
    : {
        host: config.POSTGRES_HOST,
        port: config.POSTGRES_PORT,
        user: config.POSTGRES_USER,
        password: config.POSTGRES_PASSWORD,
        database: config.POSTGRES_DB
      };

  if (config.POSTGRES_SSL) {
    return {
      ...baseConfig,
      ssl: { rejectUnauthorized: false }
    };
  }

  return baseConfig;
}

export function getPool() {
  if (!pool) {
    pool = new Pool(buildPoolConfig());
    pool.on('error', (err) => {
      console.error(`[POSTGRES] Pool error: ${err.message}`);
    });
  }
  return pool;
}

export async function initPool() {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const poolInstance = getPool();
    await poolInstance.query('SELECT 1');
    return poolInstance;
  })().catch((error) => {
    console.error(`[POSTGRES] Failed to initialize pool: ${error.message}`);
    if (pool) {
      pool.end().catch(() => {});
    }
    pool = null;
    initPromise = null;
    throw error;
  });

  return initPromise;
}

export async function closePool() {
  if (!pool) return;
  try {
    await pool.end();
  } finally {
    pool = null;
    initPromise = null;
  }
}
