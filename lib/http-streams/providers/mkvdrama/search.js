/**
 * MKVDrama search helpers
 * Provides search and post parsing utilities for mkvdrama.net
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import { makeRequest } from '../../utils/http.js';
import { cleanTitle } from '../../utils/parsing.js';
import { FLARESOLVERR_URL } from '../../../config.js';

const BASE_URL = 'https://mkvdrama.net';
const OUO_HOSTS = ['ouo.io'];

// FlareSolverr session cache for reusing browser sessions
const sessionCache = new Map();
const SESSION_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

/**
 * Get or create a FlareSolverr session for mkvdrama
 */
async function getOrCreateSession(flareSolverrUrl) {
    const sessionId = 'sootio_mkvdrama';
    const cached = sessionCache.get('mkvdrama');

    if (cached && (Date.now() - cached.timestamp) < SESSION_CACHE_TTL) {
        return cached.sessionId;
    }

    try {
        const listResponse = await axios.post(`${flareSolverrUrl}/v1`, {
            cmd: 'sessions.list'
        }, { timeout: 10000, headers: { 'Content-Type': 'application/json' } });

        if (listResponse.data?.sessions?.includes(sessionId)) {
            sessionCache.set('mkvdrama', { sessionId, timestamp: Date.now() });
            console.log(`[MKVDrama] Reusing existing FlareSolverr session`);
            return sessionId;
        }
    } catch (error) {
        // Ignore list errors, try to create
    }

    try {
        const response = await axios.post(`${flareSolverrUrl}/v1`, {
            cmd: 'sessions.create',
            session: sessionId
        }, { timeout: 30000, headers: { 'Content-Type': 'application/json' } });

        if (response.data?.status === 'ok') {
            sessionCache.set('mkvdrama', { sessionId, timestamp: Date.now() });
            console.log(`[MKVDrama] Created FlareSolverr session`);
            return sessionId;
        }
    } catch (error) {
        if (error.response?.data?.message?.includes('already exists')) {
            sessionCache.set('mkvdrama', { sessionId, timestamp: Date.now() });
            return sessionId;
        }
        console.log(`[MKVDrama] Failed to create FlareSolverr session: ${error.message}`);
    }
    return null;
}

/**
 * Fetch a page using FlareSolverr with session reuse
 */
async function fetchWithFlareSolverr(url, sessionId = null) {
    const flareSolverrUrl = FLARESOLVERR_URL;
    if (!flareSolverrUrl) return null;

    try {
        const timeout = sessionId ? 30000 : 60000;
        const requestBody = {
            cmd: 'request.get',
            url: url,
            maxTimeout: timeout
        };

        if (sessionId) {
            requestBody.session = sessionId;
        }

        const response = await axios.post(`${flareSolverrUrl}/v1`, requestBody, {
            timeout: timeout + 5000,
            headers: { 'Content-Type': 'application/json' }
        });

        if (response.data?.status === 'ok' && response.data?.solution?.response) {
            return cheerio.load(response.data.solution.response);
        }

        if (sessionId) {
            sessionCache.delete('mkvdrama');
        }
        return null;
    } catch (error) {
        console.log(`[MKVDrama] FlareSolverr error: ${error.message}`);
        if (sessionId) {
            sessionCache.delete('mkvdrama');
        }
        return null;
    }
}

/**
 * Fetch a page - tries FlareSolverr first, falls back to direct request
 */
async function fetchPage(url, signal = null) {
    const flareSolverrUrl = FLARESOLVERR_URL;

    // Try FlareSolverr if configured
    if (flareSolverrUrl) {
        const sessionId = await getOrCreateSession(flareSolverrUrl);
        const $ = await fetchWithFlareSolverr(url, sessionId);
        if ($) return $;
    }

    // Fallback to direct request (may fail with Cloudflare)
    try {
        const response = await makeRequest(url, { parseHTML: true, signal, timeout: 12000 });
        return response.document || null;
    } catch (error) {
        console.error(`[MKVDrama] Direct request failed: ${error.message}`);
        return null;
    }
}

function normalizeUrl(href, base = BASE_URL) {
    if (!href) return null;
    try {
        return new URL(href, base).toString();
    } catch {
        return null;
    }
}

function cleanText(text = '') {
    return text.replace(/\s+/g, ' ').trim();
}

