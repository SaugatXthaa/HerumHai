// ============================================================================
// api/streams2.js — HerumHai Stream Resolver #2 (HdHub Proxy)
// ----------------------------------------------------------------------------
// SEPARATE from api/stream.js — does NOT touch the existing PenguPlay proxy.
//
// Reverse-engineered from: https://hdhub.thevolecitor.qzz.io/
// Addon ID: com.stremio.HdHub v1.0.6
// Stack: Express.js + Cloudflare
//
// HdHub's architecture (distinct from PenguPlay):
//   • Direct file CDN: a.111477.xyz/movies/{title}/{file}.mkv  (up to 70GB!)
//   • Bulk proxy:      p.111477.xyz/bulk?u={encoded_url}
//   • Cloudflare Workers: many subdomains (vahoweg883, dolic45578, etc.)
//   • HubCloud CDN:    pixel.hubcloud.cx (overlaps with PenguPlay)
//   • HLS streams:     hls-zyote.streamflix.one
//   • TorBox:          hdhub.thevolecitor.qzz.io/tb/download?url=...&key=on
//
// Sources covered (different from PenguPlay):
//   • OD (111477 direct file CDN)
//   • HdHub (HDHub4u)
//   • 4KHDHub
//   • VS Sunny (NEW — not in PenguPlay)
//   • [Castle] (NEW — not in PenguPlay)
//   • TorBox (cloud torrent service, with `key=on` mode)
//
// New features not in PenguPlay:
//   ✓ TMDB ID support (tmdb:27205)
//   ✓ TorBox integration (torbox=on|offline|{api_key})
//   ✓ Quality filter (qualities=2160p,1080p,720p)
//   ✓ Sort order (sort=asc|desc)
//   ✓ videoSize behaviorHint (byte count for size display)
//
// Routes (added to vercel.json):
//   GET /streams2/movie/tt1375666.json
//   GET /streams2/series/tt0944947:1:1.json
//   GET /streams2/movie/tmdb:27205.json
//   GET /streams2/anime/kitsu:1.json
// ============================================================================

