/**
 * MKVCinemas search helpers
 * Provides search and post parsing utilities for mkvcinemas.pink
 */

import * as cheerio from 'cheerio';
import { makeRequest } from '../../utils/http.js';
import { cleanTitle } from '../../utils/parsing.js';

const BASE_URL = 'https://mkvcinemas.pink';

function normalizeUrl(href, base = BASE_URL) {
    if (!href) return null;
    try {
        return new URL(href, base).toString();
    } catch {
        return null;
    }
}

export async function scrapeMKVCinemasSearch(query) {
    if (!query) return [];

    const searchUrl = `${BASE_URL}/?s=${encodeURIComponent(query)}`;
    try {
        const response = await makeRequest(searchUrl, { parseHTML: true });
        if (!response.document) return [];

        const $ = response.document;
        const results = [];
        $('article.entry-card').each((_, el) => {
            const anchor = $(el).find('h2.entry-title a');
            const title = anchor.text().trim();
            const url = normalizeUrl(anchor.attr('href'));

            if (!title || !url) return;

            const yearMatch = title.match(/\b(19|20)\d{2}\b/);
            const poster = $(el).find('img').attr('src') || null;

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
        console.error(`[MKVCinemas] Search failed for "${query}": ${error.message}`);
        return [];
    }
}

export async function loadMKVCinemasContent(postUrl) {
    if (!postUrl) return { title: '', downloadPages: [], languages: [] };

    try {
        const response = await makeRequest(postUrl, { parseHTML: true });
        if (!response.document) {
            return { title: '', downloadPages: [], languages: [] };
        }

        const $ = response.document;
        const title = $('h1.entry-title').text().trim() || $('title').text().trim() || '';

        const languages = [];
        $('.series-info .language, li.language, li:contains("Language")').each((_, el) => {
            const text = $(el).text().replace(/Language:/i, '').trim();
            if (text) {
                text.split(/[,&/]+/).forEach(lang => {
                    const cleaned = lang.trim();
                    if (cleaned) languages.push(cleaned);
                });
            }
        });

        const downloadPagesSet = new Set();
        $('.entry-content a[href]').each((_, el) => {
            const href = $(el).attr('href');
            if (href && /filesdl|view|downloads?/i.test(href)) {
                const absolute = normalizeUrl(href, postUrl);
                if (absolute) downloadPagesSet.add(absolute);
            }
        });

        return {
            title,
            languages,
            downloadPages: Array.from(downloadPagesSet)
        };
    } catch (error) {
        console.error(`[MKVCinemas] Failed to load post ${postUrl}: ${error.message}`);
        return { title: '', downloadPages: [], languages: [] };
    }
}
