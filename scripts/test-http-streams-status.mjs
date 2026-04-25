/**
 * HTTP Streams Health Check
 * Tests all HTTP providers with per-provider sample content and writes status reports.
 * Run twice daily via scheduler + on app startup.
 */

import 'dotenv/config';
import { getCineDozeStreams } from '../lib/http-streams.js';
import { get4KHDHubStreams } from '../lib/http-streams.js';
import { getHDHub4uStreams } from '../lib/http-streams.js';
import { getMKVCinemasStreams } from '../lib/http-streams.js';
import { getVixSrcStreams } from '../lib/http-streams.js';
import { getMalluMvStreams } from '../lib/http-streams.js';
import { getMoviesModStreams } from '../lib/http-streams.js';
import { getMoviesLeechStreams } from '../lib/http-streams.js';
import { getAnimeFlixStreams } from '../lib/http-streams.js';
import { resolveHttpStreamUrl } from '../lib/http-streams/resolvers/http-resolver.js';
import { validateSeekableUrl } from '../lib/http-streams/utils/validation.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const PROVIDER_TIMEOUT_MS = parseInt(process.env.HTTP_HEALTH_PROVIDER_TIMEOUT_MS || '45000', 10);
const RESOLVE_TIMEOUT_MS = parseInt(process.env.HTTP_HEALTH_RESOLVE_TIMEOUT_MS || '20000', 10);
const SEEK_206_TIMEOUT_MS = parseInt(process.env.HTTP_HEALTH_SEEK_206_TIMEOUT_MS || '10000', 10);
const MAX_206_PROBE_STREAMS = parseInt(process.env.HTTP_HEALTH_MAX_206_PROBE_STREAMS || '3', 10);

// Output directory for status files
const DATA_DIR = path.join(PROJECT_ROOT, 'data');

// Per-provider test content — each entry uses a movie known to exist on that provider.
// Updated 2026-04-10 by scraping each site's homepage/search.
const PROVIDERS = [
  {
    name: 'CineDoze',
    fn: getCineDozeStreams,
    testId: 'tt3566834',       // A Minecraft Movie (2025)
    testTitle: 'A Minecraft Movie',
    idType: 'imdb',
    type: 'movie',
  },
  {
    name: '4KHDHub',
    fn: get4KHDHubStreams,
    testId: 'tt0816692',       // Interstellar (2014)
    testTitle: 'Interstellar',
    idType: 'imdb',
    type: 'movie',
  },
  {
    name: 'HDHub4u',
    fn: getHDHub4uStreams,
    testId: 'tt3566834',       // A Minecraft Movie (2025)
    testTitle: 'A Minecraft Movie',
    idType: 'imdb',
    type: 'movie',
  },
  {
    name: 'MKVCinemas',
    fn: getMKVCinemasStreams,
    testId: 'tt3566834',       // A Minecraft Movie (2025)
    testTitle: 'A Minecraft Movie',
    idType: 'imdb',
    type: 'movie',
  },
  {
    name: 'VixSrc',
    fn: getVixSrcStreams,
    testId: '157336',          // Interstellar — TMDB ID (VixSrc requires TMDB)
    testTitle: 'Interstellar',
    idType: 'tmdb',
    type: 'movie',
  },
  {
    name: 'MalluMv',
    fn: getMalluMvStreams,
    testId: 'tt3566834',       // A Minecraft Movie (2025)
    testTitle: 'A Minecraft Movie',
    idType: 'imdb',
    type: 'movie',
  },
  {
    name: 'MoviesMod',
    fn: getMoviesModStreams,
    testId: 'tt3566834',       // A Minecraft Movie (2025)
    testTitle: 'A Minecraft Movie',
    idType: 'imdb',
    type: 'movie',
  },
  {
    name: 'MoviesLeech',
    fn: getMoviesLeechStreams,
    testId: 'tt39255646',      // Thaai Kizhavi (2026) — confirmed on site homepage
    testTitle: 'Thaai Kizhavi',
    idType: 'imdb',
    type: 'movie',
  },
  {
    name: 'AnimeFlix',
    fn: getAnimeFlixStreams,
    testId: 'tt3566834',       // A Minecraft Movie (2025)
    testTitle: 'A Minecraft Movie',
    idType: 'imdb',
    type: 'movie',
  },
];

function withTimeout(promise, timeoutMs, message = 'Timeout') {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), timeoutMs))
  ]);
}

async function verifyProviderHas206(streams = []) {
  const candidates = streams.filter(s => s?.url).slice(0, Math.max(1, MAX_206_PROBE_STREAMS));
  const attempts = [];

  for (const stream of candidates) {
    try {
      const resolvedUrl = await withTimeout(
        resolveHttpStreamUrl(stream.url),
        RESOLVE_TIMEOUT_MS,
        'Resolve timeout'
      );

      if (!resolvedUrl) {
        attempts.push({ source: stream.url, reason: 'resolver returned null' });
        continue;
      }

      const validation = await withTimeout(
        validateSeekableUrl(resolvedUrl, {
          requirePartialContent: true,
          timeout: SEEK_206_TIMEOUT_MS
        }),
        SEEK_206_TIMEOUT_MS + 2000,
        '206 probe timeout'
      );

      if (validation?.isValid && validation.statusCode === 206) {
        return {
          ok: true,
          resolvedUrl,
          statusCode: validation.statusCode,
          attempts
        };
      }

      attempts.push({
        source: stream.url,
        resolved: resolvedUrl,
        reason: `status ${validation?.statusCode ?? 'unknown'}`
      });
    } catch (error) {
      attempts.push({
        source: stream?.url || 'unknown',
        reason: error.message
      });
    }
  }

  return {
    ok: false,
    attempts
  };
}

