Audit and tune stream filtering settings — quality limits, codec diversity, episode matching, and sort order.

No arguments required.

## Instructions

Read the following files and produce a comprehensive filter audit with current values and actionable recommendations. Do NOT modify any files.

### Step 1 — Read quality/codec filter config

Read `lib/util/filter-torrents.js` in full. Extract:
- `MAX_RESULTS_REMUX` — max remux results (default value from code)
- `MAX_RESULTS_BLURAY` — max Blu-ray results
- `MAX_RESULTS_WEBDL` — max WEB-DL results
- `MAX_RESULTS_WEBRIP` — max WEBRip results
- `MAX_RESULTS_AUDIO` — max audio-focused results
- `MAX_RESULTS_OTHER` — max other/unknown quality results
- `DIVERSIFY_CODECS_ENABLED` — whether codec diversity is enforced
- `MAX_H265_RESULTS_PER_QUALITY` — max H.265/HEVC per quality tier
- `MAX_H264_RESULTS_PER_QUALITY` — max H.264/AVC per quality tier
- `TARGET_CODEC_COUNT` — target codec count per tier
- `PRIORITY_SKIP_WEBRIP_ENABLED` — skip WEBRip when better sources available
- `PRIORITY_SKIP_AAC_OPUS_ENABLED` — skip AAC/Opus when better audio available
- `DISABLE_VIDEO_INDICATOR_FILTER` — bypass video file indicator filter

### Step 2 — Read episode filtering config

Read `lib/stream-provider/utils/filtering.js` in full. Extract:
- Episode match patterns: `positivePatterns` array (S##E##, episode markers, etc.)
- Multi-episode patterns: `multiEpPatterns` array
- Season pack detection keywords
- Language filter logic (how languages are matched/excluded)
- Any configurable thresholds or regex patterns

### Step 3 — Read sorting config

Read `lib/stream-provider/utils/sorting.js`. Extract:
- Sort key priority order (resolution first? then seeders? size?)
- Whether language preference affects sort order
- Any configurable sort weights

### Step 4 — Read current env settings

Read `.env` (preferred) or `.env.example`. Extract the current values for all filter-related env vars:
- `MAX_RESULTS_*`
- `DIVERSIFY_CODECS_ENABLED`
- `MAX_H265_RESULTS_PER_QUALITY`, `MAX_H264_RESULTS_PER_QUALITY`
- `PRIORITY_SKIP_WEBRIP_ENABLED`, `PRIORITY_SKIP_AAC_OPUS_ENABLED`
- `DISABLE_VIDEO_INDICATOR_FILTER`

### Step 5 — Generate sample filter test

Using the episode patterns extracted in Step 2, mentally test these sample stream names and show which would PASS and which would FAIL the episode filter for a request of `S01E03`:

```
Breaking.Bad.S01E03.720p.BluRay.x264              → should PASS
Breaking.Bad.S01E01-E16.720p.COMPLETE             → MULTI-EP — depends on config
Breaking.Bad.Season.1.Complete.720p               → SEASON PACK — usually filtered
Breaking.Bad.S01.720p                              → SEASON PACK
Breaking.Bad.1x03.720p                             → should PASS (alt format)
Breaking.Bad.Episode.3.Season.1.720p               → should PASS
Breaking Bad - S01E03 - Cat's in the Bag.mkv       → should PASS
```

### Step 6 — Produce filter audit report

```
## Filter Audit Report

### Quality Limits (current vs defaults)
| Filter | Current | Default | Notes |
|--------|---------|---------|-------|
| MAX_RESULTS_REMUX | <value> | 3 | Remux = best quality, large files |
| MAX_RESULTS_BLURAY | <value> | 5 | |
| MAX_RESULTS_WEBDL | <value> | 10 | Most common quality tier |
| MAX_RESULTS_WEBRIP | <value> | 8 | |
| MAX_RESULTS_AUDIO | <value> | 3 | |
| MAX_RESULTS_OTHER | <value> | 5 | |

### Codec Diversity
DIVERSIFY_CODECS_ENABLED: <value>
MAX_H265_RESULTS_PER_QUALITY: <value>
MAX_H264_RESULTS_PER_QUALITY: <value>

### Priority Filters
PRIORITY_SKIP_WEBRIP_ENABLED: <value>
PRIORITY_SKIP_AAC_OPUS_ENABLED: <value>

### Sort Order
<describe current sort priority>

### Episode Filter Test Results (for S01E03 request)
<show pass/fail for each test case above>

### Issues Found
<numbered list>

### Tuning Recommendations

**"Too many results / Stremio is slow":**
Reduce result counts: MAX_RESULTS_WEBDL=5, MAX_RESULTS_WEBRIP=4, MAX_RESULTS_OTHER=3

**"Missing episodes / wrong episodes shown":**
<describe any gaps in positivePatterns or edge cases>
Consider: check if alt episode formats (1x03, Ep03) are covered

**"Only seeing H265 / H264 results":**
If DIVERSIFY_CODECS_ENABLED=false → set to true
Tune MAX_H265_RESULTS_PER_QUALITY=3 and MAX_H264_RESULTS_PER_QUALITY=3

**"WEBRip showing when WEB-DL available":**
Set PRIORITY_SKIP_WEBRIP_ENABLED=true

**"Remux results flooding the list":**
Reduce MAX_RESULTS_REMUX=2 or MAX_RESULTS_BLURAY=3

### Recommended .env Changes
<specific env var = value pairs to add/change based on findings>
```