function parseEpisodeRange(label = '') {
    const normalized = label || '';
    const match = normalized.match(/(?:episode|ep)\s*(\d{1,3})(?:\s*(?:-|to)\s*(\d{1,3}))?/i);
    if (match) {
        const start = parseInt(match[1], 10);
        const end = match[2] ? parseInt(match[2], 10) : start;
        if (Number.isNaN(start)) return null;
        return { start, end };
    }

    const seMatch = normalized.match(/\bS(\d{1,2})E(\d{1,3})\b/i);
    if (seMatch) {
        const episode = parseInt(seMatch[2], 10);
        if (!Number.isNaN(episode)) return { start: episode, end: episode };
    }

    const eMatch = normalized.match(/\bE(\d{1,3})\b/i);
    if (eMatch) {
        const episode = parseInt(eMatch[1], 10);
        if (!Number.isNaN(episode)) return { start: episode, end: episode };
    }

    return null;
}

function parseSeasonNumber(label = '') {
    const normalized = label || '';
    const match = normalized.match(/season\s*(\d{1,2})/i) || normalized.match(/\bS(\d{1,2})E\d{1,3}\b/i);
    if (!match) return null;
    const season = parseInt(match[1], 10);
    return Number.isNaN(season) ? null : season;
}

function isOuoLink(url) {
    if (!url) return false;
    return OUO_HOSTS.some(host => url.toLowerCase().includes(host));
}

function collectDownloadLinks($, scope) {
    const downloadLinks = [];
    const seen = new Set();

    const addLink = (entry) => {
        if (!entry?.url || seen.has(entry.url)) return;
        seen.add(entry.url);
        downloadLinks.push(entry);
    };

    scope.each((_, el) => {
        const block = $(el);
        const episodeLabel = cleanText(block.find('.sorattlx, .sorattl, .soratt, h3, h4').first().text());
        const season = parseSeasonNumber(episodeLabel);
        const episodeRange = parseEpisodeRange(episodeLabel);

        block.find('.soraurlx, .soraurl').each((__, linkBox) => {
            const $box = $(linkBox);
            const quality = cleanText($box.find('strong, b').first().text());

            $box.find('a[href]').each((___, link) => {
                const href = $(link).attr('href');
                const absolute = normalizeUrl(href, BASE_URL);
                if (!absolute || !isOuoLink(absolute)) return;

                addLink({
                    url: absolute,
                    label: episodeLabel,
                    quality,
                    linkText: cleanText($(link).text()),
                    episodeStart: episodeRange?.start ?? null,
                    episodeEnd: episodeRange?.end ?? null,
                    season
                });
            });
        });
    });

    return downloadLinks;
}

function collectLooseOuoLinks($, scope, fallbackLabel = '') {
    const downloadLinks = [];
    const seen = new Set();

    scope.find('a[href]').each((_, link) => {
        const href = $(link).attr('href');
        const absolute = normalizeUrl(href, BASE_URL);
        if (!absolute || !isOuoLink(absolute) || seen.has(absolute)) return;
        seen.add(absolute);

        const container = $(link).closest('li, p, div').first();
        const label = cleanText(
            container.find('h1, h2, h3, h4, h5, strong, b').first().text()
        ) || fallbackLabel;
        const quality = cleanText(container.find('strong, b').first().text());
        const episodeRange = parseEpisodeRange(label);
        const season = parseSeasonNumber(label);

        downloadLinks.push({
            url: absolute,
            label,
            quality,
            linkText: cleanText($(link).text()),
            episodeStart: episodeRange?.start ?? null,
            episodeEnd: episodeRange?.end ?? null,
            season
        });
    });

    return downloadLinks;
}

function collectEpisodePostLinks($) {
    const candidates = [];
    const seen = new Set();

    const addCandidate = (title, url) => {
        if (!title || !url || seen.has(url)) return;
        seen.add(url);
        const episodeRange = parseEpisodeRange(title);
        const season = parseSeasonNumber(title);
        candidates.push({
            title,
            url,
            episodeStart: episodeRange?.start ?? null,
            episodeEnd: episodeRange?.end ?? null,
            season
        });
    };

    const selectors = [
        'h2[itemprop="headline"] a[href]',
        'h2.entry-title a[href]',
        'article h2 a[href]',
        'a[rel="bookmark"]'
    ];

    selectors.forEach((selector) => {
        $(selector).each((_, el) => {
            const anchor = $(el);
            const title = cleanText(anchor.text() || anchor.attr('title'));
            const url = normalizeUrl(anchor.attr('href'));
            addCandidate(title, url);
        });
    });

    $('.tt').each((_, el) => {
        const block = $(el);
        const title = cleanText(block.find('h2, b').first().text());
        let anchor = block.find('a[href]').first();
        if (!anchor.length) anchor = block.closest('a[href]');
        if (!anchor.length) anchor = block.parent().find('a[href]').first();
        const url = normalizeUrl(anchor.attr('href'));
        addCandidate(title, url);
    });

    return candidates;
}

