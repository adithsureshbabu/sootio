/**
 * Scraper Orchestration Module
 *
 * Centralized scraper selection and execution logic.
 * Determines which scrapers to use based on user config and .env settings.
 * Provides smart defaults when user hasn't selected specific scrapers.
 */

import axios from 'axios';
import * as config from '../config.js';
import * as scrapers from '../common/scrapers.js';
import performanceTracker from './scraper-performance.js';

const SCRAPER_PERF_ENABLED = process.env.SCRAPER_PERF_ENABLED !== 'false';
const SCRAPER_TOP_N = parseInt(process.env.SCRAPER_TOP_N || '', 10);
const SCRAPER_MIN_SCORE = parseInt(process.env.SCRAPER_MIN_SCORE || '', 10);
const SCRAPER_SLOW_THRESHOLD_MS = parseInt(process.env.SCRAPER_SLOW_THRESHOLD_MS || '', 10);

function classifyScraperError(error) {
  if (!error) return 'error';
  if (axios.isCancel?.(error) || error.code === 'ERR_CANCELED') return 'aborted';
  const status = error.response?.status;
  const message = String(error.message || '').toLowerCase();
  if (error.code === 'ECONNABORTED' || message.includes('timeout')) return 'timeout';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'server_error';
  if (status === 403 && message.includes('captcha')) return 'captcha';
  return 'error';
}

function getSlowThresholdMs(userConfig) {
  if (Number.isFinite(SCRAPER_SLOW_THRESHOLD_MS) && SCRAPER_SLOW_THRESHOLD_MS > 0) {
    return SCRAPER_SLOW_THRESHOLD_MS;
  }
  const baseTimeout = userConfig?.SCRAPER_TIMEOUT ?? config.SCRAPER_TIMEOUT;
  return Math.max(1000, Math.floor(baseTimeout * 0.8));
}

/**
 * Determines which scrapers to use based on user config and .env settings.
 * If user hasn't selected specific scrapers, uses defaults: knaben, 1337x, and jackett (if enabled in .env).
 * @param {Object} userConfig - User configuration from manifest
 * @param {string} logPrefix - Log prefix for console messages
 * @param {boolean} forceAll - If true, ignore user selection and return ALL enabled scrapers from .env
 * @returns {Object} Object with scraper names as keys and boolean values
 */
export function getEnabledScrapers(userConfig = {}, logPrefix = 'SCRAPER', forceAll = false) {
  const userScrapers = Array.isArray(userConfig.Scrapers) ? userConfig.Scrapers : [];
  const userIndexerScrapers = Array.isArray(userConfig.IndexerScrapers) ? userConfig.IndexerScrapers : [];

  // Map of scraper IDs to their config flags
  const scraperMap = {
    'jackett': config.JACKETT_ENABLED,
    '1337x': config.TORRENT_1337X_ENABLED,
    'torrent9': config.TORRENT9_ENABLED,
    'btdig': config.BTDIG_ENABLED,
    'snowfl': config.SNOWFL_ENABLED,
    'magnetdl': config.MAGNETDL_ENABLED,
    'wolfmax4k': config.WOLFMAX4K_ENABLED,
    'bludv': config.BLUDV_ENABLED,
    'knaben': config.KNABEN_ENABLED,
    'extto': config.EXTTO_ENABLED,
    'torrentdownload': config.TORRENTDOWNLOAD_ENABLED,
    'ilcorsaronero': config.ILCORSARONERO_ENABLED,
    'bitmagnet': config.BITMAGNET_ENABLED,
    'zilean': config.ZILEAN_ENABLED,
    'torrentio': config.TORRENTIO_ENABLED,
    'comet': config.COMET_ENABLED,
    'stremthru': config.STREMTHRU_ENABLED
  };

  // If forceAll is true, return ALL enabled scrapers from .env (for background refresh)
  if (forceAll) {
    const enabled = {};
    for (const [name, isEnabled] of Object.entries(scraperMap)) {
      if (isEnabled) {
        enabled[name] = true;
      }
    }
    console.log(`[${logPrefix}] Using ALL enabled scrapers (background): ${Object.keys(enabled).join(', ')}`);
    return enabled;
  }

  // If user has selected specific scrapers, use those (filtered by what's enabled in .env)
  if (userScrapers.length > 0 || userIndexerScrapers.length > 0) {
    const enabled = {};
    for (const scraper of userScrapers) {
      if (scraperMap[scraper]) {
        enabled[scraper] = true;
      }
    }
    for (const scraper of userIndexerScrapers) {
      if (scraperMap[scraper]) {
        enabled[scraper] = true;
      }
    }
    console.log(`[${logPrefix}] User selected scrapers: ${Object.keys(enabled).join(', ')}`);
    return enabled;
  }

  // No scrapers selected by user, use defaults: knaben, 1337x, jackett (if enabled)
  const defaults = {};
  if (scraperMap['knaben']) defaults['knaben'] = true;
  if (scraperMap['1337x']) defaults['1337x'] = true;
  if (scraperMap['jackett']) defaults['jackett'] = true;

  console.log(`[${logPrefix}] Using default scrapers: ${Object.keys(defaults).join(', ')}`);
  return defaults;
}

