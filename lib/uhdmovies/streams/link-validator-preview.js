/**
 * Preview Mode Link Validator for UHDMovies
 * Returns links without expensive SID validation (8s per link!)
 * Validation happens on-click via resolveUHDMoviesUrl
 */

// Lightweight helpers to grab metadata from DriveSeed page (size, filename)
async function enrichLinkWithDriveSeedMetadata(linkInfo, timeoutMs = 12000) {
  if (!linkInfo?.link) {
    return null;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    // Dynamic import to avoid circular dependency
    const { resolveSidToDriveleech } = await import('../resolvers/sid-resolver.js');
    const driveleechUrl = await resolveSidToDriveleech(linkInfo.link);

    clearTimeout(timer);
    if (!driveleechUrl) {
      console.log(`[UHDMovies] (preview metadata) SID->DriveSeed failed, keeping link for on-click validation: ${linkInfo.rawQuality || linkInfo.quality}`);
      return linkInfo;
    }

    // Fetch final page to read metadata
    const { default: axios } = await import('axios');
    const resp = await axios.get(driveleechUrl, { maxRedirects: 8, timeout: timeoutMs });
    const html = resp?.data || '';
    const cheerio = (await import('cheerio')).default;
    const $ = cheerio.load(html);

    const extractLabelValue = (labels = []) => {
      for (const label of labels) {
        const item = $('li.list-group-item').filter((i, el) => $(el).text().toLowerCase().includes(label.toLowerCase())).first();
        if (item.length > 0) {
          const text = item.text().trim();
          const match = text.match(/:\s*(.+)$/);
          if (match && match[1]) return match[1].trim();
          return text.replace(new RegExp(label, 'i'), '').trim();
        }
      }
      return null;
    };

    const normalizeSize = (text) => {
      if (!text) return null;
      const m = text.match(/([0-9.,]+\s*[KMGT]B(?!ps)(?:\s*-\s*[0-9.,]+\s*[KMGT]B(?!ps)?)*)(?:\s*\/\s*E.*)?/i);
      return m ? m[1].replace(/\s+/g, ' ').trim() : null;
    };

    const fileName = extractLabelValue(['file name', 'filename', 'name']);
    const size = normalizeSize(extractLabelValue(['size']));
    // Detect "Resume Cloud" button or any /zfile/ link (alternative resume route)
    const hasResumeCloud =
      $('a:contains("Resume Cloud"), a:contains("Cloud Resume Download"), a.btn-warning:contains("Resume"), a[href*="/zfile/"]').length > 0 ||
      html.includes('Resume Cloud') ||
      html.includes('/zfile/') ||
      $('a[href*="workers.dev"]').filter((_, el) => ($(el).attr('href') || '').includes('::')).length > 0;

    if (!hasResumeCloud) {
      console.log(`[UHDMovies] (preview metadata) Missing Resume Cloud on DriveSeed page, dropping: ${linkInfo.rawQuality || linkInfo.quality}`);
      linkInfo.__invalid = true;
      return linkInfo;
    }

    linkInfo.resumeCloud = true;
    if (fileName) linkInfo.fileName = fileName;
    if (size) linkInfo.size = size;
  } catch (e) {
    console.log(`[UHDMovies] (preview metadata) failed for ${linkInfo?.rawQuality || linkInfo?.quality}: ${e.message}`);
    // Do not hard-fail on metadata fetch; allow resolver to validate later.
  }

  return linkInfo.__invalid ? null : linkInfo;
}

/**
 * Extract and return links without validation (preview mode)
 * FAST: No SID resolution, no HTTP validation
 */
export async function extractLinksWithoutValidation(
  matchingResult,
  matchingResults,
  scoredResults,
  downloadInfo,
  mediaType,
  season,
  episode,
  year,
  extractTvShowDownloadLinks,
  extractDownloadLinks
) {
  const extractTimerId = `[UHDMovies-${Math.random().toString(36).substring(7)}] extractDownloadLinks (preview mode)`;

  console.time(extractTimerId);
  let linkData = await (mediaType === 'tv'
    ? extractTvShowDownloadLinks(matchingResult.link, season, episode)
    : extractDownloadLinks(matchingResult.link, year));
  try { console.timeEnd(extractTimerId); } catch {}
  console.log(`[UHDMovies] Download info (preview mode):`, linkData);

  // Check if season was not found or episode extraction failed, and we have multiple results to try
  if (linkData.links.length === 0 && matchingResults.length > 1 && scoredResults &&
      (linkData.seasonNotFound || (mediaType === 'tv' && linkData.title))) {
    console.log(`[UHDMovies] Season ${season} not found or episode extraction failed on best match. Trying next best match...`);

    // Try the next best match
    const nextBestMatch = scoredResults[1];
    console.log(`[UHDMovies] Trying next best match: "${nextBestMatch.title}"`);

    linkData = await (mediaType === 'tv'
      ? extractTvShowDownloadLinks(nextBestMatch.link, season, episode)
      : extractDownloadLinks(nextBestMatch.link, year));

    if (linkData.links.length > 0) {
      console.log(`[UHDMovies] Successfully found links on next best match!`);
    } else {
      console.log(`[UHDMovies] Next best match also failed. No download links found.`);
    }
  }

  if (linkData.links.length === 0) {
    console.log('[UHDMovies] No download links found on page.');
    return [];
  }

  // Return links WITHOUT validation (preview mode)
  console.log(`[UHDMovies] Found ${linkData.links.length} SID links - returning without validation (preview mode)`);

  const maxLinksToReturn = Math.min(10, linkData.links.length);
  const candidateLinks = linkData.links.slice(0, maxLinksToReturn);

  // Transform links to the expected format WITHOUT validation
  let previewLinks = candidateLinks.map(linkInfo => ({
    quality: linkInfo.quality,
    rawQuality: linkInfo.rawQuality,
    url: linkInfo.link,  // Original SID URL
    size: linkInfo.size || 'Unknown',
    languageInfo: linkInfo.languageInfo || [],
    needsResolution: true,
    isPreview: true  // Flag to indicate this is a preview
  }));

  // Enrich with DriveSeed metadata (file name/size) where possible
  const enriched = await Promise.all(previewLinks.map(link => enrichLinkWithDriveSeedMetadata({ ...link })));
  previewLinks = enriched.filter(Boolean);

  // If enrichment eliminated everything, fall back to original candidate links (let resolver validate on click)
  if (previewLinks.length === 0 && candidateLinks.length > 0) {
    console.log('[UHDMovies] Preview enrichment yielded 0 links; falling back to raw candidate links for lazy validation.');
    previewLinks = candidateLinks.map(linkInfo => ({
      quality: linkInfo.quality,
      rawQuality: linkInfo.rawQuality,
      url: linkInfo.link,
      size: linkInfo.size || 'Unknown',
      languageInfo: linkInfo.languageInfo || [],
      needsResolution: true,
      isPreview: true
    }));
  }

  // Deduplicate based on quality and size
  const seen = new Set();
  const originalCount = previewLinks.length;
  const deduped = previewLinks.filter(link => {
    const key = `${link.quality}_${link.size}_${link.rawQuality}`;
    if (seen.has(key)) {
      console.log(`[UHDMovies] Removing duplicate preview: ${link.rawQuality?.substring(0, 60) || link.quality}`);
      return false;
    }
    seen.add(key);
    return true;
  });

  if (originalCount > deduped.length) {
    console.log(`[UHDMovies] Removed ${originalCount - deduped.length} duplicate preview stream(s)`);
  }

  console.log(`[UHDMovies] Returning ${deduped.length} preview links (no validation - instant response!)`);
  return deduped;
}
