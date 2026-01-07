/**
 * Adaptive Timeout Module
 * Calculates dynamic timeouts based on historical P95 response times.
 */
import * as config from '../config.js';
import { getP95, initTimingMetrics } from './timing-metrics-store.js';

// Provider type classifications
const PROVIDER_TYPES = {
  http_streaming: ['4khdhub', 'hdhub4u', 'mkvcinemas', 'cinedoze', 'mallumv', 'uhdmovies', 'moviesdrive', 'vixsrc'],
  mkvdrama: ['mkvdrama'], // Separate category due to FlareSolverr requirement
  usenet: ['usenet'],
  easynews: ['easynews'],
  debrid: ['realdebrid', 'alldebrid', 'premiumize', 'debridlink', 'torbox', 'offcloud', 'debridapp'],
  homemedia: ['homemedia', 'personalcloud']
};

// Default timeout bounds per provider type (in ms)
const TIMEOUT_BOUNDS = {
  http_streaming: { min: 2000, max: 60000, default: 4000 },
  mkvdrama: { min: 30000, max: 90000, default: 45000 },
  usenet: { min: 5000, max: 30000, default: 20000 },
  easynews: { min: 10000, max: 180000, default: 150000 },
  debrid: { min: 10000, max: 180000, default: 150000 },
  homemedia: { min: 5000, max: 60000, default: 30000 }
};

// In-memory cache for calculated timeouts
const timeoutCache = new Map();

// Cache configuration
const CACHE_TTL_MS = 60000; // Cache timeouts for 60 seconds

// Default adaptive timeout config (can be overridden via config.js)
const DEFAULT_CONFIG = {
  enabled: true,
  p95Buffer: 0.25,           // Add 25% buffer to P95
  windowMs: 60 * 60 * 1000,  // 1 hour window
  minSamples: 10             // Minimum samples for adaptive timeout
};

/**
 * Get adaptive timeout configuration
 */
function getAdaptiveConfig() {
  return {
    enabled: config.ADAPTIVE_TIMEOUT_ENABLED ?? DEFAULT_CONFIG.enabled,
    p95Buffer: config.ADAPTIVE_TIMEOUT_P95_BUFFER ?? DEFAULT_CONFIG.p95Buffer,
    windowMs: config.ADAPTIVE_TIMEOUT_WINDOW_MS ?? DEFAULT_CONFIG.windowMs,
    minSamples: config.ADAPTIVE_TIMEOUT_MIN_SAMPLES ?? DEFAULT_CONFIG.minSamples
  };
}

/**
 * Normalize provider name for consistent lookup
 */
function normalizeProvider(provider) {
  return String(provider || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Get provider type classification
 */
export function getProviderType(provider) {
  const normalized = normalizeProvider(provider);

  for (const [type, providers] of Object.entries(PROVIDER_TYPES)) {
    if (providers.includes(normalized)) {
      return type;
    }
  }

  return 'http_streaming'; // Default type
}

/**
 * Get timeout bounds for a provider
 */
export function getTimeoutBounds(provider) {
  const type = getProviderType(provider);
  return TIMEOUT_BOUNDS[type] || TIMEOUT_BOUNDS.http_streaming;
}

/**
 * Get adaptive timeout for a provider
 * Returns the calculated timeout in milliseconds
 */
export async function getAdaptiveTimeout(provider, options = {}) {
  const cfg = getAdaptiveConfig();

  // If adaptive timeouts are disabled, return default
  if (!cfg.enabled) {
    return getTimeoutBounds(provider).default;
  }

  const normalizedProvider = normalizeProvider(provider);
  const bounds = getTimeoutBounds(normalizedProvider);

  // Check cache first
  const cacheKey = normalizedProvider;
  const cached = timeoutCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.timeout;
  }

  // Try to get P95 from historical data
  try {
    const p95 = await getP95(normalizedProvider, {
      windowMs: options.windowMs || cfg.windowMs,
      minSamples: options.minSamples || cfg.minSamples
    });

    let timeout;
    if (p95 !== null) {
      // Calculate adaptive timeout: P95 + buffer, clamped to bounds
      const buffer = options.buffer || cfg.p95Buffer;
      const adaptiveTimeout = Math.round(p95 * (1 + buffer));
      timeout = Math.max(bounds.min, Math.min(bounds.max, adaptiveTimeout));

      if (process.env.ADAPTIVE_TIMEOUT_DEBUG === 'true') {
        console.log(`[ADAPTIVE-TIMEOUT] ${provider}: P95=${p95}ms, buffer=${buffer}, adaptive=${adaptiveTimeout}ms, bounded=${timeout}ms`);
      }
    } else {
      // Fall back to default
      timeout = bounds.default;

      if (process.env.ADAPTIVE_TIMEOUT_DEBUG === 'true') {
        console.log(`[ADAPTIVE-TIMEOUT] ${provider}: Using default timeout ${timeout}ms (insufficient data)`);
      }
    }

    // Cache the result
    timeoutCache.set(cacheKey, { timeout, timestamp: Date.now() });

    return timeout;
  } catch (error) {
    console.error(`[ADAPTIVE-TIMEOUT] Error calculating timeout for ${provider}:`, error.message);
    return bounds.default;
  }
}

/**
 * Get adaptive timeout synchronously from cache
 * Returns cached value or default if not cached
 */
export function getAdaptiveTimeoutSync(provider) {
  const normalizedProvider = normalizeProvider(provider);
  const bounds = getTimeoutBounds(normalizedProvider);

  const cached = timeoutCache.get(normalizedProvider);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.timeout;
  }

  return bounds.default;
}

/**
 * Pre-calculate and cache adaptive timeouts for multiple providers
 * Useful for batch initialization before sync usage
 */
export async function preCalculateTimeouts(providers) {
  const results = {};

  await Promise.all(
    providers.map(async (provider) => {
      results[provider] = await getAdaptiveTimeout(provider);
    })
  );

  return results;
}

/**
 * Clear timeout cache (for testing or manual refresh)
 */
export function clearTimeoutCache() {
  timeoutCache.clear();
}

/**
 * Get all cached timeouts (for debugging/monitoring)
 */
export function getCachedTimeouts() {
  const result = {};
  for (const [key, value] of timeoutCache.entries()) {
    result[key] = {
      timeout: value.timeout,
      age: Date.now() - value.timestamp,
      expired: Date.now() - value.timestamp >= CACHE_TTL_MS
    };
  }
  return result;
}

/**
 * Refresh adaptive timeouts for all known providers
 * Can be called periodically to keep cache warm
 */
export async function refreshAllTimeouts() {
  const allProviders = Object.values(PROVIDER_TYPES).flat();

  const results = {};
  for (const provider of allProviders) {
    try {
      results[provider] = await getAdaptiveTimeout(provider);
    } catch (error) {
      console.error(`[ADAPTIVE-TIMEOUT] Error refreshing timeout for ${provider}:`, error.message);
      results[provider] = getTimeoutBounds(provider).default;
    }
  }

  return results;
}

/**
 * Initialize the adaptive timeout system
 */
export async function initAdaptiveTimeout() {
  try {
    await initTimingMetrics();

    // Pre-warm cache with all known providers
    await refreshAllTimeouts();

    console.log('[ADAPTIVE-TIMEOUT] Initialized and cache warmed');
    return true;
  } catch (error) {
    console.error('[ADAPTIVE-TIMEOUT] Initialization failed:', error.message);
    return false;
  }
}
