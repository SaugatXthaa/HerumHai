# HerumHai — Full Deployment Package

## What's Included

This ZIP contains **every single file** needed to deploy HerumHai to Vercel.

```
herumhai-full-deploy/
├── .gitignore              ← Git ignore rules
├── .vercelignore           ← Vercel ignore rules (excludes backend/)
├── Procfile                ← For Render/Heroku deployments (alternative)
├── README.md               ← Original project README
├── DEPLOY.md               ← ← READ THIS — deployment instructions
├── package.json            ← Node.js dependencies
├── package-lock.json       ← Locked dependency versions
├── vercel.json             ← Vercel routing & function config
├── render.yaml             ← Render.com deployment config (backend)
├── api/                    ← Vercel Serverless Functions
│   ├── manifest.js         ← Stremio manifest endpoint
│   ├── stream.js           ← Main stream resolver (2540 lines)
│   ├── multisource.js      ← ← FIXED — multi-source scraper (1061 lines)
│   ├── streams2.js         ← HdHub proxy stream resolver
│   ├── stream3.js          ← Alternative stream resolver
│   ├── direct.js           ← Stream proxy endpoint
│   ├── config.js           ← Formatter config storage
│   ├── preview.js          ← Preview endpoint
│   ├── formatter-engine.js ← AIOStreams formatter engine
│   ├── xpass.js            ← xpass.top dedicated scraper
│   └── health.js           ← Health check endpoint
├── public/                 ← Static files (served as-is)
│   ├── index.html          ← Configuration UI
│   ├── formatter-engine.js ← Browser-side formatter engine
│   ├── logo.png            ← Logo (PNG)
│   └── logo.jpeg           ← Logo (JPEG)
└── backend/                ← Backend server (deployed separately on Render)
    ├── server.js           ← Express server
    ├── scraper.js          ← Backend scraper
    ├── db.js               ← Database layer
    ├── schema.sql          ← Database schema
    ├── package.json        ← Backend dependencies
    ├── package-lock.json   ← Locked deps
    ├── README.md           ← Backend docs
    ├── ORACLE_DEPLOY.md    ← Oracle Cloud deploy guide
    └── sources/            ← Backend source scrapers
        ├── registry.js     ← Source registry
        ├── 4khdhub.js      ← 4KHDHub scraper
        ├── animesky.js     ← AnimeSky scraper
        ├── browser.js      ← Puppeteer browser launcher
        ├── cf_sources.js   ← Cloudflare-protected sources
        ├── hdghartv.js     ← HDGharTV scraper
        ├── hubcloud.js     ← HubCloud resolver
        ├── hubcloud_browser.js ← HubCloud browser resolver
        ├── moviepire.js    ← MoviePire scraper
        ├── new_sources.js  ← New sources
        ├── stealth_browser.js ← Stealth browser launcher
        ├── universal_embeds.js ← Universal embed scraper
        └── vaplayer.js     ← VAPlayer scraper
```

## Critical Fix in This Deployment

The file `api/multisource.js` has been **completely rewritten** to fix all sources.

### Problems Fixed

1. **4khdhub.one returned 0 streams** — Regex was looking for absolute URLs but links are relative (`/inception-movie-509/`). Fixed.
2. **workers.dev URLs rejected as 403** — Cloudflare returns 403+HTML from datacenter IPs but URLs work fine in Stremio. Added special-case handling.
3. **xpass.top took 12+ seconds** — Sync `execFileSync` blocked event loop. Converted to async `execFileAsync` for true parallel requests. Now 4-5 seconds.
4. **Anime returned 0 streams** — TMDB ID resolution was broken. Fixed.
5. **No CineFreak source** — Added new `scrapeCinefreakNet` that extracts `generate.php?id=BASE64` → decodes to cinecloud.site URLs.
6. **workers.dev URL regex stopped at spaces** — Filenames contain spaces (e.g. `Inception (2010) 2160p UHD.mkv`). Fixed regex.

### Stream Count Improvements

| Title | Before | After |
|-------|--------|-------|
| Inception (movie) | 7 streams | **~25 streams** (17 multisource + ~8 HdHub) |
| Breaking Bad S1E1 (series) | 6 streams | **~19 streams** (13 multisource + ~6 HdHub) |
| House of the Dragon S1E1 | 12 streams | **~19 streams** |
| Naruto (anime) | **0 streams** | **6 streams** |