function matchesEpisodeEntry(entry, season, episode) {
    if (!episode) return true;
    const seasonNumber = season ? parseInt(season, 10) : null;
    const episodeNumber = parseInt(episode, 10);
    if (Number.isNaN(episodeNumber)) return true;
    if (entry.season && seasonNumber && entry.season !== seasonNumber) return false;
    if (entry.episodeStart && entry.episodeEnd) {
        return episodeNumber >= entry.episodeStart && episodeNumber <= entry.episodeEnd;
    }
    return false;
}

function findEpisodePost($, season, episode) {
    if (!episode) return null;
    const candidates = collectEpisodePostLinks($);
    const match = candidates.find((entry) => matchesEpisodeEntry(entry, season, episode));
    if (match) return match;

    const episodeNumber = parseInt(episode, 10);
    if (Number.isNaN(episodeNumber)) return null;
    const episodeRegex = new RegExp(`\\b(ep(?:isode)?\\s*0*${episodeNumber}\\b|e0*${episodeNumber}\\b|s\\d{1,2}e0*${episodeNumber}\\b)`, 'i');
    return candidates.find((entry) => episodeRegex.test(entry.title)) || null;
}

export async function scrapeMkvDramaSearch(query, signal = null) {
    if (!query) return [];

    const cleanQuery = query.replace(/:/g, '').replace(/\s+/g, ' ').trim();
    const searchUrl = `${BASE_URL}/?s=${encodeURIComponent(cleanQuery)}`;

    try {
        const $ = await fetchPage(searchUrl, signal);
        if (!$) return [];
        const results = [];

        $('article').each((_, el) => {
            const anchor = $(el).find('.bsx a').first();
            const title = cleanText(anchor.attr('title') || anchor.text());
            const url = normalizeUrl(anchor.attr('href'));

            if (!title || !url) return;

            const yearMatch = title.match(/\b(19|20)\d{2}\b/);
            const poster = $(el).find('img').attr('data-lazy-src') || $(el).find('img').attr('src') || null;

            results.push({
                title,
                url,
                year: yearMatch ? parseInt(yearMatch[0], 10) : null,
                poster,
                normalizedTitle: cleanTitle(title)
            });
        });

        return results;
    } catch (error) {
        console.error(`[MKVDrama] Search failed for "${query}": ${error.message}`);
        return [];
    }
}

export async function loadMkvDramaContent(postUrl, signal = null, options = {}) {
    if (!postUrl) return { title: '', downloadLinks: [] };
    const depth = options?.depth ?? 0;

    try {
        const $ = await fetchPage(postUrl, signal);
        if (!$) {
            return { title: '', downloadLinks: [] };
        }
        let title = cleanText($('h1.entry-title').text()) || cleanText($('title').text()) || '';
        title = title.replace(/\s*\|\s*MkvDrama.*$/i, '').trim();

        let downloadLinks = collectDownloadLinks($, $('.soraddlx, .soraddl, .soradd'));

        if (downloadLinks.length === 0) {
            $('.sorattlx, .sorattl, .soratt').each((_, el) => {
                const episodeLabel = cleanText($(el).text());
                const season = parseSeasonNumber(episodeLabel);
                const episodeRange = parseEpisodeRange(episodeLabel);
                const linkBox = $(el).nextAll('.soraurlx, .soraurl').first();
                if (!linkBox.length) return;

                const quality = cleanText(linkBox.find('strong, b').first().text());
                linkBox.find('a[href]').each((__, link) => {
                    const href = $(link).attr('href');
                    const absolute = normalizeUrl(href, BASE_URL);
                    if (!absolute || !isOuoLink(absolute)) return;

                    downloadLinks.push({
                        url: absolute,
                        label: episodeLabel,
                        quality,
                        linkText: cleanText($(link).text()),
                        episodeStart: episodeRange?.start ?? null,
                        episodeEnd: episodeRange?.end ?? null,
                        season
                    });
                });
            });
        }

        if (downloadLinks.length === 0 && options?.episode && depth < 1) {
            const episodePost = findEpisodePost($, options?.season, options?.episode);
            if (episodePost?.url && episodePost.url !== postUrl) {
                const nested = await loadMkvDramaContent(episodePost.url, signal, {
                    ...options,
                    depth: depth + 1
                });
                if (nested.downloadLinks.length) {
                    return nested;
                }
                if (nested.title && !title) {
                    title = nested.title;
                }
                downloadLinks = nested.downloadLinks;
            }
        }

        if (downloadLinks.length === 0) {
            downloadLinks = collectLooseOuoLinks($, $('article, .entry-content, .post-content, body'), title);
        }

        return { title, downloadLinks };
    } catch (error) {
        console.error(`[MKVDrama] Failed to load post ${postUrl}: ${error.message}`);
        return { title: '', downloadLinks: [] };
    }
}
