---
title: HerumHai
emoji: 🚀
colorFrom: blue
colorTo: green
sdk: gradio
sdk_version: 6.20.0
app_file: index.js
app_port: 7860
pinned: false
---


# HerumHai — Vercel Serverless Addon

A real-time, serverless **Stremio / Nuvio** addon that resolves direct HLS &amp; MP4 streams with anti-decoy filtering. Built for Vercel Serverless Functions using `@sparticuz/chromium` + `puppeteer-core`.

## Architecture

```
[ Stremio / Nuvio Client ]
            │
            ▼
[ Vercel Serverless Function ]   ← /api/stream (Node.js, maxDuration=120s)
            │
            ▼
[ @sparticuz/chromium + puppeteer-core ]   ← headless browser (no cold start infra)
            │
            ▼
[ VidSrc, 2Embed, MultiEmbed, VidSrc.me, Gomo, DatabaseGDriveCo ]
            │
            ▼
[ Anti-Decoy Filter ]   ← drops tutorial/sample/trailer + MP4s under 50MB
            │
            ▼
[ Stremio Stream Response with proxyHeaders ]
```

## Project Structure

```
vercel-addon/
├── api/
│   ├── manifest.js          # Stremio manifest endpoint
│   ├── stream.js            # Core serverless scraper
│   └── health.js            # Health check
├── public/
│   └── index.html           # Beautiful install landing page
├── package.json
├── vercel.json              # Vercel deployment config
├── .gitignore
└── README.md
```

## Anti-Decoy Filtering (Retained)

The scraper explicitly discards:

1. **Honeypot URLs** containing: `tutorial`, `how-to`, `howto`, `download-guide`, `guide`, `sample`, `trailer`, `demo`, `placeholder`, `loading`, `spinner`, `promo`, `/ads/`, `advert`, `banner`, `logo`, `favicon`, `beacon`, `pixel`, `sharethis`, `googleusercontent`, `/analytics/`

2. **MP4 files under 50MB** — checked via `Content-Length` and `Content-Range` headers. Decoys are tiny; real movies are 500MB+.

3. **Cloudflare internal endpoints** (`/cdn-cgi/`)