import { createHmac, randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DIRECT_URL_SECRET =
  process.env.DIRECT_URL_SECRET ||
  'herumhai-dev-secret-' + randomBytes(16).toString('hex');

const HDHUB_UPSTREAM = 'https://hdhub.thevolecitor.qzz.io';
const HDHUB_TIMEOUT_MS = 20_000;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Honeypot filter (same as stream.js)
const HONEYPOT_REGEX = new RegExp(
  ['tutorial','how-to','howto','download-guide','guide','sample','trailer','demo',
   'placeholder','loading','spinner','promo','/ads/','advert','banner','logo',
   'favicon','beacon','pixel','sharethis','/analytics/',
   'file not found','file+not+found'].join('|'),
  'i'
);

// ---------------------------------------------------------------------------
// Base URL helper
// ----------------------------------------------------------------------------

function getBaseUrl(req) {
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  if (process.env.HERUMHAI_BASE_URL) return process.env.HERUMHAI_BASE_URL;
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['host'] || 'herum-hai.vercel.app';
  return `${protocol}://${host}`;
}

// ---------------------------------------------------------------------------
// HdHub Config Builder
// ----------------------------------------------------------------------------
// HdHub accepts a base64url-encoded JSON config in the URL path:
//   /{config}/stream/{type}/{id}.json
//
// Config schema (decoded):
//   {
//     "torbox": "on" | "offline" | "unset" | "{api_key}",
//     "qualities": "2160p,1080p,720p",  // comma-separated
//     "sort": "desc" | "asc"
//   }
// ----------------------------------------------------------------------------

function buildHdHubConfig(userConfig = {}) {
  const config = {
    torbox: userConfig.torbox || 'unset',
    qualities: userConfig.qualities || '2160p,1080p,720p,480p,360p',
    sort: userConfig.sort || 'desc',
  };

  // If user passed torbox=true, use 'on' (HdHub's "use saved key" mode)
  if (userConfig.torbox === true) config.torbox = 'on';
  else if (userConfig.torbox === false) config.torbox = 'offline';
  else if (typeof userConfig.torbox === 'string' && userConfig.torbox.length > 3) {
    config.torbox = userConfig.torbox;  // treat as API key
  }

  // If user passed qualities as array, join with commas
  if (Array.isArray(userConfig.qualities)) {
    config.qualities = userConfig.qualities.join(',');
  }

  return config;
}

function encodeConfig(config) {
  return Buffer.from(JSON.stringify(config)).toString('base64url');
}

// ---------------------------------------------------------------------------
// Signed URL helpers (same architecture as stream.js)
// ----------------------------------------------------------------------------

function encodeOurToken(tokenData) {
  return Buffer.from(JSON.stringify(tokenData)).toString('base64url');
}

function signOurPsig(token, filename) {
  const ts = Math.floor(Date.now() / 1000);
  const payload = `${ts}.${token}.${filename}`;
  const sig = createHmac('sha256', DIRECT_URL_SECRET).update(payload).digest('base64url');
  return `${ts}.${sig}`;
}

/**
 * Build a signed /direct/ URL for an HdHub stream.
 * Uses kind='direct' token so api/direct.js will pipe the bytes through
 * with our Referer + User-Agent headers.
 */
function buildSignedDirectUrl(sourceSlug, directUrl, referer, filename, ourBaseUrl) {
  const tokenData = {
    kind: 'direct',
    url: directUrl,
    referer: referer || HDHUB_UPSTREAM,
    cookie: '',
    filename: filename || '',
  };
  const token = encodeOurToken(tokenData);
  const safeFilename = encodeURIComponent(filename || `${sourceSlug}-stream.mkv`);
  const psig = signOurPsig(token, filename || `${sourceSlug}-stream.mkv`);
  return `${ourBaseUrl}/direct/${sourceSlug}/${token}/${safeFilename}?psig=${encodeURIComponent(psig)}`;
}

// ---------------------------------------------------------------------------
// Stream URL Rewriter
// ----------------------------------------------------------------------------
// HdHub returns stream URLs in several formats:
//   1. https://p.111477.xyz/bulk?u={encoded_url}     (111477 bulk proxy)
//   2. https://a.111477.xyz/movies/{title}/{file}.mkv (direct file CDN)
//   3. https://{subdomain}.workers.dev/{hash}::{hash}/{size}/{file}  (CF Workers)
//   4. https://pixel.hubcloud.cx/...                  (HubCloud CDN)
//   5. https://hls-zyote.streamflix.one/...           (HLS stream)
//   6. http://hdhub.thevolecitor.qzz.io/tb/download?...  (TorBox proxy)
//   7. /login.php?action=logout (broken — filter out)
//
// We rewrite all of them to our /direct/ proxy with HMAC signing.
// TorBox URLs get upgraded from http → https.
// ----------------------------------------------------------------------------

function rewriteHdHubStreamUrl(originalUrl, sourceSlug, ourBaseUrl) {
  if (!originalUrl || typeof originalUrl !== 'string') return null;

  // Filter broken URLs
  if (originalUrl === '/login.php?action=logout') return null;
  if (originalUrl.startsWith('/') && !originalUrl.startsWith('//')) return null;

  // Upgrade http → https for TorBox URLs (HdHub uses http for these)
  let url = originalUrl;
  if (url.startsWith('http://hdhub.thevolecitor.qzz.io/')) {
    url = url.replace('http://', 'https://');
  }

  // Build referer based on URL host
  let referer = HDHUB_UPSTREAM + '/';
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes('111477')) {
      referer = 'https://a.111477.xyz/';
    } else if (parsed.hostname.includes('hubcloud')) {
      referer = 'https://hubcloud.cx/';
    } else if (parsed.hostname.includes('workers.dev')) {
      referer = HDHUB_UPSTREAM + '/';
    } else if (parsed.hostname.includes('hdhub.thevolecitor')) {
      referer = HDHUB_UPSTREAM + '/';
    }
  } catch {}

  // Extract filename from URL if possible
  let filename = '';
  try {
    const parsed = new URL(url);
    const pathSegments = parsed.pathname.split('/').filter(Boolean);
    if (pathSegments.length > 0) {
      filename = decodeURIComponent(pathSegments[pathSegments.length - 1]);
    }
  } catch {}

  return buildSignedDirectUrl(sourceSlug, url, referer, filename, ourBaseUrl);
}

// ---------------------------------------------------------------------------
// Stream Rewriter (full stream object)
// ----------------------------------------------------------------------------

