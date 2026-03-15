#!/usr/bin/env node

import assert from 'node:assert/strict';

globalThis.File = class File {};
process.env.MKVDRAMA_ASIAN_ONLY = 'true';

const {
  shouldUseMkvDramaForTitle,
  hasLikelyAsianCredits,
  hasAsianScriptSignals,
  looksLikeAsianCreditName
} = await import('../lib/stream-provider.js');

const asianByCredits = {
  name: 'The Judge Returns',
  description: 'The return of corrupt judge Lee Han-young to the past.',
  genres: ['Crime', 'Drama'],
  cast: ['Ji Sung', 'Won Jin-ah', 'Park Hee-soon'],
  director: ['Lee Jae-jin'],
  alternativeTitles: ['The Judge Returns', 'Суддя повертається']
};

const nonAsian = {
  name: 'Fictional Western Show',
  description: 'A detective story set in London and New York.',
  genres: ['Crime', 'Drama'],
  cast: ['Tom Hardy', 'Emily Blunt', 'John Smith'],
  director: ['Danny Boyle'],
  alternativeTitles: ['Fictional Western Show']
};

assert.equal(looksLikeAsianCreditName('Park Hee-soon'), true, 'Expected Korean-style name to match');
assert.equal(looksLikeAsianCreditName('Danny Boyle'), false, 'Expected Western-style name not to match');

assert.equal(hasLikelyAsianCredits(asianByCredits), true, 'Expected Asian credits fallback to match');
assert.equal(hasLikelyAsianCredits(nonAsian), false, 'Expected non-Asian credits not to match');

assert.equal(hasAsianScriptSignals({ name: '악마판사' }), true, 'Expected Hangul script signal to match');
assert.equal(hasAsianScriptSignals({ name: 'Example Title' }), false, 'Expected Latin-only title not to match');

assert.equal(shouldUseMkvDramaForTitle(asianByCredits), true, 'Expected Asian title to pass MKVDrama gate');
assert.equal(shouldUseMkvDramaForTitle(nonAsian), false, 'Expected non-Asian title to fail MKVDrama gate');

console.log('mkvdrama-asian-filter tests passed');
process.exit(0);