4. **Embed URLs themselves** (we want what's INSIDE the embed, not the embed page)

5. **JS/CSS/image/font resources** (player loaders, not streams)

### Valid Stream Criteria (must meet ONE)

- HLS / DASH / MP2T content-type (`application/vnd.apple.mpegurl`, `application/dash+xml`, `video/mp2t`)
- Direct MP4 with content-type `video/mp4` AND size ≥ 50MB
- URL ending in `.m3u8` / `.mpd` / `.mp4` / `.ts` / `.mkv` from a known high-capacity host
- URL from a known host (pixeldrain, hubcloud, streamtape, vidsrc, vidmoly, vmwesa.online, etc.) with a stream-like path

## Proxy Header Injection

Every captured stream is returned to Stremio with `behaviorHints.proxyHeaders` populated from the live browser session:

```json
{
  "streams": [{
    "name": "Premium Hub\n[1080p]",
    "title": "vidsrc — Direct Stream",
    "url": "https://...",
    "behaviorHints": {
      "notWebReady": false,
      "proxyHeaders": {
        "Referer": "https://vidmoly.biz/",
        "User-Agent": "Mozilla/5.0 ... Chrome/126.0.0.0 Safari/537.36",
        "Origin": "https://vidmoly.biz",
        "Cookie": "session=..."
      }
    }
  }]
}
```

This prevents 403 Forbidden errors when Stremio's player tries to fetch the stream directly.

## Deploy to Vercel (GitHub Import)

1. **Push to GitHub:**
   ```bash
   cd vercel-addon
   git init
   git add .
   git commit -m "Initial commit: Vercel Stream Addon"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/vercel-stream-addon.git
   git push -u origin main
   ```

2. **Import to Vercel:**
   - Go to https://vercel.com/new
   - Import your GitHub repo
   - Framework Preset: **Other** (auto-detected)
   - Root Directory: `vercel-addon` (if your repo has it nested)
   - No environment variables needed
   - Click **Deploy**

3. **Get your addon URL:**
   - After deployment, your addon is at:
     ```
     https://YOUR-PROJECT.vercel.app/api/manifest
     ```
   - Or visit the landing page at `https://YOUR-PROJECT.vercel.app/` and click "Install in Stremio"

4. **Install in Stremio:**
   - Open Stremio → Addons → "Add Addon" (top right +)
   - Paste: `https://YOUR-PROJECT.vercel.app/api/manifest`
   - Click **Install**

## Stream Endpoints

| Endpoint | Example |
|----------|---------|
| Movie | `/api/stream?type=movie&id=tt1375666` |
| Series | `/api/stream?type=series&id=tt0944947:1:1` |
| Anime | `/api/stream?type=anime&id=kitsu:41436:1` |

Stremio's native URL format is also supported via `vercel.json` rewrites:
- `/stream/movie/tt1375666.json` → `/api/stream?type=movie&id=tt1375666`
- `/stream/series/tt0944947:1:1.json` → `/api/stream?type=series&id=tt0944947:1:1`
- `/manifest.json` → `/api/manifest`

## Vercel Plan Requirements

| Plan | Max Duration | Notes |
|------|-------------|-------|
| Hobby | 10s | ❌ Too short for real-time scraping |
| **Pro** | **300s** | ✅ Recommended — set `maxDuration: 120` in vercel.json |
| Enterprise | 900s | ✅ Overkill |

The `vercel.json` requests `maxDuration: 120` and `memory: 2048` for `/api/stream`. Upgrade to Vercel Pro ($20/month) to enable this.

## Local Development

```bash
npm install -g vercel
npm install
vercel dev
```

Visit http://localhost:3000

## How the Scraper Works

1. **Receive request** from Stremio with IMDb ID (`tt1375666`)
2. **Resolve title** via Cinemeta public API (`https://v3-cinemeta.strem.io/meta/movie/tt1375666.json`)
3. **Launch headless Chromium** via `@sparticuz/chromium` + `puppeteer-core`
4. **For each indexer** (VidSrc, 2Embed, MultiEmbed, VidSrc.me, Gomo, DatabaseGDriveCo):
   - Navigate to embed URL
   - **6-second Cloudflare Turnstile pause** (lets CF self-verify)
   - If CF challenge still active, wait 8 more seconds
   - Click play button (in main page or any iframe)
   - Wait 15-20s for HLS to initialize
   - Retry click if no streams captured
5. **Filter candidates** through anti-decoy logic
6. **Inject proxyHeaders** (UA, Referer, Cookie) from live session
7. **Return** `{ streams: [...] }` to Stremio

## Adding a New Indexer

Edit `api/stream.js` → `INDEXERS` array:

```javascript
{
  slug: 'mysource',
  type: 'embed',
  buildUrl: (t) =>
    t.type === 'series'
      ? `https://mysource.com/embed/tv/${t.imdbId}/${t.season}/${t.episode}`
      : `https://mysource.com/embed/movie/${t.imdbId}`,
},
```

## Why @sparticuz/chromium?

Vercel Serverless Functions have a **50MB zip size limit** (250MB unzipped). Bundling Chromium directly would exceed this. `@sparticuz/chromium`:

- Provides a Lambda-compatible Chromium binary (~130MB unzipped, loaded at runtime via layer)
- Includes sane launch flags (`--no-sandbox`, `--single-process`, etc.)
- Auto-detects the right executable path
- Works on Vercel, AWS Lambda, and Cloudflare Workers (with the right config)

`puppeteer-core` (not `puppeteer`) is used because it doesn't download Chromium — it expects you to provide the executable path.

## License

MIT
