# HerumHai Backend — Dedicated Scraping Service

A dedicated backend that clones PenguPlay's architecture: continuous background scraping with PostgreSQL caching, so streams are always available even when PenguPlay/HdHub are down.

## Architecture

```
[ Stremio ] → [ Vercel Addon (/streams3/) ] → [ HerumHai Backend (Render) ]
                                                       │
                                              [ PostgreSQL Cache ]
                                                       ▲
                                              [ Background Scraper ]
                                                       │
                                        ┌──────────────┼──────────────┐
                                        │              │              │
                                  [ PenguPlay ]  [ HdHub ]  [ Independent
                                   (proxy)       (proxy)    HubCloud scraper ]
```

## What It Does

1. **Background scraper** runs every 6 hours (via node-cron)
2. Scrapes **top 50 trending movies + 30 trending TV shows** from TMDB
3. Fetches streams from **3 sources in parallel**:
   - PenguPlay proxy (16 sources)
   - HdHub proxy (OD, 4KHDHub, VS Sunny, [Castle], TorBox)
   - **Independent HubCloud scraper** (works without PenguPlay/HdHub!)
4. Stores all streams in **PostgreSQL** (24h TTL)
5. Express API serves cached streams to the Vercel addon **instantly**

## Independence Guaranteed

| Scenario | What Still Works |
|----------|------------------|
| All services up | Full 70+ streams (cached) |
| PenguPlay down | HdHub + independent scraper streams (cached) |
| HdHub down | PenguPlay + independent scraper streams (cached) |
| Both down | Independent HubCloud scraper + cached streams |
| Backend down | Vercel addon falls back to `/stream/` (PenguPlay + HdHub direct) |

## Deploy to Render.com (Free Tier)

### Step 1: Create PostgreSQL Database

1. Go to https://render.com → Dashboard → **New +** → **PostgreSQL**
2. Name: `herumhai-db`
3. Plan: **Free** (90 days, then $7/mo — or use Supabase free tier instead)
4. Copy the **Internal Database URL** (for the backend)
5. Copy the **External Database URL** (for running schema setup)

### Step 2: Run Schema Setup

```bash
# Clone the repo
git clone https://github.com/YOUR_USERNAME/herumhai.git
cd herumhai/backend
npm install

# Set DATABASE_URL temporarily
export DATABASE_URL="postgresql://user:pass@host:5432/db"

# Run schema
npm run db:setup
```

Or use `psql`:
```bash
psql "YOUR_EXTERNAL_DATABASE_URL" -f schema.sql
```

### Step 3: Deploy Backend to Render

1. Go to https://render.com → Dashboard → **New +** → **Web Service**
2. Connect your GitHub repo
3. Settings:
   - **Name**: `herumhai-backend`
   - **Root Directory**: `vercel-addon/backend`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: **Free** (512MB RAM — sufficient for scraping)
4. Environment Variables:
   ```
   DATABASE_URL     = <your-internal-postgresql-url from Step 1>
   TMDB_API_KEY     = <get free key from https://www.themoviedb.org/settings/api>
   PORT             = 8080
   ```
5. Deploy

### Step 4: Set Vercel Env Var

In your Vercel project settings → Environment Variables:
```
BACKEND_URL = https://herumhai-backend.onrender.com
```

### Step 5: Test

```bash
# Test backend health
curl https://herumhai-backend.onrender.com/health

# Test stream endpoint (may take 30s on first request — cold start + scrape)
curl https://herumhai-backend.onrender.com/stream/movie/tt1375666.json | python3 -m json.tool | head -20

# Test via Vercel addon
curl https://herum-hai.vercel.app/streams3/movie/tt1375666.json | python3 -m json.tool | head -20
```

## Alternative: Render Cron Job (for background scraping)

If you don't want the server running 24/7 (Render free tier sleeps after 15min idle):

1. Go to Render → **New +** → **Background Worker**
2. Settings:
   - **Root Directory**: `vercel-addon/backend`
   - **Build Command**: `npm install`
   - **Start Command**: `npm run cron`
   - **Plan**: Free
3. Same env vars as above

This runs the background scraper once and exits. Schedule it via Render's Cron Jobs feature (or use a free service like https://cron-job.org to hit your backend's `/health` every 10 minutes to prevent sleeping).

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Service health check |
| `GET /stream/:type/:id.json` | Get cached streams (triggers on-demand scrape if not cached) |
| `GET /api/stream?type=movie&id=tt1375666` | Same, query-string style |
| `POST /scrape/:type/:id` | Manually trigger a scrape for a title |

