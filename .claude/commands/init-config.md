Interactive first-time setup wizard — guides through critical configuration choices and creates or updates `.env`.

No arguments required.

## Instructions

This command walks through the essential configuration decisions step by step and creates a working `.env` file. Be conversational and helpful throughout.

### Step 1 — Read reference files

Read `.env.example` fully to understand all available vars, their defaults, and the inline comments.

Check if `.env` already exists:
- If yes: read it and note which vars are already set. This is an update, not a fresh install.
- If no: this is a fresh install.

### Step 2 — Gather information interactively

Ask the user for each of the following in order. For each question, show the current value if `.env` already exists. Show available options where relevant.

**2a. Addon URL**
Ask: "What URL will this addon be served at? (e.g. http://localhost:7000 for local, or your public domain)"
Env var: `ADDON_URL`
Note: Must be the full URL that Stremio will use to install the addon.

**2b. Port**
Ask: "What port should the addon listen on? (default: 7000)"
Env var: `PORT`
Default: `7000`

**2c. Debrid service**
Ask: "Which debrid service will you use?" with options:
- `realdebrid` — Real-Debrid (most popular, best cache)
- `alldebrid` — All-Debrid
- `torbox` — TorBox
- `premiumize` — Premiumize
- `offcloud` — OffCloud
- `debridlink` — Debrid-Link
- `debrider` — Debrider.app
- `none` — No debrid service (HTTP streaming providers only)

Env var: `DEFAULT_DEBRID_SERVICE`

**2d. Debrid API key**
If a debrid service was selected (not `none`), ask for the API key.
Map service → env var:
- realdebrid → `RD_API_KEY`
- alldebrid → `AD_API_KEY`
- torbox → `TORBOX_API_KEY`
- premiumize → `PREMIUMIZE_API_KEY`
- offcloud → `OFFCLOUD_API_KEY`
- debridlink → `DL_API_KEY`
- debrider → `DEBRIDER_API_KEY`

Note: "You can find your API key in your debrid service account settings."

**2e. Torrent scrapers**
Ask: "Which torrent scrapers do you want to enable? (recommended: at least 3–5 for good coverage)"

Show the full list with descriptions:
- `KNABEN_ENABLED` — Knaben (fast JSON API, recommended)
- `TORRENTIO_ENABLED` — Torrentio bridge (high quality results, recommended)
- `JACKETT_ENABLED` — Jackett (requires self-hosted Jackett instance)
- `ZILEAN_ENABLED` — Zilean (requires self-hosted Zilean instance)
- `TORRENT_1337X_ENABLED` — 1337x (popular tracker)
- `MAGNETDL_ENABLED` — MagnetDL
- `TORRENT_GALAXY_ENABLED` — TorrentGalaxy
- `SNOWFL_ENABLED` — Snowfl (aggregator)
- `BTDIG_ENABLED` — BTDigg (DHT search)
- `COMET_ENABLED` — Comet bridge

Default recommendation if user is unsure: enable Knaben, Torrentio, Snowfl.

For Jackett: if enabled, also ask for `JACKETT_URL` and `JACKETT_API_KEY`.
For Zilean: if enabled, also ask for `ZILEAN_URL`.

**2f. Cache backend**
Ask: "Do you want to enable the SQLite cache? (strongly recommended — avoids redundant API calls)"
Default: yes.

If yes:
- Set `SQLITE_CACHE_ENABLED=true`
- Ask: "How many days to keep cached results? (default: 30)" → `SQLITE_CACHE_TTL_DAYS`
- Note: "The cache is stored in the `data/` directory. Make sure this directory exists: `mkdir -p data`"

**2g. FlareSolverr (optional)**
Ask: "Do you have a FlareSolverr instance? (needed for MKVDrama and MKVCinemas providers)"
If yes: ask for `FLARESOLVERR_URL` (e.g. `http://localhost:8191`)
If no: skip — those providers will have reduced functionality.

**2h. HTTP streaming providers (optional)**
Ask: "Do you want to enable any HTTP streaming providers? (these provide direct download links without requiring a debrid service)"

List the main ones:
- `4KHDHUB_ENABLED` — 4KHDHub (high quality, many links)
- `MKVDRAMA_ENABLED` — MKVDrama (Asian dramas, requires FlareSolverr)
- `MKVCINEMAS_ENABLED` — MKVCinemas (Bollywood + Hollywood)
- `NETFLIXMIRROR_ENABLED` — NetflixMirror
- `HDHUB4U_ENABLED` — HDHub4u

Default recommendation: enable 4KHDHub if they want HTTP streams.

### Step 3 — Write the .env file

Construct the `.env` content from the gathered values.

If `.env` already existed: merge the new values into the existing content (update changed vars, add new ones, preserve unchanged vars and comments).

If fresh install: write a clean `.env` with only the configured vars plus the essential section headers as comments.

Show the user what will be written (diff if updating, full file if creating), then create/update the file.

### Step 4 — Post-setup checklist

After writing `.env`, show:

```
## Setup Complete ✅

### Next Steps:
1. Create the cache directory (if SQLite enabled):
   mkdir -p data

2. Install dependencies:
   pnpm install

3. Start the addon:
   npm start          # production (multi-worker)
   npm run dev        # development (auto-reload)

4. Install in Stremio:
   Open Stremio → Search → paste: <ADDON_URL>/manifest.json

5. Run /check-config to validate your setup at any time.
```

Offer to run `/check-config` now to validate the written configuration.
