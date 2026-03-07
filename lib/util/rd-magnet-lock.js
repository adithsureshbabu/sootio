import crypto from 'crypto';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const LOCK_DIR = join(__dirname, '..', '..', 'data', 'rd-magnet-locks');

const LOCK_TIMEOUT_MS = Math.max(
  1000,
  Number.parseInt(process.env.RD_MAGNET_LOCK_TIMEOUT_MS || '45000', 10) || 45000
);
const LOCK_TTL_MS = Math.max(
  1000,
  Number.parseInt(process.env.RD_MAGNET_LOCK_TTL_MS || '60000', 10) || 60000
);
const LOCK_POLL_MS = Math.max(
  20,
  Number.parseInt(process.env.RD_MAGNET_LOCK_POLL_MS || '120', 10) || 120
);

let ensureDirPromise = null;

function hashPart(value, len = 20) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, len);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function ensureLockDir() {
  if (!ensureDirPromise) {
    ensureDirPromise = fs.mkdir(LOCK_DIR, { recursive: true }).catch(error => {
      ensureDirPromise = null;
      throw error;
    });
  }
  await ensureDirPromise;
}

async function acquireLock(lockPath, { timeoutMs = LOCK_TIMEOUT_MS, ttlMs = LOCK_TTL_MS, pollMs = LOCK_POLL_MS } = {}) {
  const startedAt = Date.now();

  while ((Date.now() - startedAt) < timeoutMs) {
    try {
      const handle = await fs.open(lockPath, 'wx');
      await handle.writeFile(String(Date.now()));
      return handle;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;

      try {
        const stat = await fs.stat(lockPath);
        if ((Date.now() - stat.mtimeMs) > ttlMs) {
          await fs.unlink(lockPath).catch(() => {});
        }
      } catch (_) {
        // File may be deleted between stat/unlink by another worker.
      }

      await sleep(pollMs);
    }
  }

  throw new Error(`Timed out waiting for RD magnet lock: ${lockPath}`);
}

async function releaseLock(lockPath, handle) {
  try {
    if (handle) await handle.close();
  } catch (_) {}

  try {
    await fs.unlink(lockPath);
  } catch (_) {}
}

export async function withRealDebridMagnetLock(apiKey, magnetHash, fn, options = {}) {
  const normalizedHash = String(magnetHash || '').toLowerCase().trim();
  if (!normalizedHash) return fn();

  await ensureLockDir();

  const tokenPart = hashPart(apiKey || 'no-key', 16);
  const hashPartKey = hashPart(normalizedHash, 32);
  const lockFile = `${tokenPart}-${hashPartKey}.lock`;
  const lockPath = join(LOCK_DIR, lockFile);

  const handle = await acquireLock(lockPath, options);
  try {
    return await fn();
  } finally {
    await releaseLock(lockPath, handle);
  }
}

