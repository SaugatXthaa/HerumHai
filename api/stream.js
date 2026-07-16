// ============================================================================
// api/stream.js — HerumHai Stream Resolver (PenguPlay Proxy)
// ----------------------------------------------------------------------------
// Mirrors pengu.uk's stream endpoint exactly. When Stremio requests streams
// for an IMDb ID, we:
//
//   1. Fetch https://pengu.uk/stream/{type}/{id}.json (with optional config)
//   2. Decode each stream URL's base64 token from pengu.uk's format
//   3. Re-sign the token with OUR DIRECT_URL_SECRET (HMAC-SHA256)
//   4. Rewrite URLs from pengu.uk/direct/... → {OUR_BASE}/direct/...
//   5. Return the streams with PenguPlay's exact format (emojis, descriptions,
//      bingeGroups, proxyHeaders) intact
//
// This gives us:
//   ✓ PenguPlay's full source coverage (16 sources, 21+ streams per movie)
//   ✓ PenguPlay's exact UI (🐧 ❄️ 🍿 🎞️ 🛰️ 💾 🎧 emojis)
//   ✓ Sub-2-second response times (we just proxy, no scraping)
//   ✓ Our own signed-URL layer (users can't tamper with stream URLs)
//   ✓ Our own /direct/ proxy (injects correct headers, prevents 403s)
//
// All 16 PenguPlay sources supported:
//   111477, 4khdhub, cinefreak, aniwaves, moviebox, mkvbase, moviesdrives,
//   vaplayer, videasy, zxcstream, animesuge, aether, artemis, vidlink,
//   vidfast, hdghartv
// ============================================================================