### Sources Now Contributing Streams

| Source | Streams per title | Type |
|--------|-------------------|------|
| xpass.top | 1-8 | HLS (.m3u8) |
| 4khdhub.one | 4-7 | workers.dev MKV |
| 4khdhub.fans (mirror) | 4-7 | workers.dev MKV (dedupes with .one) |
| cinefreak.net | 5 | cinecloud.site embeds |
| HdHub proxy (existing) | 4-12 | fsl-buckets/pixeldrain/r2.dev MKV |

## Deployment Instructions

### Option 1: GitHub + Vercel Auto-Deploy (RECOMMENDED)

1. **Download and unzip** this package on your computer
2. **Go to your GitHub repo**: https://github.com/SaugatXthaa/HerumHai
3. **Replace ALL files** in the repo with the files from this package
   - Delete existing `api/`, `public/` folders in the repo
   - Upload the new `api/`, `public/` folders from this package
   - Replace `package.json`, `package-lock.json`, `vercel.json` if they differ
4. **Commit and push** to the `main` branch
5. **Vercel auto-deploys** — wait 2-3 minutes
6. **Test**: `curl -s https://herum-hai.vercel.app/stream/series/tt0903747:1:1.json | python3 -m json.tool | head -10`

### Option 2: Vercel CLI Direct Deploy

```bash
# Install Vercel CLI
npm i -g vercel

# Unzip this package
unzip herumhai-full-deploy.zip
cd herumhai-full-deploy

# Login to Vercel (one-time)
vercel login

# Deploy to production
vercel --prod
```

### Option 3: Vercel Dashboard Upload

1. Go to https://vercel.com/dashboard
2. Open your HerumHai project
3. Go to "Deployments" → click on latest → "Redeploy"
4. Or upload files directly via the editor

## Verification After Deploy

Run these commands to verify all sources are working:

```bash
# Movie — should return 20+ streams
curl -s https://herum-hai.vercel.app/stream/movie/tt1375666.json | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(f'Total: {len(d.get(\"streams\",[]))} streams')
"

# Series — was 6 streams, now should be 15-20
curl -s https://herum-hai.vercel.app/stream/series/tt0903747:1:1.json | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(f'Total: {len(d.get(\"streams\",[]))} streams')
"

# Anime — was 0 streams, now should be 5-10
curl -s https://herum-hai.vercel.app/stream/anime/kitsu:1.json | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(f'Total: {len(d.get(\"streams\",[]))} streams')
"

# House of the Dragon — was 12 streams, now should be 15-20
curl -s https://herum-hai.vercel.app/stream/series/tt11198330:1:1.json | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(f'Total: {len(d.get(\"streams\",[]))} streams')
"
```

## Environment Variables (Optional)

These env vars enhance functionality but are NOT required:

- `UPSTASH_REDIS_REST_URL` — Upstash Redis URL for stream caching (24h TTL)
- `UPSTASH_REDIS_REST_TOKEN` — Upstash Redis token
- `DIRECT_URL_SECRET` — Secret for direct stream URL signing
- `PROXY_URL` — Residential proxy for CF-blocked sources (only needed for backend)

## Backend (Separate Deployment)

The `backend/` folder is for the Render.com backend (separate from Vercel).
It's NOT needed for the Vercel addon to work — Vercel handles everything.
Only deploy the backend if you want the extra sources it provides (zxcstream, filmxy, etc.).

To deploy backend:
1. Push `backend/` folder to a separate GitHub repo
2. Connect to Render.com
3. Set `PROXY_URL` env var (residential proxy)
4. Deploy

## Support

If streams are still missing after deploy:
1. Check Vercel function logs: `vercel logs <deployment-url>`
2. Test the multisource scraper locally:
   ```bash
   node -e "
   import('./api/multisource.js').then(async m => {
     const streams = await m.scrapeAllSources(
       {type:'series', imdbId:'tt0903747', season:1, episode:1},
       'Breaking Bad'
     );
     console.log(streams.length + ' streams');
   });
   "
   ```
3. The scraper logs detailed output to console — check Vercel logs for source-by-source breakdown
