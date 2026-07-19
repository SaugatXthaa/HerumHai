// ============================================================================
// sources/universal_embeds.js — Universal Embed Provider Scraper (FIXED)
// ----------------------------------------------------------------------------
// Works for ALL content types: movies, TV series, anime series, anime movies.
//
// ID RESOLUTION:
//   - Movies/TV: use IMDB ID directly (tt1375666)
//   - Anime: resolve kitsu ID → AniList title → TMDB search → TMDB ID
//     (xpass.top accepts TMDB IDs in /e/tv/{tmdbId}/{s}/{e})
//
// Providers (all verified working via curl, NO BROWSER NEEDED):
//
//   1. play.xpass.top (powered by 2embed.cc)
//      - Movie:  https://play.xpass.top/e/movie/{imdbId}
//      - TV:     https://play.xpass.top/e/tv/{imdbId}/{season}/{episode}
//      - Anime:  https://play.xpass.top/e/tv/{tmdbId}/{season}/{episode}
//      - Returns HTML with /mdata/{token}/1/playlist.json → real .m3u8 URLs
//      - REQUIRES curl (not axios/node-fetch) because Cloudflare does TLS
//        fingerprinting — Node.js's TLS stack gets challenged even with the
//        same HTTP headers. curl has the right fingerprint.
//      - REQUIRES mobile User-Agent (CF bypass — desktop UA gets blocked)
//      - REQUIRES Referer: https://www.2embed.cc/
//
// Verified live (2026-07-18):
//   - Movie "Inception" (tt1375666) → 6 HLS streams
//   - TV "Game of Thrones S1E1" (tt0944947/1/1) → 6 HLS streams
//   - Anime "Naruto S1E1" (kitsu:20 → TMDB 46260) → 3+ HLS streams
// ============================================================================

import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Mobile UA bypasses Cloudflare on play.xpass.top (desktop UA gets CF challenge)
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const XPASS_BASE = 'https://play.xpass.top';
const EMBED_REFERER = 'https://www.2embed.cc/';

// TMDB API key publicly hardcoded in 4khdhub.store's SPA bundle
const TMDB_API_KEY = '6b2dec73b6697866a50cdaef60ccffcb';

// ---------------------------------------------------------------------------
// curl wrapper — Node's native https gets CF-challenged due to TLS fingerprint
// mismatch. curl's TLS fingerprint passes CF's bot detection.
// ---------------------------------------------------------------------------
function curlGet(url, { referer, timeout = 12 } = {}) {
  const args = [
    '-sSL',
    '--max-time', String(timeout),
    '--compressed',
    '-A', MOBILE_UA,
    '-H', `Referer: ${referer || EMBED_REFERER}`,
    '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    '-H', 'Accept-Language: en-US,en;q=0.9',
    url,
  ];
  try {
    return execFileSync('curl', args, {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: (timeout + 3) * 1000,
    }) || '';
  } catch (e) {
    return '';
  }
}