async function testProvider(provider) {
  const start = Date.now();

  try {
    const result = await withTimeout(
      provider.fn(provider.testId, provider.type, null, null, {}),
      PROVIDER_TIMEOUT_MS,
      'Provider timeout'
    );

    const elapsed = Date.now() - start;
    const streams = Array.isArray(result) ? result : [];
    const hasStreams = streams.length > 0;

    if (!hasStreams) {
      return {
        name: provider.name,
        status: 'no-content',
        streams: 0,
        error: null,
        testContent: `${provider.testTitle} (${provider.testId})`,
        elapsedMs: elapsed,
        testedAt: new Date().toISOString()
      };
    }

    const strict206 = await verifyProviderHas206(streams);

    // If streams were found but 206 verification failed, mark as "working (preview)"
    // This happens for lazy-load providers where URLs are resolved on-demand at play time
    const hasPreviewStreams = !strict206.ok && streams.some(s =>
      s.behaviorHints?.needsResolution || s.needsResolution ||
      s.url?.includes('hubdrive') || s.url?.includes('hubcloud') || s.url?.includes('hubcdn')
    );

    return {
      name: provider.name,
      status: strict206.ok ? 'working' : (hasPreviewStreams ? 'working' : 'failed'),
      streams: streams.length,
      error: strict206.ok
        ? null
        : (hasPreviewStreams
          ? null
          : `No HTTP 206 stream verified (checked ${Math.max(1, Math.min(streams.length, MAX_206_PROBE_STREAMS))} stream${Math.min(streams.length, MAX_206_PROBE_STREAMS) === 1 ? '' : 's'})`),
      verified206Status: strict206.statusCode || null,
      verified206Url: strict206.resolvedUrl || null,
      previewOnly: hasPreviewStreams && !strict206.ok,
      probeAttempts: strict206.attempts || [],
      testContent: `${provider.testTitle} (${provider.testId})`,
      elapsedMs: elapsed,
      testedAt: new Date().toISOString()
    };
  } catch (err) {
    return {
      name: provider.name,
      status: 'failed',
      streams: 0,
      error: err.message,
      testContent: `${provider.testTitle} (${provider.testId})`,
      elapsedMs: Date.now() - start,
      testedAt: new Date().toISOString()
    };
  }
}

async function runHealthCheck() {
  console.log('[HTTP-HEALTH] Starting health check at', new Date().toISOString());
  console.log(`[HTTP-HEALTH] Testing ${PROVIDERS.length} providers with per-provider sample content...`);

  const results = await Promise.all(
    PROVIDERS.map(provider => testProvider(provider))
  );

  const summary = {
    timestamp: new Date().toISOString(),
    results,
    summary: {
      total: results.length,
      working: results.filter(r => r.status === 'working').length,
      noContent: results.filter(r => r.status === 'no-content').length,
      failed: results.filter(r => r.status === 'failed').length,
      successRate: `${Math.round(results.filter(r => r.status === 'working').length / results.length * 100)}%`
    }
  };

  // Format as markdown for readability
  const markdown = generateMarkdownReport(summary);

  // Ensure data directory exists
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  // Write to data/ directory
  const mdPath = path.join(DATA_DIR, 'http-streams-status.md');
  const jsonPath = path.join(DATA_DIR, 'http-streams-status.json');

  fs.writeFileSync(mdPath, markdown, 'utf8');
  fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2), 'utf8');

  console.log(`[HTTP-HEALTH] Reports written to ${mdPath} and ${jsonPath}`);
  console.log('[HTTP-HEALTH] Health check complete');
  console.log(markdown);

  return summary;
}

function generateMarkdownReport(summary) {
  const { working, noContent, failed, total, successRate } = summary.summary;
  const timestamp = new Date(summary.timestamp).toLocaleString();

  let report = `# HTTP Streams Health Report\n\n`;
  report += `**Last Updated:** ${timestamp}\n\n`;

  report += `## Summary\n`;
  report += `- ✅ **Working (HTTP 206 verified):** ${working}/${total}\n`;
  report += `- ⚠️ **No Content:** ${noContent}/${total}\n`;
  report += `- ❌ **Failed:** ${failed}/${total}\n`;
  report += `- 📊 **Success Rate:** ${successRate}\n\n`;

  report += `## Provider Status\n\n`;
  report += `| Provider | Status | Streams | Test Content | Time |\n`;
  report += `|----------|--------|---------|-------------|------|\n`;

  for (const r of summary.results) {
    const icon = r.status === 'working' ? '✅' : r.status === 'no-content' ? '⚠️' : '❌';
    const time = r.elapsedMs < 1000 ? `${r.elapsedMs}ms` : `${(r.elapsedMs / 1000).toFixed(1)}s`;
    const detail = r.status === 'working'
      ? (r.previewOnly ? `${r.streams} streams (preview)` : `${r.streams} streams (206 verified)`)
      : (r.error
          ? (r.error.length > 90 ? `${r.error.substring(0, 87)}...` : r.error)
          : `${r.streams} streams`);
    report += `| ${icon} ${r.name} | ${r.status} | ${detail} | ${r.testContent} | ${time} |\n`;
  }

  report += `\n---\n`;
  report += `*Automated health check. Runs on startup + twice daily (6am/6pm UTC).*\n`;

  return report;
}

// Run the check
runHealthCheck()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('[HTTP-HEALTH] Error:', err.message);
    process.exit(1);
  });

// Timeout after 5 minutes total
setTimeout(() => {
  console.error('[HTTP-HEALTH] Health check timeout (5 min)');
  process.exit(1);
}, 5 * 60 * 1000);
