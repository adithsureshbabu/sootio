#!/usr/bin/env node

/**
 * HTTP Streams Performance Benchmark
 * Benchmarks all HTTP stream providers to identify latency bottlenecks.
 *
 * Usage:
 *   node scripts/benchmark-http-streams.js
 *   node scripts/benchmark-http-streams.js --before   # save baseline
 *   node scripts/benchmark-http-streams.js --after    # compare with baseline
 */

import 'dotenv/config';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import { get4KHDHubStreams } from '../lib/http-streams/providers/4khdhub/streams.js';
import { getHDHub4uStreams } from '../lib/http-streams/providers/hdhub4u/streams.js';
import { getMKVCinemasStreams } from '../lib/http-streams/providers/mkvcinemas/streams.js';
import { getCineDozeStreams } from '../lib/http-streams/providers/cinedoze/streams.js';
import { getMalluMvStreams } from '../lib/http-streams/providers/mallumv/streams.js';
import { getVixSrcStreams } from '../lib/http-streams/providers/vixsrc/streams.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = path.join(__dirname, '.benchmark-baseline.json');

const CONFIG = { clientIp: '127.0.0.1' };

// Test content
const MOVIE = {
  label: 'Inception (2010)',
  tmdbId: 'tt1375666',
  type: 'movie',
  season: null,
  episode: null,
};

const SERIES = {
  label: 'Squid Game S1E1',
  tmdbId: 'tt10919420',
  type: 'series',
  season: '1',
  episode: '1',
};

const PROVIDERS = [
  { name: '4KHDHub',        fn: get4KHDHubStreams,        tests: ['movie'] },
  { name: 'HDHub4u',        fn: getHDHub4uStreams,        tests: ['movie'] },
  { name: 'MKVCinemas',     fn: getMKVCinemasStreams,      tests: ['movie'] },
  { name: 'CineDoze',       fn: getCineDozeStreams,        tests: ['movie'] },
  { name: 'MalluMv',        fn: getMalluMvStreams,         tests: ['movie'] },
  { name: 'VixSrc',         fn: getVixSrcStreams,          tests: ['movie', 'series'] },
];

async function benchmarkProvider(provider, content) {
  const { tmdbId, type, season, episode } = content;
  const start = Date.now();
  let streams = [];
  let error = null;

  try {
    streams = await Promise.race([
      provider.fn(tmdbId, type, season, episode, CONFIG),
      new Promise((_, reject) => setTimeout(() => reject(new Error('benchmark timeout 60s')), 60_000)),
    ]);
    if (!Array.isArray(streams)) streams = [];
  } catch (err) {
    error = err.message;
  }

  const searchMs = Date.now() - start;

  return {
    provider: provider.name,
    content: content.label,
    searchMs,
    streamsCount: streams.length,
    error,
  };
}

function printTable(results) {
  const header = ['Provider', 'Content', 'Search ms', 'Streams', 'Status'];
  const rows = results.map(r => [
    r.provider,
    r.content,
    String(r.searchMs),
    String(r.streamsCount),
    r.error ? `ERR: ${r.error.slice(0, 40)}` : 'OK',
  ]);

  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map(r => r[i].length))
  );

  const sep = widths.map(w => '-'.repeat(w + 2)).join('+');
  const fmtRow = (row) => row.map((c, i) => ` ${c.padEnd(widths[i])} `).join('|');

  console.log(sep);
  console.log(fmtRow(header));
  console.log(sep);
  rows.forEach(r => console.log(fmtRow(r)));
  console.log(sep);
}

function printComparison(before, after) {
  console.log('\n=== Before / After Comparison ===\n');
  const header = ['Provider', 'Content', 'Before ms', 'After ms', 'Delta', 'Streams B', 'Streams A'];
  const rows = [];

  for (const a of after) {
    const b = before.find(x => x.provider === a.provider && x.content === a.content);
    if (!b) continue;
    const delta = a.searchMs - b.searchMs;
    const sign = delta <= 0 ? '' : '+';
    rows.push([
      a.provider,
      a.content,
      String(b.searchMs),
      String(a.searchMs),
      `${sign}${delta}ms`,
      String(b.streamsCount),
      String(a.streamsCount),
    ]);
  }

  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map(r => r[i].length))
  );
  const sep = widths.map(w => '-'.repeat(w + 2)).join('+');
  const fmtRow = (row) => row.map((c, i) => ` ${c.padEnd(widths[i])} `).join('|');

  console.log(sep);
  console.log(fmtRow(header));
  console.log(sep);
  rows.forEach(r => console.log(fmtRow(r)));
  console.log(sep);

  // Summary
  const totalBefore = before.reduce((s, r) => s + r.searchMs, 0);
  const totalAfter = after.reduce((s, r) => s + r.searchMs, 0);
  console.log(`\nTotal before: ${totalBefore}ms | Total after: ${totalAfter}ms | Delta: ${totalAfter - totalBefore}ms`);
}

async function main() {
  const args = process.argv.slice(2);
  const saveBaseline = args.includes('--before');
  const compareBaseline = args.includes('--after');

  console.log('=== HTTP Streams Performance Benchmark ===\n');
  console.log(`Movie:  ${MOVIE.label} (${MOVIE.tmdbId})`);
  console.log(`Series: ${SERIES.label} (${SERIES.tmdbId})\n`);

  const results = [];
  const totalStart = Date.now();

  for (const provider of PROVIDERS) {
    for (const testType of provider.tests) {
      const content = testType === 'movie' ? MOVIE : SERIES;
      console.log(`Benchmarking ${provider.name} with ${content.label}...`);
      const result = await benchmarkProvider(provider, content);
      results.push(result);
      console.log(`  -> ${result.searchMs}ms, ${result.streamsCount} streams${result.error ? `, ERROR: ${result.error}` : ''}\n`);
    }
  }

  const totalMs = Date.now() - totalStart;

  console.log('\n=== Results ===\n');
  printTable(results);
  console.log(`\nTotal benchmark time: ${totalMs}ms`);

  if (saveBaseline) {
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(results, null, 2));
    console.log(`\nBaseline saved to ${BASELINE_PATH}`);
  }

  if (compareBaseline) {
    if (fs.existsSync(BASELINE_PATH)) {
      const before = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8'));
      printComparison(before, results);
    } else {
      console.log('\nNo baseline found. Run with --before first.');
    }
  }

  // JSON output
  const summary = {
    timestamp: new Date().toISOString(),
    totalMs,
    results,
  };
  console.log('\n=== JSON Summary ===');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch(err => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