## How the Independent Scraper Works

The independent scraper does NOT depend on PenguPlay or HdHub. It:

1. Searches `4khdhub.store` and `new2.hdhub4u.cl` directly for the movie title
2. Walks the search results to find detail pages
3. Extracts **HubCloud IDs** from the HTML (same technique PenguPlay uses)
4. Resolves each HubCloud ID through the **gamerxyt.com proxy**:
   - Visits `hubcloud.{cx|ist|club|fans}/drive/{id}` (4-domain rotation for CF bypass)
   - Extracts the hidden `gamerxyt.com/hubcloud.php` URL
   - Fetches the gamerxyt proxy → gets direct CDN URL
5. Captures 3 CDN patterns:
   - `files.jiomovies.workers.dev/{hash}::{hash}/{size}/{filename}` (Cloudflare Workers)
   - `lh3.googleusercontent.com/pw/AP1Gcz...` (GDrive direct)
   - `video-downloads.googleusercontent.com/{token}` (GDrive DL)

This is the **exact same technique PenguPlay uses server-side** — fully cloned.

## Files

```
backend/
├── server.js              # Express API server (port 8080)
├── scraper.js             # Background scraping engine + cron
├── db.js                  # PostgreSQL connection + cache functions
├── sources/
│   └── hubcloud.js        # HubCloud resolver (cloned from PenguPlay)
├── schema.sql             # Database schema
├── package.json           # Dependencies (express, pg, node-cron, axios)
└── README.md              # This file
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string (Render/Supabase/Neon) |
| `TMDB_API_KEY` | Recommended | For seeding popular titles (free from themoviedb.org) |
| `PORT` | No | Server port (default: 8080) |
| `PROXY_URL` | For CF-blocked sources | `http://user:pass@host:port` — residential proxy (Smartproxy/Bright Data/IPRoyal) |
| `PROXY_HOST` | Alt to PROXY_URL | e.g. `us.smartproxy.com` |
| `PROXY_PORT` | Alt to PROXY_URL | e.g. `10000` |
| `PROXY_USERNAME` | Alt to PROXY_URL | proxy auth username |
| `PROXY_PASSWORD` | Alt to PROXY_URL | proxy auth password |

## Stealth Browser for CF-Aggressively-Blocked Sources

Four sources (`zxcstream`, `filmxy`, `cinemacity`, `ddlbase`) sit behind aggressive
Cloudflare bot protection. They use a dedicated stealth browser factory:

- **`sources/stealth_browser.js`** — puppeteer-extra + StealthPlugin +
  AnonymizeUA + authenticated residential proxy + UA aligned with bundled
  Chromium major (avoids JA3/JA4 mismatch) + WebRTC leak patch + navigator
  overrides (webdriver, plugins, languages, chrome runtime).
- **`sources/cf_sources.js`** — 4 refactored source scrapers that consume
  the stealth factory. Two patterns:
  - **HLS embed** (zxcstream): `newStealthPage()` → `navigateWithCFWait()` →
    capture `.m3u8` URLs from network responses.
  - **WordPress movie** (filmxy/cinemacity/ddlbase): search → find detail
    link → extract HubCloud IDs / GDrive URLs / direct DDL → resolve via
    `hubcloud.js`. Tries multiple alt-domains if primary is CF-blocked.

Without `PROXY_URL` set, the stealth browser still runs but CF may detect
the Render datacenter IP and block. ~$4/GB residential proxy from
Smartproxy / Bright Data / IPRoyal is sufficient.

### Install stealth deps (Render auto-runs `npm install`, but for local dev)

```bash
cd vercel-addon/backend
npm install
# This installs: puppeteer-extra, puppeteer-extra-plugin-stealth,
#                puppeteer-extra-plugin-anonymize-ua, puppeteer-extra-plugin-adblocker,
#                https-proxy-agent
```

### Validate stealth patches

```bash
node -e "
import('./sources/stealth_browser.js').then(async ({ newStealthPage, navigateWithCFWait }) => {
  const page = await newStealthPage();
  await navigateWithCFWait(page, 'https://bot.sannysoft.com/', { maxWait: 20000 });
  const results = await page.evaluate(() => ({
    webdriver: navigator.webdriver,
    chrome: !!window.chrome,
    plugins: navigator.plugins.length,
    languages: navigator.languages,
  }));
  console.log(JSON.stringify(results, null, 2));
  await page.close();
});
"
# webdriver should be undefined, chrome true, plugins > 0, languages = ['en-US','en','hi']
```