function rewriteHdHubStream(stream, ourBaseUrl) {
  if (!stream) return null;

  const originalUrl = stream.url;
  const sourceSlug = 'hdhub';  // all HdHub streams use this slug

  // Skip streams without URLs (donation banners, errors)
  if (!originalUrl) return null;

  // Skip broken/error streams
  const desc = (stream.description || '').toLowerCase();
  if (desc.includes('file not found')) return null;
  if (originalUrl === '/login.php?action=logout') return null;

  // CRITICAL FIX: Return HdHub's original URL directly — do NOT wrap in /direct/ proxy.
  // Vercel serverless functions can't stream video (returns 302 SSO redirect).
  // Stremio's player handles proxyHeaders natively — it sends the correct
  // Referer/User-Agent when fetching the stream.
  // This is exactly how HdHub's own addon works — direct URLs, no proxy.

  // Replace branding: "HdHub" → "HerumHai", "4KHDHub" → "HerumHai 4K"
  // Remove 🐧 emoji — keep names clean
  let newName = (stream.name || '')
    .replace(/4KHDHub/gi, 'HerumHai 4K')
    .replace(/HdHub/gi, 'HerumHai')
    .replace(/OD/g, 'OD')
    .replace(/🐧\s*/g, '')
    .trim();

  // Add "HerumHai ·" prefix if not already branded
  if (!newName.startsWith('HerumHai') && !newName.startsWith('⬇️')) {
    newName = `HerumHai · ${newName}`;
  } else if (newName.startsWith('⬇️[TorBox]')) {
    newName = newName.replace('⬇️[TorBox]', 'HerumHai · ⬇️[TorBox]');
  }

  // Determine the correct Referer based on the URL host
  let referer = 'https://hdhub.thevolecitor.qzz.io/';
  try {
    const parsed = new URL(originalUrl);
    if (parsed.hostname.includes('111477')) referer = 'https://a.111477.xyz/';
    else if (parsed.hostname.includes('hubcloud')) referer = 'https://hubcloud.cx/';
    else if (parsed.hostname.includes('workers.dev')) referer = 'https://hdhub.thevolecitor.qzz.io/';
  } catch {}

  return {
    ...stream,
    name: newName,
    description: stream.description || '',
    url: originalUrl,  // pass through original URL — no proxy
    behaviorHints: {
      ...(stream.behaviorHints || {}),
      notWebReady: true,
      // Preserve videoSize if present (HdHub's size hint)
      ...(stream.behaviorHints?.videoSize ? { videoSize: stream.behaviorHints.videoSize } : {}),
      // proxyHeaders — Stremio's player sends these when fetching the stream
      proxyHeaders: {
        request: {
          'User-Agent': USER_AGENT,
          'Referer': referer,
        },
      },
      bingeGroup: `herumhai-hdhub-${Date.now().toString(36)}`,
    },
  };
}

// ---------------------------------------------------------------------------
// Stremio ID Parser (supports tt, tmdb:, kitsu:)
// ----------------------------------------------------------------------------

function parseStremioId(type, rawId) {
  const clean = (rawId || '').replace(/\.json$/i, '').trim();
  const result = {
    type: type || 'movie',
    imdbId: null,
    tmdbId: null,
    kitsuId: null,
    season: null,
    episode: null,
    rawId: clean,  // preserve raw for HdHub
  };

  if (type === 'anime' || clean.startsWith('kitsu:')) {
    result.type = 'anime';
    const parts = clean.split(':');
    if (parts[0] === 'kitsu') {
      result.kitsuId = parts[1] || null;
      result.episode = parts[2] ? parseInt(parts[2], 10) || 1 : 1;
    } else {
      result.kitsuId = parts[0] || null;
      result.episode = parts[1] ? parseInt(parts[1], 10) || 1 : 1;
    }
    return result;
  }

  if (clean.startsWith('tmdb:')) {
    result.tmdbId = clean;  // preserve full tmdb:ID format
    // For series, format is tmdb:ID:season:episode
    const parts = clean.split(':');
    if (parts.length >= 4) {
      result.season = parseInt(parts[2], 10) || null;
      result.episode = parseInt(parts[3], 10) || null;
    }
    return result;
  }

  if (type === 'series') {
    const parts = clean.split(':');
    result.imdbId = parts[0] || null;
    result.season = parts[1] ? parseInt(parts[1], 10) || null : null;
    result.episode = parts[2] ? parseInt(parts[2], 10) || null : null;
    return result;
  }

  result.imdbId = clean;
  return result;
}

// ---------------------------------------------------------------------------
// HdHub Upstream Fetcher
// ----------------------------------------------------------------------------