/**
 * Check if a scraper should be enabled based on user selection
 * @param {string} scraperName - Name of the scraper to check
 * @param {Object} enabledScrapers - Object with enabled scraper flags
 * @returns {boolean} True if scraper should be enabled
 */
export function shouldEnableScraper(scraperName, enabledScrapers) {
  return enabledScrapers[scraperName] === true;
}

/**
 * Orchestrate all scrapers based on user config and return promises.
 * This centralizes the scraper orchestration logic in one place.
 *
 * @param {Object} params - Scraper orchestration parameters
 * @param {string} params.type - Content type ('movie' or 'series')
 * @param {string} params.imdbId - IMDB ID
 * @param {string} params.searchKey - Search query for scrapers
 * @param {string} params.baseSearchKey - Base search query
 * @param {string|number} params.season - Season number (for series)
 * @param {string|number} params.episode - Episode number (for series)
 * @param {AbortSignal} params.signal - Abort signal for cancellation
 * @param {string} params.logPrefix - Log prefix (e.g., 'RD', 'AD', 'TB')
 * @param {Object} params.userConfig - User configuration
 * @param {Array<string>} params.selectedLanguages - Selected languages filter
 * @param {boolean} params.forceAllScrapers - If true, use ALL enabled scrapers (for background refresh)
 * @returns {Promise<Array>} Promise that resolves to array of scraper results
 */
