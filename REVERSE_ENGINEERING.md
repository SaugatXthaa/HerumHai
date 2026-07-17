# PenguPlay Reverse-Engineering Report

Complete technical breakdown of pengu.uk's streaming addon architecture, with all techniques ported into HerumHai.

## Target

- **URL**: `https://pengu.uk/`
- **Manifest**: `https://pengu.uk/manifest.json`
- **Addon ID**: `com.penguplay` v1.3.4
- **Stack**: Node.js + Express + Caddy reverse proxy
- **Frontend**: React (loaded from `esm.sh`) single-page app, inline module script

## Sources (17 total)

| Slug | Name | Type | Tags |
|------|------|------|------|
| `111477` | 111477 | movie/series | Very Fast, 4K, 1080p, Huge Library |
| `4khdhub` | 4KHDHub | movie/series | 4K, Mainstream, Classics, Series, Anime, Indie |
| `cinefreak` | CineFreak | movie/series | 4K, 1080p, 720p, Regional, Classics, Indie |
| `aniwaves` | Aniwaves | anime | Anime, Fast |
| `moviebox` | MovieBox | movie/series | Fast, 1080p, Regional, Classics, Anime, Indie |
| `mkvbase` | MKVBase | movie/series | Fast, 4K, 1080p, Regional, Mainstream, Series |
| `moviesdrives` | MoviesDrives | movie/series | 4K, 1080p, Mainstream, Indie |
| `vaplayer` | VAPlayer | movie/series | Very Fast, 1080p, Regional, Classics, Anime, Indie, Series |
| `videasy` | Videasy | movie/series | Fast, 4K, 1080p, Regional, Classics, Anime, Indie, Series |
| `zxcstream` | ZXCStream | movie/series | Fast, 4K, 1080p, Multi-Audio, Subtitles |
| `animesuge` | AnimeSuge | anime | Anime, Fast |
| `aether` | Aether | movie/series | 4K, 1080p, 720p, Regional, Mainstream, Anime |
| `artemis` | Artemis | movie/series | HLS, 4K, 1080p, Mainstream, Series |
| `vidlink` | VidLink | movie/series | 1080p, Classics, Mainstream, Classic TV |
| `vidfast` | VidFast | movie/series | HLS, 4K, 1080p, Mainstream, Series |
| `hdghartv` | HDGharTV | movie/series | Fast, 1080p, 720p, 480p, Regional, Mainstream, Series |

## Architecture Overview

```
[ Stremio Client ]
       │
       ▼
[ pengu.uk/manifest.json ]                ← Addon registration
       │
       ▼
[ pengu.uk/stream/movie/tt1375666.json ]  ← Stream resolver
       │
       │   1. For each enabled source, scraper visits the indexer site
       │   2. Walks search → detail page → finds HubCloud / GDrive embed
       │   3. Resolves HubCloud landing URL → gamerxyt.com proxy → GDrive direct
       │   4. Wraps resolved URL in /direct/{source}/{token}/{filename}?psig=
       │
       ▼
[ pengu.uk/direct/{source}/{token}/{filename}?psig={signature} ]
       │
       │   1. Verifies HMAC signature (rejects tampered URLs with 403)
       │   2. Decodes base64 token → JSON {kind, landingUrl}
       │   3. Resolves landing URL → direct GDrive stream
       │   4. Pipes bytes through with Referer/UA/Cookie headers
       │
       ▼
[ Stremio Player ] ← Receives bytes with proxyHeaders applied
```

## Token Format

All stream URLs use a base64url-encoded JSON token:

```
/direct/{source}/{base64url_token}/{filename}?psig={timestamp}.{hmac_signature}
```

**Token decoded:**
```json
{
  "kind": "hubcloud",
  "landingUrl": "https://hubcloud.ist/drive/cdce53ddaelbqjj"
}
```

Other token kinds:
- `{"kind":"gdrive","landingUrl":"https://docs.google.com/..."}`  — direct GDrive
- `{"kind":"direct","url":"https://...","referer":"...","cookie":"..."}`  — generic

## Signature Scheme (psig)

```
psig = {unix_timestamp}.{base64url(HMAC-SHA256(secret, "{ts}.{token}.{filename}"))}
```

- Secret stored server-side (env var)
- Signatures expire after **12 hours**
- Verified before proxy fetches upstream — prevents URL tampering

## HubCloud Resolution Flow (the core technique)

### Step 1 — Domain rotation

HubCloud rotates across 4 TLDs to dodge Cloudflare blocks:

| Domain | Status |
|--------|--------|
| `hubcloud.cx` | Active (primary) |
| `hubcloud.ist` | Active (alias) |
| `hubcloud.club` | Active (mirror) |
| `hubcloud.fans` | Active (mirror) |

### Step 2 — Landing page fetch

```
GET https://hubcloud.cx/drive/cdce53ddaelbqjj
Referer: https://hubcloud.cx/
```

The page contains an embedded gamerxyt.com proxy URL:
```
https://gamerxyt.com/hubcloud.php?host=hubcloud&id=cdce53ddaelbqjj&token=aG54NkliRXBXQjBWUjB0THBqMjZYa0w5R2RNN1k0SUxUbVBlTlRWRzRzVT0=
```

### Step 3 — gamerxyt.com proxy

```
GET https://gamerxyt.com/hubcloud.php?host=hubcloud&id=cdce53ddaelbqjj&token={base64}
Referer: https://hubcloud.cx/drive/cdce53ddaelbqjj
```