async function fetchHdHubStreams(target, userConfig) {
  const config = buildHdHubConfig(userConfig);
  const configB64 = encodeConfig(config);

  // Build HdHub URL — supports tt, tmdb:, kitsu:
  // Format: /{config}/stream/{type}/{id}.json
  let hdhubId;
  if (target.type === 'series') {
    if (target.tmdbId) {
      // tmdb:ID:season:episode
      const parts = target.tmdbId.split(':');
      hdhubId = `tmdb:${parts[1]}:${target.season}:${target.episode}`;
    } else {
      hdhubId = `${target.imdbId}:${target.season}:${target.episode}`;
    }
  } else if (target.type === 'anime') {
    if (target.kitsuId) {
      hdhubId = `kitsu:${target.kitsuId}:${target.episode || 1}`;
    } else {
      return [];
    }
  } else {
    // movie
    hdhubId = target.tmdbId || target.imdbId;
  }

  const hdhubUrl = `${HDHUB_UPSTREAM}/${configB64}/stream/${target.type}/${hdhubId}.json`;
  console.log(`[hdhub] fetching: ${HDHUB_UPSTREAM}/${configB64.slice(0, 40)}.../stream/${target.type}/${hdhubId}.json`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HDHUB_TIMEOUT_MS);

  try {
    const res = await fetch(hdhubUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: controller.signal,
      redirect: 'follow',
    });

    if (!res.ok) {
      console.error(`[hdhub] HTTP ${res.status}`);
      return [];
    }

    const data = await res.json();
    return data.streams || [];
  } catch (e) {
    console.error(`[hdhub] fetch failed: ${e.message}`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Main Resolver
// ----------------------------------------------------------------------------

async function resolveStreams2(target, userConfig, baseUrl) {
  const startTime = Date.now();

  console.log(`[streams2] resolving ${target.type} ${target.rawId} with config: ${JSON.stringify(buildHdHubConfig(userConfig))}`);

  // Fetch streams from HdHub
  const hdhubStreams = await fetchHdHubStreams(target, userConfig);
  console.log(`[hdhub] returned ${hdhubStreams.length} streams in ${Date.now() - startTime}ms`);

  // Rewrite each stream: URL → our /direct/ proxy, branding → HerumHai
  const rewrittenStreams = hdhubStreams
    .map((s) => rewriteHdHubStream(s, baseUrl))
    .filter(Boolean);  // remove nulls (broken streams filtered out)

  // Dedupe by URL
  const seen = new Set();
  const unique = [];
  for (const s of rewrittenStreams) {
    if (s.url && !seen.has(s.url)) {
      seen.add(s.url);
      unique.push(s);
    }
  }

  console.log(`[streams2] total unique streams: ${unique.length} (in ${Date.now() - startTime}ms)`);
  return unique;
}

// ---------------------------------------------------------------------------
// Vercel Serverless Function Entry
// ----------------------------------------------------------------------------

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(204).end();

  const baseUrl = getBaseUrl(req);
  const { type, id } = req.query;
  let parsedType = type;
  let parsedId = id;

  // Parse from path: /api/streams2/{type}/{id} or /streams2/{type}/{id}
  if (!parsedType || !parsedId) {
    const parts = (req.url || '').split('?')[0].split('/').filter(Boolean);
    const streams2Idx = parts.findIndex((p) => p === 'streams2');
    if (streams2Idx !== -1 && parts.length >= streams2Idx + 3) {
      parsedType = parts[streams2Idx + 1];
      parsedId = parts[streams2Idx + 2];
    }
  }

  if (!parsedType || !parsedId) {
    return res.status(400).json({
      error: 'Missing type or id',
      usage: '/streams2/movie/tt1375666.json or /api/streams2?type=movie&id=tt1375666',
    });
  }

  // Parse HdHub-specific config from query string
  //   ?torbox=on              → enable TorBox (use saved key)
  //   ?torbox=offline         → disable TorBox
  //   ?torbox={api_key}       → use this TorBox API key
  //   ?qualities=2160p,1080p  → filter by quality
  //   ?sort=desc              → sort order (desc=largest first, asc=smallest first)
  const userConfig = {};
  if (req.query.torbox) {
    const v = req.query.torbox;
    if (v === 'true' || v === 'on') userConfig.torbox = true;
    else if (v === 'false' || v === 'offline') userConfig.torbox = false;
    else userConfig.torbox = v;  // treat as API key
  }
  if (req.query.qualities) {
    userConfig.qualities = req.query.qualities;
  }
  if (req.query.sort) {
    userConfig.sort = req.query.sort;
  }

  const target = parseStremioId(parsedType, parsedId);
  console.log(`\n[/api/streams2] ${parsedType}/${parsedId} →`, JSON.stringify(target));

  try {
    const streams = await resolveStreams2(target, userConfig, baseUrl);
    return res.status(200).json({ streams });
  } catch (e) {
    console.error(`[/api/streams2] fatal: ${e.message}`);
    return res.status(200).json({ streams: [] });
  }
}

// ---------------------------------------------------------------------------
// Exports — used by api/stream.js to merge HdHub streams into the main response
// ----------------------------------------------------------------------------

export {
  fetchHdHubStreams,
  rewriteHdHubStream,
  buildHdHubConfig,
  encodeConfig as encodeHdHubConfig,
  parseStremioId as parseStremioIdHdHub,
};

