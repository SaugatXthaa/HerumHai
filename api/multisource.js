// ============================================================================
// api/multisource.js — Multi-Source HTTP Scraper (NO BROWSER NEEDED)
// ----------------------------------------------------------------------------
// Scrapes streams from multiple sources using only HTTP requests (curl).
// Works on Vercel serverless without puppeteer.
//
// Sources:
//   1. xpass.top (PRIMARY) — returns 4-8 HLS streams per title
//      - Movies: uses IMDb ID directly
//      - TV/Anime: resolves to TMDB ID first (xpass requires TMDB for TV)
//   2. 4khdhub.one — WordPress site with HubCloud embed links
//      - Returns 5-10+ HubCloud streams per title
//   3. vidsrc.to → vsembed.ru — embed provider (fallback)
//
// For sources that require JS rendering (HubCloud), we extract the HubCloud IDs
// from the WordPress detail pages and wrap them as direct proxy URLs that
// Stremio can play through our /api/direct endpoint.
// ============================================================================

import { execFileSync } from 'node:child_process';

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version=17.0 Mobile/15E148 Safari/604.1';
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const TMDB_API_KEY = '6b2dec73b6697866a50cdaef60ccffcb';

// ---------------------------------------------------------------------------
// curl wrapper — bypasses Cloudflare TLS fingerprint checks
// ---------------------------------------------------------------------------
function curl(url, { ua = MOBILE_UA, referer = '', timeout = 10, method = 'GET', body = null } = {}) {
  const args = [
    '-sSL', '--max-time', String(timeout), '--compressed',
    '-A', ua,
    '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    '-H', 'Accept-Language: en-US,en;q=0.9',
  ];
  if (referer) args.push('-H', `Referer: ${referer}`);
  if (method === 'POST' && body) {
    args.push('-X', 'POST', '-d', body);
  }
  args.push(url);
  try {
    return execFileSync('curl', args, {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: (timeout + 3) * 1000,
    }) || '';
  } catch {
    return '';
  }
}

function curlJson(url, opts = {}) {
  const body = curl(url, opts);
  if (!body) return null;
  try { return JSON.parse(body); } catch { return null; }
}

// Quick HTTP status check
function checkUrl(url, timeout = 5) {
  try {
    const result = execFileSync('curl', [
      '-s', '-o', '/dev/null', '-w', '%{http_code}',
      '--max-time', String(timeout),
      '-A', MOBILE_UA,
      '-L', url,
    ], { encoding: 'utf-8', timeout: (timeout + 3) * 1000 });
    return result.trim();
  } catch {
    return '000';
  }
}

