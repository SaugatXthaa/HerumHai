// ============================================================================
// api/xpass.js — xpass.top HTTP-based Scraper (NO BROWSER NEEDED)
// ----------------------------------------------------------------------------
// This scraper fetches real HLS streams from play.xpass.top using only curl
// (Node's native fetch gets Cloudflare-challenged due to TLS fingerprint).
//
// Flow:
//   1. curl https://play.xpass.top/e/{movie|tv}/{imdbId}[/{season}/{episode}]
//      with mobile User-Agent (Cloudflare bypass) + 2embed.cc Referer
//   2. Parse the HTML to extract backup playlist URLs (/mdata/, /vip/, /meg/)
//   3. curl each playlist.json → extract HLS .m3u8 sources
//   4. Test each .m3u8 URL and return only the working ones
//   5. Wrap streams with proper proxyHeaders (Referer: play.xpass.top)
//
// Content support:
//   - Movies: /e/movie/{imdbId}
//   - TV Series: /e/tv/{imdbId}/{season}/{episode}
//   - Anime: /e/tv/{tmdbId}/{season}/{episode} (needs TMDB resolution)
//
// Returns multiple HLS streams per title (typically 3-8 working sources).
// ============================================================================

import { execFileSync } from 'node:child_process';

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const XPASS_BASE = 'https://play.xpass.top';
const EMBED_REFERER = 'https://www.2embed.cc/';
const TMDB_API_KEY = '6b2dec73b6697866a50cdaef60ccffcb';

// ---------------------------------------------------------------------------
// curl wrapper — Node's native fetch gets CF-challenged due to TLS fingerprint
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
    console.error(`[xpass] curl error for ${url.slice(0, 80)}: ${e.message}`);
    return '';
  }
}

function curlGetJson(url, { referer, timeout = 8 } = {}) {
  const body = curlGet(url, { referer, timeout });
  if (!body) return null;
  try { return JSON.parse(body); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Quick health check for an m3u8 URL (HEAD-like, 4s timeout)
// ---------------------------------------------------------------------------
function testM3u8(url) {
  try {
    const result = execFileSync('curl', [
      '-s', '-o', '/dev/null', '-w', '%{http_code}',
      '--max-time', '5',
      '-A', MOBILE_UA,
      '-H', 'Range: bytes=0-1023',
      url,
    ], { encoding: 'utf-8', timeout: 8000 });
    const code = result.trim();
    return code === '200' || code === '206' || code === '302' || code === '307';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Resolve IMDB → TMDB ID (for anime)
// ---------------------------------------------------------------------------
async function resolveTmdbId(imdbId, type) {
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

// ---------------------------------------------------------------------------
// Main scraper entry point
// ---------------------------------------------------------------------------
export async function scrapeXpass(target, title) {
  const { type, imdbId, kitsuId, season, episode } = target;

  // Build the embed URL
  let embedUrl;
  if (type === 'movie') {
    if (!imdbId) return [];
    embedUrl = `${XPASS_BASE}/e/movie/${imdbId}`;
  } else if (type === 'series') {
    if (!imdbId) return [];
    embedUrl = `${XPASS_BASE}/e/tv/${imdbId}/${season || 1}/${episode || 1}`;
  } else if (type === 'anime') {
    // Anime needs TMDB ID — resolve from IMDB or kitsu
    let tmdbId = null;
    if (imdbId) {
      tmdbId = await resolveTmdbId(imdbId, 'anime');
    }
    if (!tmdbId && kitsuId) {
      // Try kitsu → TMDB via title search
      try {
        const searchUrl = `https://api.themoviedb.org/3/search/tv?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(title || '')}`;
        const res = await fetch(searchUrl, { signal: AbortSignal.timeout(8000) });
        if (res.ok) {
          const data = await res.json();
          if (data.results?.[0]?.id) tmdbId = String(data.results[0].id);
        }
      } catch {}
    }
    if (!tmdbId) return [];
    embedUrl = `${XPASS_BASE}/e/tv/${tmdbId}/${season || 1}/${episode || 1}`;
  } else {
    return [];
  }

  console.log(`[xpass] fetching ${embedUrl}`);

  // Step 1: Fetch the embed page with curl (bypasses Cloudflare)
  const html = curlGet(embedUrl, { referer: EMBED_REFERER });
  if (!html || html.includes('Just a moment')) {
    console.log('[xpass] no HTML returned (Cloudflare challenge)');
    return [];
  }

  // Step 2: Extract all playlist URLs from the backups array
  // Pattern: "url":"/mdata/.../playlist.json" or "url":"/vip/.../playlist.json"
  const playlistPaths = new Set();
  const urlMatches = html.matchAll(/"url":"([^"]*playlist\.json)"/g);
  for (const m of urlMatches) {
    const path = m[1];
    if (path && !path.includes('/video/error')) {
      playlistPaths.add(path);
    }
  }

  if (playlistPaths.size === 0) {
    console.log('[xpass] no playlists found in page');
    return [];
  }

  console.log(`[xpass] found ${playlistPaths.size} playlists`);

  // Step 3: Fetch each playlist and collect m3u8 URLs
  const allSources = [];
  const playlists = Array.from(playlistPaths).slice(0, 15); // cap at 15

  for (const path of playlists) {
    const data = curlGetJson(path.startsWith('http') ? path : `${XPASS_BASE}${path}`, {
      referer: embedUrl,
      timeout: 6,
    });
    if (!data?.playlist?.[0]?.sources) continue;
    for (const s of data.playlist[0].sources) {
      if (s.file && !s.file.includes('/video/error')) {
        allSources.push({
          label: s.label || 'Unknown',
          file: s.file,
          id: s.id || '',
        });
      }
    }
  }

  console.log(`[xpass] collected ${allSources.length} m3u8 sources`);

  // Step 4: Test each m3u8 URL (with 5s timeout each)
  const workingSources = [];
  for (const src of allSources) {
    if (testM3u8(src.file)) {
      workingSources.push(src);
    }
  }
  console.log(`[xpass] ${workingSources.length} working sources (of ${allSources.length} total)`);

  // Step 5: Build Stremio stream objects
  // Dedupe by file URL
  const seen = new Set();
  const streams = [];
  for (const src of workingSources) {
    if (seen.has(src.file)) continue;
    seen.add(src.file);

    // Determine resolution from label
    let resolution = 'Auto';
    if (/4k|2160/i.test(src.label)) resolution = '2160p';
    else if (/1080|fhd/i.test(src.label)) resolution = '1080p';
    else if (/720|hd/i.test(src.label)) resolution = '720p';
    else if (/480|sd/i.test(src.label)) resolution = '480p';

    streams.push({
      name: `HerumHai · ${src.label}`,
      description: `Source: xpass.top | Quality: ${resolution}\n${title || ''}`,
      url: src.file,
      behaviorHints: {
        notWebReady: true,
        filename: `${title || 'stream'}.${resolution}.m3u8`,
        proxyHeaders: {
          request: {
            'User-Agent': MOBILE_UA,
            'Referer': XPASS_BASE + '/',
          },
        },
        bingeGroup: `herumhai-xpass-${src.id || src.label}`,
      },
    });
  }

  return streams;
}
