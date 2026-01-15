/**
 * Stream filtering utilities
 */

import { sizeToBytes } from '../../common/torrent-utils.js';

/**
 * Extracts the filename/title from a stream object for episode matching
 * @param {Object} stream - Stream object
 * @returns {string} - Extracted text for episode matching
 */
function extractStreamText(stream) {
  // Try title first (usually contains filename)
  let text = stream.title || '';

  // If title has newlines, take the first line (usually the filename)
  if (text.includes('\n')) {
    text = text.split('\n')[0];
  }

  // Also include name if available
  if (stream.name) {
    text += ' ' + stream.name;
  }

  // Include URL which sometimes has episode info
  if (stream.url) {
    text += ' ' + decodeURIComponent(stream.url);
  }

  return text.toLowerCase();
}

/**
 * Checks if a stream matches the requested episode
 * @param {string} text - Text to check (filename, title, etc.)
 * @param {number} season - Requested season number
 * @param {number} episode - Requested episode number
 * @returns {boolean} - Whether the stream matches
 */
function matchesEpisode(text, season, episode) {
  const ep = String(episode).padStart(2, '0');
  const se = String(season).padStart(2, '0');

  // Check if it's a multi-episode pack (e.g., S02E01-03, E01-E03)
  const multiEpPatterns = [
    new RegExp(`s${se}e(\\d+)-e?(\\d+)`, 'i'),  // S02E01-03 or S02E01-E03
    new RegExp(`s${se}e(\\d+)-(\\d+)`, 'i'),     // S02E01-03
    new RegExp(`e(\\d+)-e?(\\d+)`, 'i')          // E01-03 or E01-E03
  ];

  for (const pattern of multiEpPatterns) {
    const match = text.match(pattern);
    if (match) {
      const startEp = parseInt(match[1], 10);
      const endEp = parseInt(match[2], 10);
      const requestedEp = parseInt(ep, 10);
      // If it's a pack that includes our episode, accept it
      if (requestedEp >= startEp && requestedEp <= endEp) {
        return true;
      }
      // If it's a pack that doesn't include our episode, reject it
      return false;
    }
  }

  // Check for explicit single episode that doesn't match
  const singleEpPatterns = [
    new RegExp(`s${se}e(\\d+)(?!-)`, 'i'),      // S02E01 (not followed by -)
    new RegExp(`s(\\d+)e(\\d+)(?!-)`, 'i'),     // SxxExx (any season)
  ];

  for (const pattern of singleEpPatterns) {
    const match = text.match(pattern);
    if (match) {
      // For S02E01 pattern
      if (match.length === 2) {
        const foundEp = parseInt(match[1], 10);
        return foundEp === parseInt(ep, 10);
      }
      // For SxxExx pattern - check both season and episode
      if (match.length === 3) {
        const foundSeason = parseInt(match[1], 10);
        const foundEp = parseInt(match[2], 10);
        // Wrong season
        if (foundSeason !== parseInt(se, 10)) {
          return false;
        }
        // Wrong episode
        return foundEp === parseInt(ep, 10);
      }
    }
  }

  // Patterns to match the requested episode (positive match)
  const positivePatterns = [
    new RegExp(`s${se}e${ep}\\b`, 'i'),                    // S02E04
    new RegExp(`\\bs${se}\\s*e${ep}\\b`, 'i'),             // S02 E04
    new RegExp(`\\b${parseInt(se, 10)}x${ep}\\b`, 'i'),    // 2x04
    new RegExp(`\\bep(?:isode)?\\s*${parseInt(ep, 10)}\\b`, 'i'),  // Episode 4 / Ep 4
  ];

  return positivePatterns.some(p => p.test(text));
}

/**
 * Normalizes a title for comparison (removes special chars, lowercase, etc.)
 * @param {string} title - Title to normalize
 * @returns {string} - Normalized title
 */