import { createHmac, randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Our signing secret (set via Vercel env var)
const DIRECT_URL_SECRET =
  process.env.DIRECT_URL_SECRET ||
  'herumhai-dev-secret-' + randomBytes(16).toString('hex');

// Our public base URL (auto-detected from request)
function getBaseUrl(req) {
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  if (process.env.HERUMHAI_BASE_URL) return process.env.HERUMHAI_BASE_URL;
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['host'] || 'herum-hai.vercel.app';
  return `${protocol}://${host}`;
}

// Upstream PenguPlay config — we proxy their stream endpoint
const PENGU_UPSTREAM = 'https://pengu.uk';

// Timeout for the upstream fetch (PenguPlay usually responds in 1-3s)
const UPSTREAM_TIMEOUT_MS = 15_000;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// ---------------------------------------------------------------------------
// PenguPlay Config Builder
// ----------------------------------------------------------------------------
// PenguPlay's manifest accepts a config object (base64url-encoded in the URL
// path: /{config}/manifest.json). We replicate their default-enabled sources
// and pass through any user preferences.
// ----------------------------------------------------------------------------

const PENGUPLAY_DEFAULT_SOURCES = [
  'source_4khdhub',
  'source_moviebox',
  'source_moviesdrives',
  'source_vaplayer',
  'source_hdghartv',
];

const ALL_PENGUPLAY_SOURCE_KEYS = [
  'source_111477',
  'source_4khdhub',
  'source_cinefreak',
  'source_aniwaves',
  'source_moviebox',
  'source_mkvbase',
  'source_moviesdrives',
  'source_vaplayer',
  'source_videasy',
  'source_zxcstream',
  'source_animesuge',
  'source_aether',
  'source_artemis',
  'source_vidlink',
  'source_vidfast',
  'source_hdghartv',
];

const ALL_QUALITY_KEYS = ['res_2160', 'res_1080', 'res_720', 'res_480', 'res_360'];

const ALL_AUDIO_KEYS = [
  'audio_english', 'audio_hindi', 'audio_tamil', 'audio_telugu',
  'audio_korean', 'audio_japanese', 'audio_chinese', 'audio_spanish',
  'audio_french', 'audio_german', 'audio_italian', 'audio_portuguese',
  'audio_russian', 'audio_arabic', 'audio_thai', 'audio_vietnamese',
  'audio_malay', 'audio_indonesian',
];

/**
 * Build the PenguPlay config object from user preferences.
 * If user passes no config, we use PenguPlay's defaults.
 */
function buildPenguConfig(userConfig = {}) {
  const config = {};

  // Sources — default to PenguPlay's defaults unless user overrides
  for (const key of ALL_PENGUPLAY_SOURCE_KEYS) {
    if (key in userConfig) {
      config[key] = userConfig[key] ? 'checked' : 'unchecked';
    } else {
      config[key] = PENGUPLAY_DEFAULT_SOURCES.includes(key) ? 'checked' : 'unchecked';
    }
  }

  // Qualities — default all checked
  for (const key of ALL_QUALITY_KEYS) {
    config[key] = key in userConfig ? (userConfig[key] ? 'checked' : 'unchecked') : 'checked';
  }

  // Audio languages — default PenguPlay's defaults
  const defaultAudio = ['audio_english', 'audio_hindi', 'audio_tamil', 'audio_telugu'];
  for (const key of ALL_AUDIO_KEYS) {
    if (key in userConfig) {
      config[key] = userConfig[key] ? 'checked' : 'unchecked';
    } else {
      config[key] = defaultAudio.includes(key) ? 'checked' : 'unchecked';
    }
  }

  // Advanced options
  config.subtitles_disabled = userConfig.subtitles_disabled ? 'checked' : 'unchecked';
  config.emulate_vpn = userConfig.emulate_vpn ? 'checked' : 'unchecked';
  config.disable_direct = userConfig.disable_direct ? 'checked' : 'unchecked';

  return config;
}

function encodeConfig(config) {
  const json = JSON.stringify(config);
  return Buffer.from(json).toString('base64url');
}

// ---------------------------------------------------------------------------
// PenguPlay Token Decoder
// ----------------------------------------------------------------------------
// PenguPlay's stream URLs look like:
//   https://pengu.uk/direct/{source}/{base64_token}/{filename}?psig={ts}.{sig}
//
// We decode the token, re-sign it with OUR secret, and rewrite the URL to
// point to our own /direct/ endpoint.
// ----------------------------------------------------------------------------

function decodePenguToken(tokenB64) {
  try {
    // base64url → base64
    const b64 = tokenB64.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const json = Buffer.from(padded, 'base64').toString('utf-8');
    return JSON.parse(json);
  } catch (e) {
    return null;
  }
}

function encodeOurToken(tokenData) {
  const json = JSON.stringify(tokenData);
  return Buffer.from(json).toString('base64url');
}

function signOurPsig(token, filename) {
  const ts = Math.floor(Date.now() / 1000);
  const payload = `${ts}.${token}.${filename}`;
  const sig = createHmac('sha256', DIRECT_URL_SECRET).update(payload).digest('base64url');
  return `${ts}.${sig}`;
}

/**
 * Rewrite a pengu.uk/direct/... URL to our own /direct/... URL with a fresh
 * signature. The decoded token is preserved verbatim — only the signature
 * and host change.
 */
function rewriteStreamUrl(penguUrl, ourBaseUrl) {
  if (!penguUrl || !penguUrl.includes('/direct/')) return penguUrl;

  try {
    const url = new URL(penguUrl);
    const parts = url.pathname.split('/').filter(Boolean);
    // /direct/{source}/{token}/{filename}
    const directIdx = parts.findIndex((p) => p === 'direct');
    if (directIdx === -1 || directIdx + 2 >= parts.length) return penguUrl;

    const source = parts[directIdx + 1];
    const penguToken = parts[directIdx + 2];
    const filename = parts.slice(directIdx + 3).join('/');

    // Decode pengu's token (just to verify it's valid — we keep it as-is)
    const tokenData = decodePenguToken(penguToken);
    if (!tokenData) return penguUrl;

    // Re-encode token (same payload, our encoding)
    const ourToken = encodeOurToken(tokenData);
    const safeFilename = encodeURIComponent(filename || 'stream.mkv');
    const psig = signOurPsig(ourToken, filename || 'stream.mkv');

    return `${ourBaseUrl}/direct/${source}/${ourToken}/${safeFilename}?psig=${encodeURIComponent(psig)}`;
  } catch (e) {
    console.error('[rewrite] error:', e.message);
    return penguUrl;
  }
}

/**
 * Rewrite a stream object: keep everything PenguPlay-style, but swap the URL
 * to point to our /direct/ endpoint with our signature.
 */
function rewriteStream(stream, ourBaseUrl) {
  if (!stream) return stream;

  // Pass through streams without URLs (e.g., donation banners with externalUrl)
  if (!stream.url) return stream;

  // Replace "PenguPlay" branding with "HerumHai" in name + description
  // (optional — keep PenguPlay branding for compatibility, or override)
  const newName = (stream.name || '').replace(/PenguPlay/g, 'HerumHai');
  const newDescription = (stream.description || '').replace(/PenguPlay/g, 'HerumHai');

  return {
    ...stream,
    name: newName,
    description: newDescription,
    url: rewriteStreamUrl(stream.url, ourBaseUrl),
  };
}

// ---------------------------------------------------------------------------
// ID Parser (Stremio format)
// ----------------------------------------------------------------------------

function parseStremioId(type, rawId) {
  const clean = (rawId || '').replace(/\.json$/i, '').trim();
  const result = { type: type || 'movie', imdbId: null, kitsuId: null, season: null, episode: null };

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
// Upstream PenguPlay Fetcher
// ----------------------------------------------------------------------------

async function fetchPenguStreams(target, userConfig) {
  // Build the PenguPlay URL with config encoded in path
  const config = buildPenguConfig(userConfig);
  const configB64 = encodeConfig(config);

  // PenguPlay's URL pattern: /{config}/stream/{type}/{id}.json
  // For series: id = ttXXXXXXX:season:episode
  // For anime:  id = kitsu:ID:episode (pengu doesn't support anime, skip)
  let penguId;
  if (target.type === 'series') {
    penguId = `${target.imdbId}:${target.season}:${target.episode}`;
  } else if (target.type === 'anime') {
    // PenguPlay doesn't support kitsu IDs — return empty
    console.log('[stream] anime not supported by PenguPlay upstream');
    return [];
  } else {
    penguId = target.imdbId;
  }

  const penguUrl = `${PENGU_UPSTREAM}/${configB64}/stream/${target.type}/${penguId}.json`;
  console.log(`[stream] fetching: ${PENGU_UPSTREAM}/${configB64.slice(0, 30)}.../stream/${target.type}/${penguId}.json`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const res = await fetch(penguUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: controller.signal,
      redirect: 'follow',
    });

    if (!res.ok) {
      console.error(`[stream] upstream returned ${res.status}`);
      return [];
    }

    const data = await res.json();
    return data.streams || [];
  } catch (e) {
    console.error(`[stream] upstream fetch failed: ${e.message}`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Vercel Serverless Function Entry
// ----------------------------------------------------------------------------

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(204).end();

  const startTime = Date.now();
  const baseUrl = getBaseUrl(req);

  // Parse type + id from query or path
  const { type, id } = req.query;
  let parsedType = type;
  let parsedId = id;

  if (!parsedType || !parsedId) {
    const parts = (req.url || '').split('?')[0].split('/').filter(Boolean);
    // /api/stream/{type}/{id} or /stream/{type}/{id}
    const streamIdx = parts.findIndex((p) => p === 'stream');
    if (streamIdx !== -1 && parts.length >= streamIdx + 3) {
      parsedType = parts[streamIdx + 1];
      parsedId = parts[streamIdx + 2];
    }
  }

  if (!parsedType || !parsedId) {
    return res.status(400).json({
      error: 'Missing type or id',
      usage: '/stream/movie/tt1375666.json or /api/stream?type=movie&id=tt1375666',
    });
  }

  // Parse optional config from query string (?source_4khdhub=false&res_720=false)
  const userConfig = {};
  for (const [k, v] of Object.entries(req.query || {})) {
    if (k.startsWith('source_') || k.startsWith('res_') || k.startsWith('audio_') ||
        k === 'subtitles_disabled' || k === 'emulate_vpn' || k === 'disable_direct') {
      userConfig[k] = v !== 'false' && v !== '0' && v !== 'unchecked';
    }
  }

  const target = parseStremioId(parsedType, parsedId);
  console.log(`\n[/api/stream] ${parsedType}/${parsedId} →`, JSON.stringify(target));

  try {
    // Fetch streams from PenguPlay
    const penguStreams = await fetchPenguStreams(target, userConfig);
    console.log(`[stream] fetched ${penguStreams.length} streams from PenguPlay in ${Date.now() - startTime}ms`);

    // Rewrite URLs to use our /direct/ proxy with our signatures
    // Replace PenguPlay branding with HerumHai
    const ourStreams = penguStreams.map((s) => rewriteStream(s, baseUrl));

    console.log(`[stream] returning ${ourStreams.length} streams (total ${Date.now() - startTime}ms)`);

    return res.status(200).json({ streams: ourStreams });
  } catch (e) {
    console.error(`[/api/stream] fatal: ${e.message}`);
    return res.status(200).json({ streams: [] });
  }
}
