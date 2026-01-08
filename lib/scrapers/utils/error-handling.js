import axios from 'axios';

/**
 * Handles scraper errors with consistent logging and re-throws for penalty tracking
 * @param {Error} error - The error object
 * @param {string} scraperName - Name of the scraper
 * @param {string} logPrefix - Log prefix (e.g., 'RD', 'TB')
 */
export function handleScraperError(error, scraperName, logPrefix) {
    if (!axios.isCancel(error)) {
        console.error(`[${logPrefix} SCRAPER] ${scraperName} search failed: ${error.message}`);
    }
    // Re-throw so scraper-selector can apply penalties for 429s, 5xx, etc.
    throw error;
}