function normalizeTitle(title) {
  return (title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')  // Replace special chars with spaces
    .replace(/\s+/g, ' ')           // Collapse multiple spaces
    .trim();
}

/**
 * Checks if a stream appears to be for a different show based on title
 * @param {string} text - Stream text (filename, title, URL)
 * @param {string} showTitle - Expected show title
 * @returns {boolean} - True if it's likely a different show
 */
function isDifferentShow(text, showTitle) {
  if (!showTitle) return false;

  const normalizedShowTitle = normalizeTitle(showTitle);
  const showWords = normalizedShowTitle.split(' ').filter(w => w.length > 2);

  // If show title is very short (single word like "Fallout"), be stricter
  const mainShowWord = showWords[0] || normalizedShowTitle;

  // Extract what looks like the show name from the text (before SxxExx pattern)
  // Use (.+?) to capture everything before the episode marker, not [^s] which stops at any 's'
  const beforeEpisodeMatch = text.match(/^(.+?)(?:s\d{1,2}e\d{1,2}|\d{1,2}x\d{1,2})/i);

  if (beforeEpisodeMatch) {
    const beforeEpisode = normalizeTitle(beforeEpisodeMatch[1]);

    // Check if the show title appears BEFORE the episode marker
    const hasShowTitleBeforeEpisode = beforeEpisode.includes(mainShowWord);

    // If there's text before the episode marker but it doesn't contain our show title,
    // this is likely a different show
    if (beforeEpisode.length >= 3 && !hasShowTitleBeforeEpisode) {
      console.log(`[EPISODE-FILTER] Different show detected: "${beforeEpisode}" doesn't contain "${mainShowWord}"`);
      return true;
    }
  }

  // Also check for cases like "s02e04 the dresden files, settlers of catan, fallout 4"
  // where the episode marker comes FIRST and other show names appear after
  const startsWithEpisode = /^s\d{1,2}e\d{1,2}/i.test(text.trim());
  if (startsWithEpisode) {
    // Extract what comes after the episode marker
    const afterEpisodeMatch = text.match(/^s\d{1,2}e\d{1,2}\s+(.+)/i);
    if (afterEpisodeMatch) {
      const afterEpisode = normalizeTitle(afterEpisodeMatch[1]);

      // Check for known different show names in the title
      const knownDifferentShows = [
        'dresden files', 'crime story', 'crimestory', 'um actually',
        'stargate', 'heroes', 'nuka break', 'mission impossible',
        'settlers of catan'
      ];

      for (const differentShow of knownDifferentShows) {
        if (afterEpisode.includes(differentShow)) {
          // But also check if our show appears - if both appear, it might be a compilation
          // with our show mentioned
          if (!afterEpisode.includes(mainShowWord)) {
            console.log(`[EPISODE-FILTER] Different show in title: found "${differentShow}" without "${mainShowWord}"`);
            return true;
          }
        }
      }
    }
  }

  return false;
}

/**
 * Filters streams to only include those matching the requested episode and show
 * @param {Array} streams - Array of stream objects
 * @param {number|string} season - Season number
 * @param {number|string} episode - Episode number
 * @param {string} showTitle - Optional show title for stricter matching
 * @returns {Array} - Filtered streams
 */
export function filterByEpisode(streams, season, episode, showTitle = null) {
  // Only filter if we have season AND episode
  if (!season || !episode) {
    return streams;
  }

  const seasonNum = parseInt(season, 10);
  const episodeNum = parseInt(episode, 10);

  if (isNaN(seasonNum) || isNaN(episodeNum)) {
    return streams;
  }

  const beforeCount = streams.length;

  const filtered = streams.filter(stream => {
    const text = extractStreamText(stream);

    // Skip streams that don't have any episode indicators - might be movies or complete series
    // that we can't filter reliably
    const hasEpisodeIndicator = /s\d+e\d+|episode\s*\d+|\bep\s*\d+|\d+x\d+/i.test(text);
    if (!hasEpisodeIndicator) {
      // If it looks like it could be a season pack or complete series, reject it
      if (/complete|full\s*season|all\s*episodes|season\s*pack/i.test(text)) {
        console.log(`[EPISODE-FILTER] Filtering out season pack/complete: ${text.substring(0, 80)}...`);
        return false;
      }
      // No episode indicators but not a pack - keep it (might be movie or can't determine)
      return true;
    }

    // Check if this is a different show entirely
    if (showTitle && isDifferentShow(text, showTitle)) {
      console.log(`[EPISODE-FILTER] Filtering out different show (not "${showTitle}"): ${text.substring(0, 100)}...`);
      return false;
    }

    const matches = matchesEpisode(text, seasonNum, episodeNum);
    if (!matches) {
      console.log(`[EPISODE-FILTER] Filtering out wrong episode: ${text.substring(0, 100)}...`);
    }
    return matches;
  });

  if (filtered.length !== beforeCount) {
    console.log(`[EPISODE-FILTER] Kept ${filtered.length}/${beforeCount} streams matching S${String(seasonNum).padStart(2, '0')}E${String(episodeNum).padStart(2, '0')}${showTitle ? ` for "${showTitle}"` : ''}`);
  }

  return filtered;
}

/**
 * Filters streams by size range
 * @param {Array} streams - Array of stream objects
 * @param {number} minSizeGB - Minimum size in GB
 * @param {number} maxSizeGB - Maximum size in GB
 * @returns {Array} - Filtered streams
 */
export function filterBySize(streams, minSizeGB, maxSizeGB) {
  // Ensure values are numbers
  const minGB = parseInt(minSizeGB, 10) || 0;
  const maxGB = parseInt(maxSizeGB, 10) || 200;

  // If both are at defaults (0 and 200), no filtering
  if (minGB === 0 && maxGB === 200) {
    return streams;
  }

  const minSizeBytes = minGB * 1024 * 1024 * 1024;
  const maxSizeBytes = maxGB * 1024 * 1024 * 1024;
  const beforeCount = streams.length;

  const filtered = streams.filter(stream => {
    // Extract size from the stream object
    // Size could be in the original details or we need to parse from title
    // It could be a number (bytes) or a formatted string (like "6.91GB")
    let size = stream._size || stream.size || 0;

    // If size is a string (like "6.91GB"), convert it to bytes
    if (typeof size === 'string') {
      size = sizeToBytes(size);
    }

    // Try to extract size from title if still 0
    if (size === 0 && stream.title) {
      const sizeMatch = stream.title.match(/(\d+(?:\.\d+)?)\s*(GB|MB|TB)/i);
      if (sizeMatch) {
        const num = parseFloat(sizeMatch[1]);
        const unit = sizeMatch[2].toUpperCase();
        if (unit === 'GB') size = num * 1024 * 1024 * 1024;
        else if (unit === 'MB') size = num * 1024 * 1024;
        else if (unit === 'TB') size = num * 1024 * 1024 * 1024 * 1024;
      }
    }

    if (size === 0) {
      // If no size info, keep the stream (don't filter unknown sizes)
      return true;
    }

    return size >= minSizeBytes && size <= maxSizeBytes;
  });

  if (filtered.length !== beforeCount) {
    console.log(`[SIZE-FILTER] Filtered ${beforeCount - filtered.length} streams by size (${minGB}-${maxGB}GB), kept ${filtered.length}`);
  }

  return filtered;
}

/**
 * Filters streams by resolution
 * @param {Array} streams - Array of stream objects
 * @param {Array} selectedResolutions - Array of selected resolutions (e.g., ['1080p', '2160p'])
 * @returns {Array} - Filtered streams
 */
export function filterByResolution(streams, selectedResolutions) {
  if (!selectedResolutions || selectedResolutions.length === 0) {
    return streams;
  }

  const beforeCount = streams.length;

  const filtered = streams.filter(stream => {
    // Get resolution from stream - use explicit resolution field first, then extract from name/title
    let resolution = stream.resolution || '';

    if (!resolution) {
      // Extract from name or title
      const text = (stream.name || '') + ' ' + (stream.title || '');
      const resMatch = text.match(/\b(2160p|4k|uhd|1440p|1080p|720p|480p|360p)\b/i);
      if (resMatch) {
        resolution = resMatch[1].toLowerCase();
      }
    }

    // Normalize resolution - map variants to standard values
    let normalizedRes = resolution.toLowerCase();
    if (normalizedRes === '4k' || normalizedRes === 'uhd') {
      normalizedRes = '2160p';
    }

    // If no resolution detected, keep the stream (don't filter unknown resolutions)
    if (!normalizedRes) {
      return true;
    }

    return selectedResolutions.includes(normalizedRes);
  });

  if (filtered.length !== beforeCount) {
    console.log(`[RESOLUTION-FILTER] Filtered ${beforeCount - filtered.length} streams by resolution (${selectedResolutions.join(', ')}), kept ${filtered.length}`);
  }

  return filtered;
}