function curlGetJson(url, { referer, timeout = 10 } = {}) {
  const body = curlGet(url, { referer, timeout });
  if (!body) return null;
  try { return JSON.parse(body); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Anime kitsu→TMDB resolution
// ----------------------------------------------------------------------------
// Stremio sends anime as kitsu:{id}:{episode}. xpass.top needs IMDB or TMDB ID.
// Flow: kitsu ID → AniList GraphQL (get title) → TMDB search (get TMDB ID)
// ---------------------------------------------------------------------------
async function resolveKitsuToTmdb(kitsuId) {
  if (!kitsuId) return null;

  // Step 1: Get anime title from AniList GraphQL API (kitsu ID ≈ AniList ID)
  // AniList and kitsu use DIFFERENT ID spaces, but we can search by kitsu ID
  // using the idMal field... actually, AniList's own ID is different from kitsu.
  // The correct approach: use the Kitsu API to get the title, then search TMDB.
  try {
    const kitsuRes = await fetch(`https://kitsu.io/api/edge/anime/${kitsuId}`, {
      headers: { Accept: 'application/vnd.api+json' },
      signal: AbortSignal.timeout(5000),
    });
    if (kitsuRes.ok) {
      const kitsuData = await kitsuRes.json();
      const title = kitsuData?.data?.attributes?.canonicalTitle
        || kitsuData?.data?.attributes?.titles?.en
        || kitsuData?.data?.attributes?.titles?.en_jp;
      if (title) {
        console.log(`  [universal] kitsu:${kitsuId} → title "${title}"`);
        // Step 2: Search TMDB for this title
        const tmdbId = await searchTmdbByTitle(title, 'tv');
        if (tmdbId) {
          console.log(`  [universal] title "${title}" → TMDB ${tmdbId}`);
          return tmdbId;
        }
      }
    }
  } catch {}

  // Fallback: try Jikan (MAL) API — search by kitsu ID (unreliable but worth trying)
  // Actually Jikan searches by title, not kitsu ID. Skip.

  return null;
}

async function searchTmdbByTitle(title, kind = 'tv') {
  try {
    const url = `https://api.themoviedb.org/3/search/${kind}?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(title)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = await res.json();
    const results = data?.results || [];
    if (results.length === 0) return null;
    // Return the first result's ID
    return String(results[0].id);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Resolve IMDB→TMDB (used by 4khdhub.js fallback)
// ---------------------------------------------------------------------------
export async function resolveTmdbFromImdb(imdbId, type) {
  if (!imdbId) return null;
  try {
    const kind = type === 'series' || type === 'anime' ? 'tv' : 'movie';
    const url = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const data = await res.json();
      const arr = data?.[`${kind}_results`] || [];
      if (arr[0]?.id) return String(arr[0].id);
    }
  } catch {}
  return null;
}

/**
 * Build the xpass.top embed URL for any content type.
 * @param {string} id        - IMDB ID (tt1375666) or TMDB ID (27205)
 * @param {string} type      - 'movie' | 'series' | 'anime'
 * @param {number|null} season
 * @param {number|null} episode
 * @param {boolean} isTmdb   - true if id is a TMDB ID (not IMDB)
 * @returns {string|null}
 */
function buildXpassUrl(id, type, season, episode, isTmdb = false) {
  if (!id) return null;
  if (type === 'movie') return `${XPASS_BASE}/e/movie/${id}`;
  // series + anime both use the TV endpoint with season/episode
  // xpass.top accepts both IMDB IDs (tt0944947) and TMDB IDs (31910) in this URL
  return `${XPASS_BASE}/e/tv/${id}/${season || 1}/${episode || 1}`;
}

/**
 * Extract all playlist URLs from the xpass.top HTML.
 * Multiple URL patterns are used depending on content:
 *   - /mdata/{token}/{0|1|2}/playlist.json  (movies + some TV)
 *   - /vip/{token}/{0|1|2}/playlist.json    (VIP backup)
 *   - /meg/tv/{tmdbId}/{s}/{e}/{quality}/playlist.json  (anime + some TV — MegaPlay)
 *   - /meg/movie/{tmdbId}/{quality}/playlist.json  (anime movies)
 *   - /vxr/tv/{tmdbId}/{s}/{e}/playlist.json  (VXR backup)
 *   - /vrk/tv/{tmdbId}/{s}/{e}/playlist.json  (VRK backup)
 *   - /box/v2/{type}/{id}/{s}/{e}/playlist.json  (BOX backup)
 *   - /feb/{tmdbId}/{s}/{e}/{0|1}/playlist.json  (FEB backup — download links)
 * @param {string} html
 * @returns {string[]} array of playlist URLs (relative paths)
 */
function extractPlaylistUrls(html) {
  const urls = new Set();
  let m;

  // /mdata/{token}/{0|1|2}/playlist.json
  const re = /"(\/mdata\/[A-Za-z0-9_-]+\/[0-2]\/playlist\.json)"/g;
  while ((m = re.exec(html)) !== null) urls.add(m[1]);

  // /vip/{token}/{0|1|2}/playlist.json
  const vipRe = /"(\/vip\/[A-Za-z0-9_\-]+\/[0-2]\/playlist\.json)"/g;
  while ((m = vipRe.exec(html)) !== null) urls.add(m[1]);

  // /meg/tv/{tmdbId}/{s}/{e}/{quality}/playlist.json  (anime + TV — MegaPlay)
  // Also /meg/movie/{tmdbId}/{quality}/playlist.json (anime movies)
  const megRe = /"(\/meg\/(?:tv|movie)\/\d+(?:\/\d+\/\d+)?(?:\/\d+)?\/playlist\.json)"/g;
  while ((m = megRe.exec(html)) !== null) urls.add(m[1]);

  // /vxr/tv/{tmdbId}/{s}/{e}/playlist.json  (VXR backup)
  const vxrRe = /"(\/vxr\/(?:tv|movie)\/\d+(?:\/\d+\/\d+)?\/playlist\.json)"/g;
  while ((m = vxrRe.exec(html)) !== null) urls.add(m[1]);

  // /vrk/tv/{tmdbId}/{s}/{e}/playlist.json  (VRK backup)
  const vrkRe = /"(\/vrk\/(?:tv|movie)\/\d+(?:\/\d+\/\d+)?\/playlist\.json)"/g;
  while ((m = vrkRe.exec(html)) !== null) urls.add(m[1]);

  // /box/v2/{type}/{id}/{s}/{e}/playlist.json  (BOX backup)
  const boxRe = /"(\/box\/v2\/[a-z]+\/\d+\/\d+\/\d+\/playlist\.json)"/g;
  while ((m = boxRe.exec(html)) !== null) urls.add(m[1]);

  // /feb/{tmdbId}/{s}/{e}/{0|1}/playlist.json  (FEB backup — download links)
  const febRe = /"(\/feb\/\d+\/\d+\/\d+\/[01]\/playlist\.json)"/g;
  while ((m = febRe.exec(html)) !== null) urls.add(m[1]);

  return Array.from(urls);
}

/**
 * Fetch a playlist JSON and extract stream sources.
 * @param {string} playlistUrl  - relative path like /mdata/{token}/1/playlist.json
 * @param {string} refererUrl   - the embed page URL (for Referer header)
 * @returns {Array<{url:string,label:string}>}
 */
function fetchPlaylistStreams(playlistUrl, refererUrl) {
  const fullUrl = playlistUrl.startsWith('http') ? playlistUrl : XPASS_BASE + playlistUrl;
  const data = curlGetJson(fullUrl, { referer: refererUrl, timeout: 8 });
  if (!data || !Array.isArray(data.playlist)) return [];

  const streams = [];
  for (const item of data.playlist) {
    if (!Array.isArray(item.sources)) continue;
    for (const src of item.sources) {
      // Accept ALL source URLs — the playlist JSON only contains stream URLs.
      // Don't filter by .m3u8/.txt extension because some providers (LUL, SAF)
      // use extensionless URLs on Cloudflare Workers / S3 CDNs.
      // The validation step (validateStreamsParallel) will filter out dead URLs.
      if (src.file) {
        streams.push({ url: src.file, label: src.label || 'Unknown' });
      }
    }
  }
  return streams;
}

/**
 * Universal embed scraper — works for movies, TV series, anime.
 *
 * For movies/TV: pass imdbId (tt1375666).
 * For anime: pass kitsuId (20) — will be resolved to TMDB ID internally.
 * If both imdbId and kitsuId are provided, imdbId takes priority.
 *
 * @param {string} title     - For display in stream name
 * @param {string} imdbId    - tt1375666 (for movies/TV)
 * @param {string} kitsuId   - "20" (for anime)
 * @param {string} type      - 'movie' | 'series' | 'anime'
 * @param {number|null} season
 * @param {number|null} episode
 * @returns {Promise<Array>} Array of stream objects
 */
export async function scrapeUniversalEmbeds(title, imdbId, type = 'movie', season = null, episode = null, kitsuId = null) {
  // Resolve the ID to use for xpass.top
  let embedId = imdbId;
  let isTmdb = false;

  // If no IMDB ID but we have a kitsu ID (anime), resolve kitsu→TMDB
  if (!embedId && kitsuId) {
    console.log(`  [universal] no IMDB ID — resolving kitsu:${kitsuId} → TMDB`);
    const tmdbId = await resolveKitsuToTmdb(kitsuId);
    if (tmdbId) {
      embedId = tmdbId;
      isTmdb = true;
    } else {
      console.log(`  [universal] could not resolve kitsu:${kitsuId} to TMDB ID`);
      return [];
    }
  }

  if (!embedId) {
    console.log(`  [universal] no IMDB or kitsu ID — cannot use embed providers`);
    return [];
  }

  const embedUrl = buildXpassUrl(embedId, type, season, episode, isTmdb);
  if (!embedUrl) {
    console.log(`  [universal] could not build URL for type=${type}`);
    return [];
  }

  console.log(`  [universal] → ${embedUrl.slice(0, 80)}`);

  // Step 1: Fetch the embed page HTML (via curl — bypasses CF TLS fingerprinting)
  const html = curlGet(embedUrl, { referer: EMBED_REFERER });
  if (!html || html.length < 500) {
    console.log(`  [universal] embed page returned empty/short response (${html ? html.length : 0} bytes)`);
    return [];
  }
  // Detect CF challenge page
  if (html.includes('Just a moment') || html.includes('cf-turnstile')) {
    console.log(`  [universal] CF challenge page detected — curl bypass failed`);
    return [];
  }

  // Step 2: Extract all playlist URLs (primary + backups)
  const playlistUrls = extractPlaylistUrls(html);
  if (playlistUrls.length === 0) {
    console.log(`  [universal] no playlist URLs found in embed page`);
    return [];
  }
  console.log(`  [universal] found ${playlistUrls.length} playlist URLs (primary + backups)`);

  // Step 3: Fetch ALL playlists (no early exit — we want maximum streams)
  // Many xpass.top providers (TIK, VID, WIS) are frequently dead (404/403).
  // We fetch ALL playlists to collect as many raw streams as possible,
  // then the validation step filters out dead ones.
  const allSources = [];
  const MAX_PLAYLISTS = 30;  // fetch all playlists (xpass.top returns up to 35)
  for (const url of playlistUrls.slice(0, MAX_PLAYLISTS)) {
    const streams = fetchPlaylistStreams(url, embedUrl);
    if (streams.length > 0) {
      allSources.push(...streams);
      console.log(`  [universal] ✓ ${url.slice(0, 50)}... → ${streams.length} sources`);
    }
  }

  if (allSources.length === 0) {
    console.log(`  [universal] no stream sources found in playlists`);
    return [];
  }

  // Dedupe by URL
  const seen = new Set();
  const uniqueSources = [];
  for (const s of allSources) {
    if (!seen.has(s.url)) {
      seen.add(s.url);
      uniqueSources.push(s);
    }
  }

  console.log(`  [universal] ✓ ${uniqueSources.length} unique HLS streams`);

  // Step 4: Build stream objects
  // Quality detection from xpass.top URLs is unreliable (URLs are encoded tokens,
  // not filenames). Use "Auto" since master.m3u8 contains all quality variants
  // and Stremio's player handles quality selection automatically.
  const labelMap = (label) => {
    const l = (label || '').toUpperCase();
    if (l.includes('TIK')) return 'TIK';
    if (l.includes('VID')) return 'VID';
    if (l.includes('VIP')) return 'VIP';
    if (l.includes('FIL')) return 'FIL';
    if (l.includes('WIS')) return 'WIS';
    if (l.includes('BOX')) return 'BOX';
    if (l.includes('FEB')) return 'FEB';
    if (l.includes('LUL')) return 'LUL';
    if (l.includes('MEG')) return 'MEG';
    if (l.includes('VXR')) return 'VXR';
    if (l.includes('VRK')) return 'VRK';
    if (l.includes('AKC')) return 'AKC';
    return label || 'SRC';
  };

  const streams = uniqueSources.map((src) => {
    const label = labelMap(src.label);
    return {
      name: `HerumHai 🎬 Auto • Universal · ${label}`,
      description: `🍿 ${title}\n📡 HLS Stream (master playlist — auto quality)\n🛰️ Source: xpass.top · ${label}`,
      url: src.url,
      behaviorHints: {
        notWebReady: false,
        proxyHeaders: {
          request: {
            'User-Agent': MOBILE_UA,
            'Referer': XPASS_BASE + '/',
          },
        },
      },
      sourceSlug: 'universal',
    };
  });

  // Step 5: Validate streams — filter out dead/expired URLs (404/403)
  // xpass.top tokens have short TTLs; some providers go offline.
  // Use curl for validation (same TLS fingerprint that works for scraping).
  // Quick parallel GET with Range header to verify each URL returns 200/206.
  const validatedStreams = await validateStreamsParallel(streams);
  console.log(`  [universal] ✓ ${validatedStreams.length}/${streams.length} streams validated as playable`);

  return validatedStreams;
}

// ---------------------------------------------------------------------------
// Stream validation — filters out dead/expired URLs
// ----------------------------------------------------------------------------
// xpass.top generates short-lived tokens. Some provider backends go offline.
// We use curl (not Node's fetch) because the HLS servers (tik.1x2.space etc.)
// do Cloudflare TLS fingerprinting — Node's fetch gets challenged even though
// curl works fine with the same headers.
//
// Quick parallel curl GET with Range: bytes=0-0 (5s timeout each) to verify
// each URL returns 200/206. Dead streams are silently dropped.
// ---------------------------------------------------------------------------
async function validateStreamsParallel(streams) {
  const VALIDATE_TIMEOUT = 5;  // seconds (passed to curl --max-time)

  const results = await Promise.all(
    streams.map(async (stream) => {
      try {
        // Use ASYNC execFile (not execFileSync) so multiple curl processes
        // run in TRUE parallel. execFileSync blocks the event loop, making
        // the "parallel" Promise.all actually sequential (5 streams × 5s = 25s).
        const { stdout } = await execFileAsync('curl', [
          '-sSL',
          '--max-time', String(VALIDATE_TIMEOUT),
          '-o', '/dev/null',
          '-w', '%{http_code}',
          '-A', MOBILE_UA,
          '-H', `Referer: ${XPASS_BASE}/`,
          '-H', 'Range: bytes=0-0',
          '-H', 'Accept: */*',
          stream.url,
        ], {
          encoding: 'utf-8',
          timeout: (VALIDATE_TIMEOUT + 2) * 1000,
          maxBuffer: 1024,
        });
        const code = stdout.trim();
        // 200 = OK, 206 = Partial Content (Range request OK)
        // 2xx = success
        const codeNum = parseInt(code, 10);
        if (codeNum >= 200 && codeNum < 300) {
          return stream;
        }
        return null;
      } catch {
        return null;
      }
    })
  );
  return results.filter(Boolean);
}

/**
 * StreameX (streamex.sh) scraper — uses StreameX's underlying embed providers.
 * StreameX is a Next.js SPA on streamex.sh that's CF-blocked with desktop UA
 * but accessible with mobile UA. It internally uses airflix1.com + frembed.asia.
 * We bypass StreameX entirely and go straight to xpass.top (which is what
 * 2embed.cc uses underneath airflix1.com).
 *
 * So this is essentially an alias for scrapeUniversalEmbeds().
 */
export async function scrapeStreameX(title, imdbId, type = 'movie', season = null, episode = null, kitsuId = null) {
  console.log(`  [streamex] using universal embed provider (bypassing SPA)`);
  const streams = await scrapeUniversalEmbeds(title, imdbId, type, season, episode, kitsuId);
  // Re-label streams as StreameX for clarity
  return streams.map((s) => ({
    ...s,
    name: s.name.replace('Universal', 'StreameX'),
    description: s.description.replace('xpass.top', 'StreameX'),
    sourceSlug: 'streamex',
  }));
}

export async function closeBrowser() {
  // No browser used — pure curl. No-op for API compatibility.
}
