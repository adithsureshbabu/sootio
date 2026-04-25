import PTT from './util/parse-torrent-title.js';
import Cinemeta from './util/cinemeta.js';

const LOG_PREFIX = 'EN+';

/**
 * Easynews integration for direct Usenet video downloads
 * Based on easynews-plus-plus implementation
 */

// Cache for search results
const searchCache = new Map();
const CACHE_TTL = 1000 * 60 * 60 * 6; // 6 hours

/**
 * Sanitize title for comparison
 */
function sanitizeTitle(title) {
  return title
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/Ä/g, 'Ae')
    .replace(/Ö/g, 'Oe')
    .replace(/Ü/g, 'Ue')
    .replaceAll('&', 'and')
    .replace(/[\.\-_:\s]+/g, ' ')
    .replace(/[\[\]\(\){}]/g, ' ')
    .replace(/[^\w\sÀ-ÿ]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Check if file is a valid video
 */
function isValidVideo(file, userConfig = {}) {
  const duration = file['14'] || '';
  const title = file['10'] || '';
  const size = file.rawSize || 0;

  // Skip very short videos
  if (duration.match(/^\d+s/) || duration.match('^[0-5]m')) {
    console.log(`[${LOG_PREFIX}] Skipping short video: ${title} (${duration})`);
    return false;
  }

  // Skip password protected or virus infected
  if (file.passwd || file.virus) {
    console.log(`[${LOG_PREFIX}] Skipping protected/infected: ${title}`);
    return false;
  }

  // Skip non-video files
  if (file.type?.toUpperCase() !== 'VIDEO') {
    return false;
  }

  // Skip files smaller than 20MB (absolute minimum)
  if (size < 20 * 1024 * 1024) {
    console.log(`[${LOG_PREFIX}] Skipping tiny file: ${title} (${Math.round(size / 1024 / 1024)}MB)`);
    return false;
  }

  // Apply user-defined size filters
  // Note: config values are in GB to match stream-provider.js convention
  const minSizeGB = userConfig.minSize !== undefined ? userConfig.minSize : 0; // Default 0 GB minimum
  const maxSizeGB = userConfig.maxSize !== undefined ? userConfig.maxSize : 200; // Default 200 GB maximum
  const sizeGB = size / 1024 / 1024 / 1024;

  if (minSizeGB > 0 && sizeGB < minSizeGB) {
    console.log(`[${LOG_PREFIX}] File too small: ${title} (${sizeGB.toFixed(2)}GB < ${minSizeGB}GB)`);
    return false;
  }

  if (maxSizeGB > 0 && sizeGB > maxSizeGB) {
    console.log(`[${LOG_PREFIX}] File too large: ${title} (${sizeGB.toFixed(2)}GB > ${maxSizeGB}GB)`);
    return false;
  }

  // Filter out junk/incomplete/adult releases
  const lowerTitle = title.toLowerCase();
  const junkPatterns = [
    /\b(sample|trailer|promo)\b/i,
    /^(kaka|exvid|failed)-/i, // Common junk prefixes
    /-cd[12]$/i, // Multi-CD releases (usually incomplete)
    /\bpart[12]\b/i, // Part files (usually incomplete)
    /\b(xxx|porn|parody|cosplay.?x|brazzers|bangbros|naughty.?america)\b/i, // Adult content
  ];

  for (const pattern of junkPatterns) {
    if (pattern.test(lowerTitle)) {
      console.log(`[${LOG_PREFIX}] Filtering junk release: ${title}`);
      return false;
    }
  }

  return true;
}

/**
 * Extract quality from title or resolution
 */
function extractQuality(title, fullres) {
  const parsed = PTT.parse(title);

  if (parsed.resolution) {
    if (parsed.resolution === '2160p' || parsed.resolution.includes('4k') || parsed.resolution.includes('4K')) {
      return '4K';
    }
    return parsed.resolution;
  }

  // Check title for quality indicators
  const qualityPatterns = [
    { pattern: /\b2160p\b/i, quality: '4K' },
    { pattern: /\b4k\b/i, quality: '4K' },
    { pattern: /\buhd\b/i, quality: '4K' },
    { pattern: /\b1080p\b/i, quality: '1080p' },
    { pattern: /\b720p\b/i, quality: '720p' },
    { pattern: /\b480p\b/i, quality: '480p' },
  ];

  for (const { pattern, quality } of qualityPatterns) {
    if (pattern.test(title)) {
      return quality;
    }
  }

  // Fallback to fullres field
  if (fullres) {
    if (fullres.includes('2160') || fullres.includes('4K')) return '4K';
    if (fullres.includes('1080')) return '1080p';
    if (fullres.includes('720')) return '720p';
    if (fullres.includes('480')) return '480p';
  }

  return null;
}

/**
 * Search Easynews for content by parsing INIT_RES from HTML
 */
async function search(username, password, query, options = {}) {
  const {
    maxResults = 250,
    pageNr = 1,
  } = options;

  const cacheKey = JSON.stringify({ username, query, pageNr, maxResults });
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    console.log(`[${LOG_PREFIX}] Cache hit for query: "${query}"`);
    return cached.data;
  }

  const searchParams = {
    'fty[]': 'VIDEO',
    gps: query,
    basic: '',
    pno: pageNr.toString(),
    s1: 'dsize',   // Sort by size descending (biggest = highest quality first)
    s1d: '-',
    s2: 'nrfile',  // Then by relevance
    s2d: '-',
    s3: 'dtime',   // Then by date
    s3d: '-',
    safeO: '0',    // Disable safe search filter
  };

  const searchUrl = 'https://members.easynews.com/3.0/search';

  try {
    console.log(`[${LOG_PREFIX}] Searching for: "${query}"`);

    const params = new URLSearchParams(searchParams);
    const fetchUrl = `${searchUrl}?${params}`;
    const auth = Buffer.from(`${username}:${password}`).toString('base64');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    const response = await fetch(fetchUrl, {
      headers: {
        'Authorization': `Basic ${auth}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error('Easynews authentication failed: Invalid username or password');
      }
      console.error(`[${LOG_PREFIX}] HTTP ${response.status} from Easynews`);
      return null;
    }

    const html = await response.text();
    if (!html) {
      console.error(`[${LOG_PREFIX}] Empty response from Easynews`);
      return null;
    }

    // Extract INIT_RES JSON from inline script using string-aware brace matching
    const initIdx = html.indexOf('var INIT_RES = ');
    if (initIdx === -1) {
      console.error(`[${LOG_PREFIX}] INIT_RES not found in Easynews HTML`);
      return null;
    }
    const braceStart = html.indexOf('{', initIdx);
    let depth = 0;
    let braceEnd = -1;
    let inString = false;
    let escaped = false;
    for (let i = braceStart; i < html.length; i++) {
      const ch = html[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { braceEnd = i; break; } }
    }
    if (braceEnd === -1) {
      console.error(`[${LOG_PREFIX}] Failed to parse INIT_RES JSON boundaries`);
      return null;
    }
    const initRes = JSON.parse(html.substring(braceStart, braceEnd + 1));

    const farmMatch = html.match(/FARM\s*=\s*["']([^"']+)["']/);
    const portMatch = html.match(/PORT\s*=\s*(\d+)/);
    const farm = farmMatch ? farmMatch[1] : 'auto';
    const port = portMatch ? portMatch[1] : 'auto';
    const sid = initRes.sid || '';

    const normalizedData = (initRes.data || []).slice(0, maxResults).map(item => {
      const extension = item.extension?.startsWith('.') ? item.extension : `.${item.extension || ''}`;
      const title = item.prettyFn || item.fn || item.subject || 'Unknown';
      const runtimeStr = item.prettyRuntime || (item.runtime ? `${item.runtime}s` : '');
      const fullres = item.width && item.height ? `${item.width}x${item.height}` : '';

      return {
        ...item,
        '0': item.hash || '',
        '10': title,
        '11': extension,
        '14': runtimeStr,
        rawSize: item.size || 0,
        fullres,
        type: (item.type || '').toUpperCase(),
        alangs: item.alang || item.audio_tracks || [],
      };
    });

    const parsedResponse = {
      data: normalizedData,
      results: initRes.results || normalizedData.length,
      sid,
      farm,
      port,
      dlFarm: farm,
      dlPort: port,
      downURL: 'https://members.easynews.com',
      cookieJar: null,
    };

    console.log(`[${LOG_PREFIX}] Found ${parsedResponse.data.length} results out of ${parsedResponse.results || 0} total`);
    searchCache.set(cacheKey, { data: parsedResponse, timestamp: Date.now() });

    return parsedResponse;
  } catch (error) {
    console.error(`[${LOG_PREFIX}] Search error: ${error.message}`);
    throw error;
  }
}

/**
 * Build search queries for media content
 * Returns array of queries to try (first = most specific, last = broadest)
 */
function buildSearchQueries(meta, type, season = null, episode = null) {
  const name = meta.name || meta.title;
  const year = meta.year;
  const queries = [];

  if (type === 'series' && season && episode) {
    const s = String(season).padStart(2, '0');
    const e = String(episode).padStart(2, '0');
    // Specific episode query, then broader season query as fallback
    queries.push(`${name} S${s}E${e}`);
    queries.push(`${name} S${s}`);
  } else {
    // For movies: search without year (much more results), we filter by title match later
    queries.push(name);
  }

  return queries;
}

/**
 * Create stream URL for Easynews file
 */
function createStreamUrl(searchResponse, file, username, password) {
  const postHash = file['0'] || '';
  const postTitle = file['10'] || '';
  const extRaw = file['11'] || '';
  const ext = extRaw.startsWith('.') ? extRaw : `.${extRaw}`;
  const dlFarm = searchResponse?.dlFarm || searchResponse?.farm || 'auto';
  const dlPort = searchResponse?.dlPort || searchResponse?.port || 'auto';
  const sid = searchResponse?.sid;
  const fileId = file.id || '';
  const sig = file.sig || '';
  const authPrefix = `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`;

  // URL format matches Easynews data-dlurl: /dl/{farm}/{port}/{hash}{ext}/{title}{ext}?sid={sid}:{id}&sig={sig}
  let url = `https://${authPrefix}members.easynews.com/dl/${dlFarm}/${dlPort}/${postHash}${ext}/${postTitle}${ext}`;

  const params = [];
  if (sid) params.push(`sid=${sid}${fileId ? ':' + fileId : ''}`);
  if (sig) params.push(`sig=${sig}`);
  if (params.length) url += `?${params.join('&')}`;

  return url;
}

/**
 * Resolve /dl/ URL to direct CDN URL (206-capable, no auth needed)
 * Follows the 302 redirect to get the actual CDN download URL
 */
async function resolveCdnUrl(dlUrl, username, password) {
  try {
    const auth = Buffer.from(`${username}:${password}`).toString('base64');
    // Strip inline credentials for the fetch (native fetch rejects them)
    const cleanUrl = dlUrl.replace(/https:\/\/[^@]+@/, 'https://');
    const response = await fetch(cleanUrl, {
      redirect: 'manual',
      headers: { 'Authorization': `Basic ${auth}` },
    });
    if (response.status === 302) {
      return response.headers.get('location') || dlUrl;
    }
    return dlUrl;
  } catch {
    return dlUrl;
  }
}

async function formatResult(searchResponse, file, username, password) {
  const title = file['10'] || 'Unknown';
  const size = file.rawSize || 0;
  const fullres = file.fullres || '';
  const quality = extractQuality(title, fullres);
  const languages = file.alangs || [];
  const postHash = file['0'] || '';
  const dlUrl = createStreamUrl(searchResponse, file, username, password);

  // Parse title for additional info
  const parsed = PTT.parse(title);
  const info = parsed || { title };
  if (quality) {
    info.quality = quality;
  }

  return {
    name: title,
    info,
    size,
    seeders: 999,
    url: dlUrl, // Will be resolved to CDN URL in batch after formatting
    source: 'easynews',
    hash: postHash,
    tracker: 'Easynews',
    isCached: true,
    languages,
  };
}

/**
 * Batch resolve /dl/ URLs to direct CDN URLs in parallel
 * Returns 206-capable URLs Stremio can use without any redirect
 */
async function batchResolveCdnUrls(results, username, password) {
  const BATCH_SIZE = 25;
  const resolved = [];
  for (let i = 0; i < results.length; i += BATCH_SIZE) {
    const batch = results.slice(i, i + BATCH_SIZE);
    const cdnUrls = await Promise.all(
      batch.map(r => resolveCdnUrl(r.url, username, password))
    );
    for (let j = 0; j < batch.length; j++) {
      resolved.push({ ...batch[j], url: cdnUrls[j] });
    }
  }
  return resolved;
}

/**
 * Check if a file title matches the expected content
 * Uses PTT to extract actual title from release name for accurate matching
 */
function isTitleMatch(fileTitle, meta, type, season, episode) {
  const parsed = PTT.parse(fileTitle);
  const parsedTitle = sanitizeTitle(parsed.title || '');
  const metaName = sanitizeTitle(meta.name || meta.title);

  // Compare PTT-extracted title against metadata name
  if (!parsedTitle || !metaName) return false;

  // Check if parsed title matches (allow partial match for titles with subtitles)
  const titleMatches = parsedTitle.includes(metaName) || metaName.includes(parsedTitle);
  if (!titleMatches) return false;

  // For movies, verify year if PTT extracted one
  if (type === 'movie' && meta.year && parsed.year) {
    if (Math.abs(parsed.year - meta.year) > 1) return false; // Allow 1 year tolerance
  }

  // For series, check season/episode
  if (type === 'series' && season && episode) {
    // PTT might parse season/episode
    if (parsed.season !== undefined && parsed.episode !== undefined) {
      if (parsed.season !== season || parsed.episode !== episode) return false;
    } else {
      // Fallback to regex on raw title
      const sePattern = new RegExp(`s0*${season}\\s*e0*${episode}`, 'i');
      if (!sePattern.test(fileTitle)) return false;
    }
  }

  return true;
}

/**
 * Search Easynews for streams
 * Main entry point matching the pattern of other debrid services
 */
async function searchEasynewsStreams(username, password, type, id, userConfig = {}) {
  try {
    console.log(`[${LOG_PREFIX}] Starting search for ${type} ${id}`);

    // Parse IMDb ID and extract season/episode if present
    const parts = id.split(':');
    const imdbId = parts[0];
    const season = parts[1] ? parseInt(parts[1]) : null;
    const episode = parts[2] ? parseInt(parts[2]) : null;

    // Get metadata from Cinemeta
    const meta = await Cinemeta.getMeta(type, imdbId);
    if (!meta) {
      console.error(`[${LOG_PREFIX}] Failed to get metadata for ${type} ${imdbId}`);
      return [];
    }

    // Build search queries
    const queries = buildSearchQueries(meta, type, season, episode);
    console.log(`[${LOG_PREFIX}] Search queries: ${queries.map(q => `"${q}"`).join(', ')}`);

    const allFiles = [];
    const seenHashes = new Set();
    let lastSearchResponse = null;

    for (const query of queries) {
      const searchResponse = await search(username, password, query, {
        maxResults: 250,
        pageNr: 1,
      });

      if (!searchResponse?.data?.length) continue;
      lastSearchResponse = searchResponse;

      for (const file of searchResponse.data) {
        const hash = file['0'] || file.hash || '';
        if (hash && seenHashes.has(hash)) continue;
        if (hash) seenHashes.add(hash);
        file._searchResponse = searchResponse;
        allFiles.push(file);
      }

      // Only fetch page 2 if page 1 was full (100 results) and we need more matches
      const matchedSoFar = allFiles.filter(f => isTitleMatch(f['10'] || '', meta, type, season, episode));
      if (searchResponse.data.length >= 100 && matchedSoFar.length < 30) {
        const page2 = await search(username, password, query, { maxResults: 250, pageNr: 2 });
        if (page2?.data?.length) {
          lastSearchResponse = page2;
          for (const file of page2.data) {
            const hash = file['0'] || file.hash || '';
            if (hash && seenHashes.has(hash)) continue;
            if (hash) seenHashes.add(hash);
            file._searchResponse = page2;
            allFiles.push(file);
          }
        }
      }

      // Skip broader queries if we have enough matched results
      const matched = allFiles.filter(f => isTitleMatch(f['10'] || '', meta, type, season, episode));
      if (matched.length >= 30) break;
    }

    console.log(`[${LOG_PREFIX}] Fetched ${allFiles.length} total files across all queries`);

    // Filter: valid video + title match
    const validFiles = allFiles.filter(file => {
      if (!isValidVideo(file, userConfig)) return false;
      if (!isTitleMatch(file['10'] || '', meta, type, season, episode)) return false;
      return true;
    });

    console.log(`[${LOG_PREFIX}] ${validFiles.length} valid matched videos out of ${allFiles.length} total`);

    const formattedResults = await Promise.all(
      validFiles.map(file => {
        const searchResp = file._searchResponse || lastSearchResponse;
        return formatResult(searchResp, file, username, password);
      })
    );

    console.log(`[${LOG_PREFIX}] Resolving ${formattedResults.length} CDN URLs in parallel...`);
    const t0 = Date.now();
    const resolvedResults = await batchResolveCdnUrls(formattedResults, username, password);
    console.log(`[${LOG_PREFIX}] Resolved in ${Date.now() - t0}ms`);

    console.log(`[${LOG_PREFIX}] Returning ${resolvedResults.length} streams`);
    return resolvedResults;

  } catch (error) {
    console.error(`[${LOG_PREFIX}] Error searching Easynews: ${error.message}`);
    return [];
  }
}

/**
 * Resolve encoded Easynews data to direct CDN URL (206-capable)
 * Decodes base64url data, builds /dl/ URL, follows 302 to CDN
 */
async function resolveFromData(encodedData) {
  const json = Buffer.from(encodedData, 'base64url').toString();
  const data = JSON.parse(json);

  const ext = data.e.startsWith('.') ? data.e : `.${data.e}`;
  const authPrefix = `${encodeURIComponent(data.u)}:${encodeURIComponent(data.p)}@`;

  let dlUrl = `https://${authPrefix}members.easynews.com/dl/${data.f}/${data.po}/${data.h}${ext}/${data.t}${ext}`;

  const params = [];
  if (data.s) params.push(`sid=${data.s}${data.i ? ':' + data.i : ''}`);
  if (data.sg) params.push(`sig=${data.sg}`);
  if (params.length) dlUrl += `?${params.join('&')}`;

  // Follow 302 to get direct CDN URL (206-capable, no auth needed)
  const cdnUrl = await resolveCdnUrl(dlUrl, data.u, data.p);
  console.log(`[${LOG_PREFIX}] Resolved to CDN: ${cdnUrl.substring(0, 80)}...`);
  return cdnUrl;
}

export default {
  searchEasynewsStreams,
  resolveFromData,
  resolveCdnUrl,
  search,
};
