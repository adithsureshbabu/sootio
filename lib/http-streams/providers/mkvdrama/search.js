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
    const match = label.match(/(?:episode|ep)\s*(\d{1,3})(?:\s*(?:-|to)\s*(\d{1,3}))?/i);
    if (!match) return null;
    const start = parseInt(match[1], 10);
    const end = match[2] ? parseInt(match[2], 10) : start;
    if (Number.isNaN(start)) return null;
    return { start, end };
}

function parseSeasonNumber(label = '') {
    const match = label.match(/season\s*(\d{1,2})/i);
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
        const episodeLabel = cleanText(block.find('.sorattlx').first().text());
        const season = parseSeasonNumber(episodeLabel);
        const episodeRange = parseEpisodeRange(episodeLabel);

        block.find('.soraurlx').each((__, linkBox) => {
            const $box = $(linkBox);
            const quality = cleanText($box.find('strong').first().text());

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

export async function loadMkvDramaContent(postUrl, signal = null) {
    if (!postUrl) return { title: '', downloadLinks: [] };

    try {
        const $ = await fetchPage(postUrl, signal);
        if (!$) {
            return { title: '', downloadLinks: [] };
        }
        let title = cleanText($('h1.entry-title').text()) || cleanText($('title').text()) || '';
        title = title.replace(/\s*\|\s*MkvDrama.*$/i, '').trim();

        let downloadLinks = collectDownloadLinks($, $('.soraddlx'));

        if (downloadLinks.length === 0) {
            $('.sorattlx').each((_, el) => {
                const episodeLabel = cleanText($(el).text());
                const season = parseSeasonNumber(episodeLabel);
                const episodeRange = parseEpisodeRange(episodeLabel);
                const linkBox = $(el).nextAll('.soraurlx').first();
                if (!linkBox.length) return;

                const quality = cleanText(linkBox.find('strong').first().text());
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

        return { title, downloadLinks };
    } catch (error) {
        console.error(`[MKVDrama] Failed to load post ${postUrl}: ${error.message}`);
        return { title: '', downloadLinks: [] };
    }
}
