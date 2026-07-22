# HerumHai — Complete Fixed Project (All Files)

## What This Is
This is the COMPLETE HerumHai Stremio addon project with ALL fixes applied:
- All 33 files included (api/, backend/, public/, configs)
- All new sources added (universal_embeds, animesky, streamex)
- All bugs fixed (anime kitsu→TMDB, stream validation, memory leaks, etc.)
- Ready to push to your GitHub repo

## File Structure (33 files)
```
herumhai-complete/
├── api/
│   ├── stream.js              ← CRITICAL: calls backend for anime streams
│   ├── stream3.js             ← Backend proxy endpoint
│   ├── streams2.js            ← HdHub proxy
│   ├── manifest.js            ← Addon manifest
│   ├── direct.js              ← Direct stream proxy
│   └── health.js              ← Health check
├── backend/
│   ├── server.js              ← Express API server
│   ├── scraper.js             ← Background scraping engine
│   ├── db.js                  ← PostgreSQL connection
│   ├── schema.sql             ← Database schema
│   ├── package.json           ← Backend dependencies
│   └── sources/
│       ├── registry.js        ← 34 sources (universal + streamex at front)
│       ├── universal_embeds.js ← NEW: xpass.top + kitsu→TMDB + validation
│       ├── animesky.js        ← NEW: FirePlayer API (multi-audio anime)
│       ├── 4khdhub.js         ← FIXED: xpass.top fallback
│       ├── cf_sources.js      ← FIXED: anime type, SPA API interception
│       ├── stealth_browser.js ← NEW: puppeteer-extra + stealth plugin
│       ├── hubcloud.js        ← HubCloud resolver
│       ├── hdghartv.js        ← HDGharTV scraper
│       └── browser.js         ← Legacy browser scraper
├── public/
│   ├── index.html             ← Landing page
│   └── logo.png               ← Logo
├── package.json               ← Root package
├── vercel.json                ← Vercel config
├── render.yaml                ← Render config
├── Procfile                   ← Render Procfile
├── README.md
└── .gitignore
```

## How to Deploy

### Step 1: Upload to GitHub
1. Download `herumhai-complete.zip` and extract it
2. Go to your GitHub repo: https://github.com/SaugatXthaa/HerumHai
3. Replace ALL files with the extracted contents
4. Commit with message: "Complete rewrite with anime support + universal embeds"

OR (easier):
1. Delete all files in your GitHub repo
2. Upload all 33 files from the extracted folder
3. Commit

### Step 2: Set Environment Variables

#### On Vercel (herum-hai project):
Go to Settings → Environment Variables and add:
```
BACKEND_URL = https://herumhai-backend.onrender.com
DIRECT_URL_SECRET = 6a14fd884445ec97113056ecc91a574cf9193de1cba4e5a927a83bcc16ad6a1f
```

#### On Render (herumhai-backend):
Go to Environment tab and add:
```
DATABASE_URL = postgresql://neondb_owner:npg_v9WOKkMjB8mq@ep-snowy-darkness-azratfrv-pooler.c-3.ap-southeast-1.aws.neon.tech/neondb?sslmode=require
TMDB_API_KEY = 6b2dec73b6697866a50cdaef60ccffcb
PORT = 8080
PROXY_URL = (optional, only for CF-blocked sources like zxcstream/filmxy)
```

### Step 3: Deploy Backend (Render)
1. Render auto-deploys when you push to GitHub
2. Check logs at https://dashboard.render.com → your service → Logs
3. Should show: "HerumHai Backend v1.0.0 Listening on http://0.0.0.0:8080"

### Step 4: Deploy Vercel Addon
1. Vercel auto-deploys when you push to GitHub
2. Check at https://herum-hai.vercel.app/health
3. Should return JSON with status

### Step 5: Test
After both deploy:

**Test Movie:**
```
https://herum-hai.vercel.app/stream/movie/tt1375666.json
```
Should return streams array with 5+ entries

**Test Anime:**
```
https://herum-hai.vercel.app/stream/anime/kitsu:46043:1.json
```
(Witch Hat Atelier S1E1)
Should return streams array with 2+ entries

**Test TV:**
```
https://herum-hai.vercel.app/stream/series/tt0944947:1:1.json
```
(Game of Thrones S1E1)
Should return streams array with 4+ entries

## What Was Fixed (Summary)

### The ROOT CAUSE of anime not working:
Stremio calls `api/stream.js` (Vercel addon), but `api/stream.js` NEVER called the backend where all the anime scrapers live. The new `fetchBackendStreams()` function fixes this.

### Critical Fixes Applied:

1. **api/stream.js**: Added `fetchBackendStreams()` — calls backend `/stream/` endpoint to get anime streams (universal embeds + AnimeSky)

2. **universal_embeds.js** (NEW): play.xpass.top scraper with:
   - kitsu→TMDB resolution (kitsu ID → Kitsu API → title → TMDB search → TMDB ID)
   - Stream validation (curl-based, filters dead 404/403 URLs)
   - Uses curl instead of Node fetch (bypasses Cloudflare TLS fingerprinting)
   - Works for movies, TV, AND anime

3. **animesky.js** (NEW): AnimeSky.top scraper with:
   - FirePlayer API (POST to as-cdn21.top → returns signed .m3u8)
   - Multi-audio support (Hindi/Tamil/Telugu/English/Japanese)
   - URL encoding fix (URLSearchParams)
   - Multi-series iteration

4. **4khdhub.js** (FIXED):
   - xpass.top as Phase 1 fallback (no browser — fast)
   - networkidle2 → domcontentloaded (avoids 30s hangs)
   - Passes kitsuId through

5. **registry.js** (FIXED):
   - universal + streamex moved to FRONT (run first, fastest)
   - close4KHDHubBrowser added to cleanup (memory leak fix)

6. **cf_sources.js** (FIXED):
   - anime type added to standardEmbedPath
   - SPA API interception (scans JSON bodies for stream URLs)

7. **stealth_browser.js** (NEW): puppeteer-extra + StealthPlugin for CF-blocked sources

## Sources Included (34 total)

### Universal (works for ALL content):
- **universal** — play.xpass.top (movies + TV + anime via IMDB/TMDB ID)
- **streamex** — StreameX bypass (uses xpass.top internally)

### HubCloud-based (WordPress sites):
- 4khdhub, 4khdhub_one, cinefreak, moviebox, mkvbase, moviesdrives, vaplayer, videasy, aether, hdghartv, 111477, filmhds, hdhub4u, nima4k, allmovieland, uhdmovies, vegamovie, worldfree4u, moviescounter, 99hdfilms, acermovies, moviedrive, moviesmod

### Anime-specific:
- **animesky** — FirePlayer API (multi-audio)
- aniwaves, animesuge

### CF-blocked (need PROXY_URL):
- zxcstream, vidfast, vidlink (HLS embed)
- filmxy, cinemacity, ddlbase (WordPress)

## Troubleshooting

### "No streams" for anime:
1. Check `BACKEND_URL` is set in Vercel
2. Check backend is running: `https://herumhai-backend.onrender.com/health`
3. Check backend logs for errors
4. Test backend directly: `https://herumhai-backend.onrender.com/stream/anime/kitsu:46043:1.json`

### "Fetching..." stuck in Stremio:
- This means the Vercel addon timed out (30s)
- The backend call has a 20s timeout — if backend is slow, it returns empty
- Check Vercel function logs

### Backend not responding:
- Render free tier spins down after 15min idle
- First request takes 50+ seconds to wake up
- Use https://cron-job.org to ping `https://herumhai-backend.onrender.com/health` every 10min
