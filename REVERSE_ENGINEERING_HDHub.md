# HdHub Addon Reverse-Engineering Report

Complete technical breakdown of `https://hdhub.thevolecitor.qzz.io/` — a second Stremio addon proxied by HerumHai via `api/streams2.js`.

## Target

- **URL**: `https://hdhub.thevolecitor.qzz.io/`
- **Manifest**: `https://hdhub.thevolecitor.qzz.io/manifest.json`
- **Addon ID**: `com.stremio.HdHub` v1.0.6
- **Stack**: Express.js + Cloudflare
- **Configurable**: yes — accepts `?config={base64url(JSON)}` or `/{base64url_config}/manifest.json`

## Architecture (Distinct from PenguPlay)

```
[ Stremio Client ]
       │
       ▼
[ hdhub.thevolecitor.qzz.io/stream/{type}/{id}.json ]
       │
       │   HdHub's scraper (server-side) queries multiple CDNs:
       │
       ├─ a.111477.xyz/movies/{title}/{file}.mkv   (direct file CDN, up to 70GB)
       ├─ p.111477.xyz/bulk?u={encoded_url}         (bulk download proxy)
       ├─ {subdomain}.workers.dev/{hash}::{hash}/... (Cloudflare Workers — 11+ subdomains)
       ├─ pixel.hubcloud.cx/...                     (HubCloud CDN — overlaps PenguPlay)
       ├─ hls-zyote.streamflix.one/...              (HLS streams)
       ├─ img1.{various}.com/...                    (direct image CDN — vidsuper, klcxm, etc.)
       └─ /tb/download?url=...&key=on&name=...      (TorBox cloud torrent proxy)
       │
       ▼
[ Stream response with direct URLs (NO signing!) ]
```

## Key Differences from PenguPlay

| Aspect | PenguPlay | HdHub |
|--------|-----------|-------|
| **Stream URL signing** | HMAC-SHA256 signed URLs | **Direct URLs (no signing)** |
| **Token format** | base64url JSON `{kind, landingUrl}` | N/A — URLs are direct |
| **CDN** | HubCloud → GDrive | Multiple: 111477, Workers, HubCloud, HLS |
| **behaviorHints** | `filename`, `proxyHeaders`, `bingeGroup` | **`videoSize`** (byte count) |
| **TMDB ID** | ❌ Not supported | ✅ `tmdb:27205` |
| **TorBox** | ❌ | ✅ `?torbox=on` (55 streams!) |
| **Quality filter** | Per-source checkbox | ✅ `?qualities=2160p,1080p` |
| **Sort order** | ❌ | ✅ `?sort=asc|desc` |
| **Stream format** | `🐧 PenguPlay ❄️ 4K • 4KHDHub · FSL` | `OD - 4K`, `HdHub 1080p`, `[Castle] 480p` |
| **Description** | Multi-line with emojis | `[💾 66.3 GB] filename\nDV, HEVC, REMUX` |

## Config Schema

```json
{
  "torbox": "on" | "offline" | "unset" | "{api_key}",
  "qualities": "2160p,1080p,720p,480p,360p",
  "sort": "desc" | "asc"
}
```

Encoded as base64url and placed in URL path: `/{config}/stream/movie/tt1375666.json`

## Sources Covered (Different from PenguPlay)

| Source | Pattern | CDN |
|--------|---------|-----|
| **OD** | `p.111477.xyz/bulk?u=a.111477.xyz/movies/...` | 111477 direct file server |
| **HdHub** | `*.workers.dev/{hash}::{hash}/{size}/{file}` | Cloudflare Workers |
| **4KHDHub** | `*.workers.dev/{hash}::{hash}/{size}/{file}` | Cloudflare Workers |
| **VS Sunny** | `img1.{various}.com/...` | Direct image CDN |
| **[Castle]** | `*.workers.dev/...` | Cloudflare Workers |
| **TorBox** | `hdhub.thevolecitor.qzz.io/tb/download?url=...` | TorBox cloud torrent |

## CDN Targets Discovered

