import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
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
 * Create HTTP Basic Auth header
 */
function createBasicAuth(username, password) {
  const credentials = Buffer.from(`${username}:${password}`).toString('base64');
  return `Basic ${credentials}`;
}

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

  // Filter out junk/incomplete releases
  const lowerTitle = title.toLowerCase();
  const junkPatterns = [
    /\b(sample|trailer|promo)\b/i,
    /^(kaka|exvid|failed)-/i, // Common junk prefixes
    /-cd[12]$/i, // Multi-CD releases (usually incomplete)
    /\bpart[12]\b/i, // Part files (usually incomplete)
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
 * Search Easynews for content
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
  };

  const searchUrl = 'https://members.easynews.com/3.0/search';

  try {
    console.log(`[${LOG_PREFIX}] Searching for: "${query}"`);

    const jar = new CookieJar();
    const client = wrapper(axios.create({ jar, withCredentials: true }));

    const response = await client.get(searchUrl, {
      params: searchParams,
      auth: { username, password },
      headers: {
        'User-Agent': 'Sootio/1.0'
      },
      responseType: 'text',
      timeout: 20000
    });

    if (!response.data) {
      console.error(`[${LOG_PREFIX}] Empty response from Easynews`);
      return null;
    }

    const html = response.data;

    const farmMatch = html.match(/FARM\s*=\s*"([^"]+)"/);
    const portMatch = html.match(/PORT\s*=\s*([0-9]+)/);
    const farm = farmMatch ? farmMatch[1] : 'auto';
    const port = portMatch ? portMatch[1] : 'auto';

    const initResMatch = html.match(/var\s+INIT_RES\s*=\s*(\{[\s\S]*?\});/);
    if (!initResMatch) {
      console.error(`[${LOG_PREFIX}] Failed to parse INIT_RES payload from Easynews HTML`);
      return null;
    }

    const initResRaw = initResMatch[1].trim().replace(/;$/, '');
    const initRes = JSON.parse(initResRaw);
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
      cookieJar: jar,
    };

    console.log(`[${LOG_PREFIX}] Found ${parsedResponse.data.length} results out of ${parsedResponse.results || 0} total`);
    searchCache.set(cacheKey, { data: parsedResponse, timestamp: Date.now() });

    return parsedResponse;
  } catch (error) {
    if (error.response?.status === 401) {
      console.error(`[${LOG_PREFIX}] Authentication failed - Invalid credentials`);
      throw new Error('Easynews authentication failed: Invalid username or password');
    }
    console.error(`[${LOG_PREFIX}] Search error: ${error.message}`);
    throw error;
  }
}

/**
 * Build query string for media content
 */
function buildSearchQuery(meta, type, season = null, episode = null) {
  const name = meta.name || meta.title;
  const year = meta.year;

  if (type === 'series' && season && episode) {
    const s = String(season).padStart(2, '0');
    const e = String(episode).padStart(2, '0');
    return `${name} S${s}E${e}`;
  }

  if (year) {
    return `${name} ${year}`;
  }

  return name;
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
  const downURL = searchResponse?.downURL || 'https://members.easynews.com';
  const fileId = file.id || file.ID || file['id'] || '';
  const sid = searchResponse?.sid;

  if (file.downloadUrl) {
    const urlWithAuth = file.downloadUrl.replace(
      'https://',
      `https://${encodeURIComponent(username)}:${encodeURIComponent(password)}@`
    );
    return urlWithAuth;
  }

  const encodedHash = encodeURIComponent(`${postHash}${fileId}${ext}`);
  const encodedTitle = encodeURIComponent(`${postTitle}${ext}`);
  let url = `${downURL}/dl/${dlFarm}/${dlPort}/${encodedHash}/${encodedTitle}`;

  const params = [];
  if (sid && fileId) params.push(`sid=${sid}:${fileId}`);
  if (file.sig) params.push(`sig=${file.sig}`);
  if (params.length) url += `?${params.join('&')}`;

  return url.replace('https://', `https://${encodeURIComponent(username)}:${encodeURIComponent(password)}@`);
}

/**
 * Format Easynews file as stream result
 */
async function resolveDirectDownload(url, username, password, jar) {
  try {
    const client = jar ? wrapper(axios.create({ jar, withCredentials: true })) : axios;
    const response = await client.get(url, {
      maxRedirects: 0,
      validateStatus: status => status >= 200 && status < 400,
      responseType: 'stream',
      headers: {
        'Authorization': createBasicAuth(username, password),
      },
      timeout: 8000,
    });

    if (response.status === 302 && response.headers?.location) {
      // Close the unused stream
      if (response.data?.destroy) {
        response.data.destroy();
      }
      return response.headers.location;
    }
    if (response.data?.destroy) {
      response.data.destroy();
    }
  } catch (err) {
    // Fallback to original URL on any error
  }
  return url;
}

async function formatResult(searchResponse, file, username, password) {
  const title = file['10'] || 'Unknown';
  const size = file.rawSize || 0;
  const fullres = file.fullres || '';
  const quality = extractQuality(title, fullres);
  const languages = file.alangs || [];
  const url = createStreamUrl(searchResponse, file, username, password);
  const resolvedUrl = await resolveDirectDownload(url, username, password, searchResponse.cookieJar);
  const postHash = file['0'] || '';

  // Parse title for additional info
  const parsed = PTT.parse(title);

  // Build info object with all parsed data
  const info = parsed || { title };
  if (quality) {
    info.quality = quality;
  }

  return {
    name: title,
    info,
    size,
    seeders: 999, // Easynews is always available
    url: resolvedUrl,
    source: 'easynews',
    hash: postHash,
    tracker: 'Easynews',
    isCached: true, // Easynews files are always cached/available
    languages,
  };
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

    // Build search query
    const query = buildSearchQuery(meta, type, season, episode);
    console.log(`[${LOG_PREFIX}] Search query: "${query}"`);

    // Search Easynews
    const searchResponse = await search(username, password, query, {
      maxResults: 100,
      sort1: 'dsize', // Sort by size first
      sort2: 'relevance',
      sort3: 'dtime'
    });

    if (!searchResponse || !searchResponse.data || searchResponse.data.length === 0) {
      console.log(`[${LOG_PREFIX}] No results found for query: "${query}"`);
      return [];
    }

    // Filter and format results
    const validFiles = searchResponse.data.filter(file => isValidVideo(file, userConfig));
    console.log(`[${LOG_PREFIX}] ${validFiles.length} valid videos out of ${searchResponse.data.length} results`);

    const formattedResults = await Promise.all(
      validFiles.map(file => formatResult(searchResponse, file, username, password))
    );

    console.log(`[${LOG_PREFIX}] Returning ${formattedResults.length} streams`);
    return formattedResults;

  } catch (error) {
    console.error(`[${LOG_PREFIX}] Error searching Easynews: ${error.message}`);
    return [];
  }
}

/**
 * Resolve Easynews stream URL
 * For compatibility with stream-provider.js
 */
async function resolveStreamUrl(username, password, encodedUrl, clientIp) {
  // Easynews URLs are direct and don't need additional resolution
  // This function exists for API compatibility
  console.log(`[${LOG_PREFIX}] Direct URL resolution not needed for Easynews`);
  return encodedUrl;
}

export default {
  searchEasynewsStreams,
  resolveStreamUrl,
  search,
};