Returns a **302 redirect** to:
```
https://video-downloads.googleusercontent.com/ADGPM2n_Uw-FhEzsZQiNiKcIVX7I6uVijsQnlBU42NcFSpJWjocLU81LCYY7a2sAYyMC...
```

This is a Google Drive direct stream URL (signed, short-lived).

### Step 4 — Wrap in /direct/ proxy

Pengu wraps the GDrive URL in their own proxy to:
1. Hide the underlying URL from the user
2. Inject correct `Referer` / `User-Agent` / `Cookie` headers
3. Prevent Stremio's player from getting 403 from GDrive

## Anti-Bot Techniques Observed

1. **Cloudflare Turnstile** — pengu.uk's scraper waits ~6 seconds for CF to self-verify
2. **Browser fingerprint spoofing** — `navigator.webdriver = undefined`, `window.chrome = {runtime: {}}`
3. **Referer chain** — every fetch includes the previous page as Referer (anti-hotlink bypass)
4. **Short-lived signatures** — `psig` expires after 12h (prevents URL sharing)
5. **Domain rotation** — HubCloud cycles through 4 TLDs to avoid CF bans
6. **Proxy chaining** — HubCloud → gamerxyt → GDrive (3 hops hide the origin)

## Response Headers

```
HTTP/2 200
access-control-allow-origin: *
access-control-allow-methods: GET,HEAD,POST,OPTIONS
access-control-allow-headers: *
access-control-max-age: 86400
cache-control: no-store
via: 1.1 Caddy
x-powered-by: Express
```

## Sample Stream Response

```json
{
  "streams": [
    {
      "url": "https://pengu.uk/direct/4khdhub/eyJraW5kIjoiaHViY2xvdWQiLCJsYW5kaW5nVXJsIjoiaHR0cHM6Ly9odWJjbG91ZC5pc3QvZHJpdmUvY2RjZTUzZGRhZWxicWpqIn0/Inception-2010-2160p-UHD-BluRay-REMUX-DV-HDR-10bit-HEVC-Hindi-DDP-5.1-English-DTS-HD-MA-5.1-x265-FraMeSToR-4KHDHub-.mkv?psig=1784248562.Dz5Guz3RXM8-_0wxnfuKiY4T_TYKm-1MdE1pI0fvp5k%3A6n_HRc6Ka5fJvl2Nlwxrfaxh7n9SSzOfsjjlpHo1AoM",
      "behaviorHints": {
        "notWebReady": true,
        "filename": "Inception (2010) 2160p UHD BluRay REMUX DV HDR 10bit HEVC [Hindi DDP 5.1 + English DTS-HD MA 5.1] x265 (FraMeSToR-4KHDHub).mkv",
        "proxyHeaders": {
          "request": {}
        },
        "bingeGroup": "penguplay-4khdhub-fsl-4k-1"
      },
      "name": "🐧 PenguPlay ❄️ 4K • 4KHDHub · FSL",
      "description": "🎬 Inception (2010)\n🎥 4K • BluRay • HDR • DV • HEVC • x265 • MKV • ~63.8 Mbps\n⚡ Source: 4KHDHub · FSL\n💾 65.95 GB\n🔊 Audio: Hindi, English"
    }
  ]
}
```

## Implementation in HerumHai

All techniques ported to:

- **`api/stream.js`** — Stream resolver with 17 indexers + HubCloud resolution + signed URL generation
- **`api/direct.js`** — Signed-URL proxy with HMAC verification + Range header forwarding + streaming pipe
- **`vercel.json`** — Rewrites for `/direct/:source/:token/:filename` → `/api/direct.js` (maxDuration=300s for streaming)
- **`REVERSE_ENGINEERING.md`** — This document

### Configuration

Set this env var in Vercel:
```
DIRECT_URL_SECRET=<random-32-char-string>
```

Generate one with:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## API Keys / Endpoints Found

| Endpoint | Purpose |
|----------|---------|
| `https://pengu.uk/manifest.json` | Stremio manifest |
| `https://pengu.uk/stream/{type}/{id}.json` | Stream resolver |
| `https://pengu.uk/direct/{source}/{token}/{filename}` | Signed stream proxy |
| `https://pengu.uk/api/donation` | Donation progress tracker (public) |
| `https://hubcloud.cx/drive/{id}` | HubCloud landing page |
| `https://gamerxyt.com/hubcloud.php?host=hubcloud&id={id}&token={base64}` | HubCloud→GDrive resolver |
| `https://v3-cinemeta.strem.io/meta/{type}/{imdbId}.json` | Cinemeta title resolver |

No private API keys were exposed — pengu.uk's scraper logic is entirely server-side. The "API keys" are:
1. The `psig` HMAC secret (server-side env var)
2. The `token` base64 payload (per-stream, derived from HubCloud IDs)
3. The `gamerxyt.com` token (per-request, derived from HubCloud page scraping)

## Sources to Extend

To add more sources beyond the 17 PenguPlay uses, follow the same pattern:

1. Add the source to `INDEXERS` in `api/stream.js`
2. Implement a custom `scrapeIndexer_X()` function if it doesn't use HubCloud
3. Test with a known IMDb ID
4. Add to `manifest.js` config options if you want users to toggle it

## License & Attribution

This reverse-engineering was performed for educational purposes to understand how a public Stremio addon works. No source code was copied — the HerumHai implementation is original code that uses similar techniques. PenguPlay is licensed by its respective owners; please support them at https://pengu.uk/donate.