// ---------------------------------------------------------------------------
// TMDB ID resolution — xpass.top requires TMDB IDs for TV/Anime
// ---------------------------------------------------------------------------
async function resolveTmdbId(imdbId, type, title) {
  if (!imdbId && !title) return null;

  // Method 1: IMDb → TMDB via /find endpoint
  if (imdbId) {
    try {
      const kind = type === 'movie' ? 'movie' : 'tv';
      const url = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const data = await res.json();
        const arr = data?.[`${kind}_results`] || [];
        if (arr[0]?.id) {
          console.log(`[tmdb] ${imdbId} → ${arr[0].id} (${arr[0].title || arr[0].name})`);
          return String(arr[0].id);
        }
      }
    } catch {}
  }

  // Method 2: Title → TMDB via search
  if (title) {
    try {
      const kind = type === 'movie' ? 'movie' : 'tv';
      const url = `https://api.themoviedb.org/3/search/${kind}?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(title)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const data = await res.json();
        if (data.results?.[0]?.id) {
          console.log(`[tmdb] "${title}" → ${data.results[0].id} (${data.results[0].title || data.results[0].name})`);
          return String(data.results[0].id);
        }
      }
    } catch {}
  }

  return null;
}

// ---------------------------------------------------------------------------
// Source 1: xpass.top (PRIMARY — works via HTTP, returns 4-8 HLS streams)
// ---------------------------------------------------------------------------
async function scrapeXpass(target, title) {
  const { type, imdbId, kitsuId, season, episode } = target;

  let embedUrl;
  if (type === 'movie' && imdbId) {
    // Movies use IMDb ID directly
    embedUrl = `https://play.xpass.top/e/movie/${imdbId}`;
  } else if (type === 'series' && imdbId) {
    // Series need TMDB ID — resolve IMDb → TMDB
    const tmdbId = await resolveTmdbId(imdbId, 'series', title);
    if (!tmdbId) {
      console.log(`[xpass] could not resolve TMDB ID for series ${imdbId}`);
      return [];
    }
    embedUrl = `https://play.xpass.top/e/tv/${tmdbId}/${season || 1}/${episode || 1}`;
  } else if (type === 'anime') {
    // Anime needs TMDB ID — resolve from kitsu/title
    let tmdbId = null;
    if (imdbId) {
      tmdbId = await resolveTmdbId(imdbId, 'anime', title);
    }
    if (!tmdbId && title) {
      tmdbId = await resolveTmdbId(null, 'anime', title);
    }
    if (!tmdbId && kitsuId) {
      // Get title from kitsu, then search TMDB
      try {
        const kitsuRes = await fetch(`https://kitsu.io/api/edge/anime/${kitsuId}`, { signal: AbortSignal.timeout(8000) });
        if (kitsuRes.ok) {
          const kitsuData = await kitsuRes.json();
          const kitsuTitle = kitsuData?.data?.attributes?.canonicalTitle;
          if (kitsuTitle) {
            console.log(`[kitsu] ${kitsuId} → "${kitsuTitle}"`);
            tmdbId = await resolveTmdbId(null, 'anime', kitsuTitle);
          }
        }
      } catch {}
    }
    if (!tmdbId) {
      console.log(`[xpass] could not resolve TMDB ID for anime ${kitsuId || imdbId}`);
      return [];
    }
    embedUrl = `https://play.xpass.top/e/tv/${tmdbId}/${season || 1}/${episode || 1}`;
  } else {
    return [];
  }

  console.log(`[xpass] fetching ${embedUrl}`);
  const html = curl(embedUrl, { referer: 'https://www.2embed.cc/' });
  if (!html || html.includes('Just a moment')) return [];

  // Check if xpass found the title (id=0 means not found)
  if (html.includes('"playlist":"/vxr/tv/0/') || html.includes('"playlist":"/vrk/tv/0/')) {
    console.log('[xpass] title not found (id=0)');
    return [];
  }

  // Extract all playlist URLs
  const playlistPaths = new Set();
  for (const m of html.matchAll(/"url":"([^"]*playlist\.json)"/g)) {
    if (m[1] && !m[1].includes('/video/error')) playlistPaths.add(m[1]);
  }
  if (playlistPaths.size === 0) return [];

  console.log(`[xpass] found ${playlistPaths.size} playlists`);

  // Fetch playlists and collect m3u8 URLs
  const allSources = [];
  for (const path of Array.from(playlistPaths).slice(0, 15)) {
    const url = path.startsWith('http') ? path : `https://play.xpass.top${path}`;
    const data = curlJson(url, { referer: embedUrl, timeout: 6 });
    if (!data?.playlist?.[0]?.sources) continue;
    for (const s of data.playlist[0].sources) {
      if (s.file && !s.file.includes('/video/error')) {
        allSources.push({ label: s.label || 'Unknown', file: s.file, id: s.id || '' });
      }
    }
  }

  console.log(`[xpass] collected ${allSources.length} sources, testing...`);

  // Test each m3u8 URL (parallel, 5s timeout each)
  const working = [];
  for (const src of allSources) {
    const code = checkUrl(src.file, 4);
    if (['200', '206', '302', '307'].includes(code)) {
      working.push(src);
    }
  }
  console.log(`[xpass] ${working.length} working sources`);

  // Build stream objects (dedupe by URL)
  const seen = new Set();
  const streams = [];
  for (const src of working) {
    if (seen.has(src.file)) continue;
    seen.add(src.file);
    streams.push({
      name: `HerumHai · ${src.label}`,
      description: `Source: xpass.top\n${title || ''}`,
      url: src.file,
      behaviorHints: {
        notWebReady: true,
        filename: `${title || 'stream'}.m3u8`,
        proxyHeaders: { request: { 'User-Agent': MOBILE_UA, 'Referer': 'https://play.xpass.top/' } },
        bingeGroup: `herumhai-xpass-${src.id || src.label}`,
      },
    });
  }
  return streams;
}