```
a.111477.xyz               — direct file CDN (up to 70GB movies)
p.111477.xyz               — bulk download proxy
pixel.hubcloud.cx          — HubCloud CDN
gpdl.hubcloud.cx           — HubCloud download
hls-zyote.streamflix.one   — HLS streams
img1.bxncw.com             — VS Sunny CDN
img1.klcxm.com             — VS Sunny CDN
img1.kucwn.com             — VS Sunny CDN
img1.flocw.com             — VS Sunny CDN
img1.hvncw.com             — VS Sunny CDN
vidsuper.net               — direct
cdn.fsl-buckets.life       — FSL bucket
*.workers.dev (11+ subdomains):
  - dl.files.earthcdn.workers.dev
  - files.dolic45578.workers.dev
  - fragrant-hall-2ec0.wadija10455305.workers.dev
  - gentle-salad-362c.terapiyo253.workers.dev
  - indx.fileshubserver.workers.dev
  - old-art-db58.terapiyo252.workers.dev
  - royal-moon-5c75.boles507773229.workers.dev
  - steep-butterfly-741d.sifor796752386.workers.dev
  - hubloud-downloadcdn.vi-isp.workers.dev
  - nf-cdn.movies-server.workers.dev
  - odd-star-946a.veces411654274.workers.dev
  - bsnl-route.neetflixcdn.workers.dev
  - steep-butterfly-1810.jarog56524.workers.dev
  - spring-tree-7af2.genet319598570.workers.dev
  - small-dew-a3b5.becini95037599.workers.dev
  - patient-cloud-109a.gicosab429.workers.dev
  - lively-cherry-e664.xinasic6966974.workers.dev
```

## TorBox Integration

HdHub has TorBox cloud torrent integration. When `torbox=on`:
- HdHub queries HubCloud URLs that have cached torrents
- Wraps them in `/tb/download?url={hubcloud_url}&key=on&name={filename}`
- `key=on` → use HdHub's saved TorBox API key
- `key={api_key}` → user provides their own TorBox API key
- `key=offline` → don't use TorBox (skip these streams)

For HerumHai, we pass `key=on` through (HdHub handles auth). For users who want their own TorBox key, they can pass `?torbox={api_key}` to our endpoint.

## Stream Count Comparison

| Title | PenguPlay | HdHub | Combined |
|-------|-----------|-------|----------|
| Inception (tt1375666) | 21 | 50 | 71 |
| Inception + TorBox | 21 | 52 | 73 |
| Breaking Bad S1E1 | 15 | 28 | 43 |

## Implementation in HerumHai

All HdHub techniques ported to `api/streams2.js` (completely separate from `api/stream.js`):

- **Proxy architecture**: fetches `hdhub.thevolecitor.qzz.io/{config}/stream/{type}/{id}.json`
- **URL rewriting**: wraps each direct URL in our signed `/direct/hdhub/{token}/{filename}?psig=` proxy
- **Token format**: `{kind: 'direct', url, referer, filename}` (uses `kind: 'direct'` in `api/direct.js`)
- **Branding**: `HdHub` → `HerumHai`, `4KHDHub` → `HerumHai 4K`
- **Preserves** `videoSize` behaviorHint
- **Adds** `proxyHeaders` (User-Agent + Referer) for our `/direct/` proxy
- **Filters out** broken streams (`file not found`, `/login.php?action=logout`)
- **TorBox support**: `?torbox=on` / `?torbox=offline` / `?torbox={api_key}`
- **Quality filter**: `?qualities=2160p,1080p,720p`
- **Sort order**: `?sort=desc` / `?sort=asc`
- **TMDB support**: `/streams2/movie/tmdb:27205.json`

## Routes Added

```
GET /streams2/movie/tt1375666.json         → /api/streams2?type=movie&id=tt1375666
GET /streams2/movie/tmdb:27205.json        → /api/streams2?type=movie&id=tmdb:27205
GET /streams2/series/tt0903747:1:1.json    → /api/streams2?type=series&id=tt0903747:1:1
GET /streams2/anime/kitsu:1.json           → /api/streams2?type=anime&id=kitsu:1

# With config:
GET /streams2/movie/tt1375666.json?torbox=on&qualities=2160p,1080p&sort=desc
```

## No Conflicts with stream.js

- `api/stream.js` (PenguPlay proxy) is **completely unchanged**
- `api/streams2.js` (HdHub proxy) is a **new separate file**
- `vercel.json` adds new rewrites for `/streams2/*` (doesn't touch `/stream/*`)
- `api/direct.js` already supports `kind: 'direct'` tokens (used by streams2.js)
- Both endpoints can run independently in parallel