export async function orchestrateScrapers({
  type,
  imdbId,
  searchKey,
  baseSearchKey,
  season,
  episode,
  signal,
  logPrefix,
  userConfig = {},
  selectedLanguages = [],
  forceAllScrapers = false
}) {
  const enabledScrapers = getEnabledScrapers(userConfig, logPrefix, forceAllScrapers);
  const hasUserSelection = (
    (Array.isArray(userConfig.Scrapers) && userConfig.Scrapers.length > 0) ||
    (Array.isArray(userConfig.IndexerScrapers) && userConfig.IndexerScrapers.length > 0)
  );
  const scraperTasks = [];

  const addScraperTask = (name, run) => {
    scraperTasks.push({ name, run });
  };

  // Helper to add scraper tasks for a given config
  const addScraperTasks = (cfg, key) => {
    // Indexer scrapers (use shouldEnableScraper for consistent filtering)
    if (shouldEnableScraper('torrentio', enabledScrapers)) addScraperTask('torrentio', () => scrapers.searchTorrentio(type, imdbId, signal, logPrefix, cfg));
    if (shouldEnableScraper('zilean', enabledScrapers)) addScraperTask('zilean', () => scrapers.searchZilean(searchKey, season, episode, signal, logPrefix, cfg));
    if (shouldEnableScraper('comet', enabledScrapers)) addScraperTask('comet', () => scrapers.searchComet(type, imdbId, signal, season, episode, logPrefix, cfg));
    if (shouldEnableScraper('stremthru', enabledScrapers)) addScraperTask('stremthru', () => scrapers.searchStremthru(type, imdbId, signal, season, episode, logPrefix, cfg));

    // Torrent scrapers (check user selection)
    if (shouldEnableScraper('bitmagnet', enabledScrapers)) addScraperTask('bitmagnet', () => scrapers.searchBitmagnet(key, signal, logPrefix, cfg));
    if (shouldEnableScraper('jackett', enabledScrapers)) addScraperTask('jackett', () => scrapers.searchJackett(key, signal, logPrefix, cfg));
    if (shouldEnableScraper('torrent9', enabledScrapers)) addScraperTask('torrent9', () => scrapers.searchTorrent9(key, signal, logPrefix, cfg));
    if (shouldEnableScraper('1337x', enabledScrapers)) addScraperTask('1337x', () => scrapers.search1337x(key, signal, logPrefix, cfg));
    if (shouldEnableScraper('btdig', enabledScrapers)) addScraperTask('btdig', () => scrapers.searchBtdig(key, signal, logPrefix, cfg));
    if (shouldEnableScraper('snowfl', enabledScrapers)) addScraperTask('snowfl', () => scrapers.searchSnowfl(key, signal, logPrefix, cfg));
    if (shouldEnableScraper('magnetdl', enabledScrapers)) addScraperTask('magnetdl', () => scrapers.searchMagnetDL(key, signal, logPrefix, cfg));
    if (shouldEnableScraper('wolfmax4k', enabledScrapers)) addScraperTask('wolfmax4k', () => scrapers.searchWolfmax4K(key, signal, logPrefix, cfg));
    if (shouldEnableScraper('bludv', enabledScrapers)) addScraperTask('bludv', () => scrapers.searchBluDV(key, signal, logPrefix, cfg));
    if (shouldEnableScraper('knaben', enabledScrapers)) addScraperTask('knaben', () => scrapers.searchKnaben(key, signal, logPrefix, cfg));
    if (shouldEnableScraper('extto', enabledScrapers)) addScraperTask('extto', () => scrapers.searchExtTo(key, signal, logPrefix, cfg));
    if (shouldEnableScraper('torrentdownload', enabledScrapers)) addScraperTask('torrentdownload', () => scrapers.searchTorrentDownload(key, signal, logPrefix, cfg));
    if (shouldEnableScraper('ilcorsaronero', enabledScrapers)) addScraperTask('ilcorsaronero', () => scrapers.searchIlCorsaroNero(key, signal, logPrefix, cfg));
  };

  // Execute scrapers based on language selection
  if (selectedLanguages.length === 0) {
    const cfg = { ...userConfig, Languages: [] };
    const key = baseSearchKey;
    addScraperTasks(cfg, key);
  } else {
    for (const lang of selectedLanguages) {
      const cfg = { ...userConfig, Languages: [lang] };
      const key = baseSearchKey;
      addScraperTasks(cfg, key);
    }
  }

  if (scraperTasks.length === 0) {
    console.error(`[${logPrefix}] No scrapers enabled after filtering`);
    return [];
  }

  const slowThresholdMs = getSlowThresholdMs(userConfig);
  let selectedTasks = scraperTasks;

  if (SCRAPER_PERF_ENABLED) {
    const enabledNames = [...new Set(scraperTasks.map(task => task.name))];
    const penalized = enabledNames.filter(name => performanceTracker.isPenalized(name));
    const unpenalized = enabledNames.filter(name => !performanceTracker.isPenalized(name));

    if (penalized.length > 0) {
      console.error(`[${logPrefix}] Skipping penalized scrapers: ${penalized.join(', ')}`);
    }

    if (unpenalized.length === 0) {
      console.error(`[${logPrefix}] All enabled scrapers are penalized; running all as fallback`);
      selectedTasks = scraperTasks;
    } else if (!hasUserSelection && !forceAllScrapers) {
      const options = {};
      if (Number.isFinite(SCRAPER_TOP_N) && SCRAPER_TOP_N > 0) options.topN = SCRAPER_TOP_N;
      if (Number.isFinite(SCRAPER_MIN_SCORE) && SCRAPER_MIN_SCORE > 0) options.minScore = SCRAPER_MIN_SCORE;
      const selectedNames = performanceTracker.selectScrapers(unpenalized, options);
      selectedTasks = scraperTasks.filter(task => selectedNames.includes(task.name));
      console.log(`[${logPrefix}] Selected scrapers: ${selectedTasks.map(task => task.name).join(', ')}`);
    } else {
      selectedTasks = scraperTasks.filter(task => unpenalized.includes(task.name));
    }
  }

  if (selectedTasks.length === 0) {
    console.error(`[${logPrefix}] No scrapers selected after performance filtering`);
    return [];
  }

  const orchestrationStart = Date.now();
  const baseTimeout = userConfig?.SCRAPER_TIMEOUT ?? config.SCRAPER_TIMEOUT;
  const scraperPromises = selectedTasks.map(task => (async () => {
    const start = Date.now();
    try {
      const result = await task.run();
      const duration = Date.now() - start;
      const resultCount = Array.isArray(result) ? result.length : 0;
      if (SCRAPER_PERF_ENABLED) {
        const likelyTimeout = resultCount === 0 && duration >= Math.max(Math.floor(baseTimeout * 0.9), slowThresholdMs);
        if (likelyTimeout) {
          performanceTracker.recordFailure(task.name, 'timeout', duration, 'empty-results-timeout');
        } else {
          performanceTracker.recordSuccess(task.name, resultCount, duration);
        }
      }
      if (duration > slowThresholdMs) {
        console.error(`[${logPrefix} SCRAPER] Slow ${task.name} took ${duration}ms (${resultCount} results)`);
      }
      return result;
    } catch (error) {
      const duration = Date.now() - start;
      const errorType = classifyScraperError(error);
      if (SCRAPER_PERF_ENABLED && errorType !== 'aborted') {
        performanceTracker.recordFailure(task.name, errorType, duration, error.message);
      }
      if (errorType !== 'aborted' && duration > slowThresholdMs) {
        console.error(`[${logPrefix} SCRAPER] Slow ${task.name} failed after ${duration}ms: ${error.message}`);
      }
      throw error;
    }
  })());

  // OPTIMIZATION: Use Promise.allSettled for graceful degradation
  // This ensures slow/failing scrapers don't block results from fast scrapers
  const results = await Promise.allSettled(scraperPromises);
  const totalDuration = Date.now() - orchestrationStart;
  if (totalDuration > slowThresholdMs) {
    console.error(`[${logPrefix}] Scraper orchestration slow: ${totalDuration}ms across ${selectedTasks.length}/${scraperTasks.length} scrapers`);
  }

  // Extract successful results and log failures
  const successfulResults = [];
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      successfulResults.push(result.value);
    } else {
      const name = selectedTasks[index]?.name || `scraper-${index}`;
      console.error(`[${logPrefix}] Scraper ${name} failed: ${result.reason?.message || result.reason}`);
    }
  });

  return successfulResults;
}