// ---------------------------------------------------------------------------
// Source 2: 4khdhub.one — WordPress site with HubCloud embed links
// NOTE: HubCloud drive URLs are JS-rendered and cannot be resolved without
// a browser. The HubCloud streams are SKIPPED because they would return HTML
// instead of video when played through our proxy.
// This source is disabled until we have a browser-based resolver.
// ---------------------------------------------------------------------------
async function scrape4khdhubOne(target, title) {
  // HubCloud URLs are JS-rendered — can't resolve to CDN URLs without a browser
  // Return empty array to avoid showing broken streams to users
  // The xpass.top HLS streams (from scrapeXpass) are the reliable playable sources
  console.log('[4khdhub.one] skipped — HubCloud URLs require browser to resolve');
  return [];
}

// ---------------------------------------------------------------------------
// Source 3: vidsrc.to → vsembed.ru (embed provider)
// ---------------------------------------------------------------------------
async function scrapeVidSrcTo(target, title) {
  const { type, imdbId, season, episode } = target;
  if (!imdbId) return [];

  const embedUrl = type === 'series'
    ? `https://vidsrc.to/embed/tv/${imdbId}/${season || 1}/${episode || 1}`
    : `https://vidsrc.to/embed/movie/${imdbId}`;

  console.log(`[vidsrc.to] fetching ${embedUrl}`);
  const html = curl(embedUrl, { ua: DESKTOP_UA, timeout: 8 });
  if (!html) return [];

  // Look for the inner embed URL (vsembed.ru or similar)
  const embedMatch = html.match(/src="(https?:\/\/[^"]*embed[^"]*)"/i);
  if (!embedMatch) return [];

  const innerUrl = embedMatch[1];
  console.log(`[vidsrc.to] inner embed: ${innerUrl.slice(0, 80)}`);

  // Fetch the inner embed page
  const innerHtml = curl(innerUrl, { ua: DESKTOP_UA, referer: embedUrl, timeout: 8 });
  if (!innerHtml) return [];

  // Look for m3u8 URLs
  const streams = [];
  const m3u8Matches = innerHtml.matchAll(/(https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*)/gi);
  const seen = new Set();
  for (const m of m3u8Matches) {
    const url = m[1];
    if (seen.has(url)) continue;
    seen.add(url);
    const code = checkUrl(url, 4);
    if (['200', '206', '302', '307'].includes(code)) {
      streams.push({
        name: `HerumHai · VidSrc`,
        description: `Source: vidsrc.to\n${title || ''}`,
        url,
        behaviorHints: {
          notWebReady: true,
          filename: `${title || 'stream'}.m3u8`,
          proxyHeaders: { request: { 'User-Agent': DESKTOP_UA, 'Referer': innerUrl } },
          bingeGroup: `herumhai-vidsrc-${Date.now().toString(36)}`,
        },
      });
    }
  }
  return streams;
}

// ---------------------------------------------------------------------------
// Main entry point — runs all scrapers in parallel and merges results
// ---------------------------------------------------------------------------
export async function scrapeAllSources(target, title) {
  console.log(`[multisource] starting scrape for ${target.type}/${target.imdbId || target.kitsuId} "${title}"`);

  const promises = [
    scrapeXpass(target, title).catch(e => { console.log(`[xpass] error: ${e.message}`); return []; }),
    scrape4khdhubOne(target, title).catch(e => { console.log(`[4khdhub.one] error: ${e.message}`); return []; }),
    scrapeVidSrcTo(target, title).catch(e => { console.log(`[vidsrc.to] error: ${e.message}`); return []; }),
  ];

  const results = await Promise.all(promises);
  const allStreams = results.flat();

  console.log(`[multisource] total: ${allStreams.length} streams`);
  return allStreams;
}
