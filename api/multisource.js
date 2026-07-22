// ============================================================================
// api/multisource.js — Multi-Source HTTP Scraper (NO BROWSER NEEDED)
// ----------------------------------------------------------------------------
// Scrapes streams from multiple sources using only HTTP requests (curl).
// Works on Vercel serverless without puppeteer.
//
// Sources:
//   1. xpass.top (PRIMARY) — returns 4-8 HLS streams per title
//   2. 4khdhub.one — WordPress site with HubCloud embed links
//   3. vidsrc.to → vsembed.ru — embed provider (fallback)
//   4. Direct embed providers (2embed.cc, vidsrc.win, etc.)
//
// For sources that require JS rendering (HubCloud), we extract the HubCloud IDs
// from the WordPress detail pages and wrap them as direct proxy URLs that
// Stremio can play through our /api/direct endpoint.
// ============================================================================

import { execFileSync } from 'node:child_process';

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
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
// Source 1: xpass.top (PRIMARY — works via HTTP, returns 4-8 HLS streams)
// ---------------------------------------------------------------------------
async function scrapeXpass(target, title) {
  const { type, imdbId, kitsuId, season, episode } = target;

  let embedUrl;
  if (type === 'movie' && imdbId) {
    embedUrl = `https://play.xpass.top/e/movie/${imdbId}`;
  } else if (type === 'series' && imdbId) {
    embedUrl = `https://play.xpass.top/e/tv/${imdbId}/${season || 1}/${episode || 1}`;
  } else if (type === 'anime') {
    let tmdbId = null;
    if (imdbId) {
      try {
        const url = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`;
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (res.ok) {
          const data = await res.json();
          if (data?.tv_results?.[0]?.id) tmdbId = String(data.tv_results[0].id);
        }
      } catch {}
    }
    if (!tmdbId && kitsuId && title) {
      try {
        const url = `https://api.themoviedb.org/3/search/tv?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(title)}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (res.ok) {
          const data = await res.json();
          if (data.results?.[0]?.id) tmdbId = String(data.results[0].id);
        }
      } catch {}
    }
    if (!tmdbId) return [];
    embedUrl = `https://play.xpass.top/e/tv/${tmdbId}/${season || 1}/${episode || 1}`;
  } else {
    return [];
  }

  console.log(`[xpass] fetching ${embedUrl}`);
  const html = curl(embedUrl, { referer: 'https://www.2embed.cc/' });
  if (!html || html.includes('Just a moment')) return [];

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
// ---------------------------------------------------------------------------
async function scrape4khdhubOne(target, title) {
  const { type, imdbId, season, episode } = target;
  if (!title) return [];

  // Search for the title
  const searchUrl = `https://4khdhub.one/?s=${encodeURIComponent(title)}`;
  console.log(`[4khdhub.one] searching: ${searchUrl}`);
  const searchHtml = curl(searchUrl, { ua: DESKTOP_UA, timeout: 8 });
  if (!searchHtml) return [];

  // Find detail page links (both absolute and relative)
  // Only include links that look like movie/show detail pages (slug-based)
  const detailLinks = new Set();
  const skipExtensions = ['.png', '.svg', '.ico', '.jpg', '.jpeg', '.gif', '.webp', '.css', '.js', '.json', '.xml', '.webmanifest'];
  const skipPrefixes = ['/images/', '/css/', '/js/', '/category/', '/tag/', '/page/', '/wp-', '/author/', '/feed', '/comments', '/about', '/contact', '/dmca', '/privacy'];

  for (const m of searchHtml.matchAll(/href="(https?:\/\/4khdhub\.one\/[^"]+)"/g)) {
    const link = m[1];
    if (skipExtensions.some(ext => link.endsWith(ext))) continue;
    if (skipPrefixes.some(p => link.includes(p))) continue;
    if (link.includes('/?s=') || link === 'https://4khdhub.one/') continue;
    detailLinks.add(link);
  }
  // Also check for relative links like /inception-movie-509/
  for (const m of searchHtml.matchAll(/href="(\/[^"]+)"/g)) {
    const link = m[1];
    if (skipExtensions.some(ext => link.endsWith(ext))) continue;
    if (skipPrefixes.some(p => link.startsWith(p))) continue;
    if (link === '/' || link.startsWith('/?')) continue;
    // Must look like a detail slug (contains hyphens and/or numbers)
    if (!/\/[a-z0-9-]+\/?$/i.test(link)) continue;
    detailLinks.add(`https://4khdhub.one${link}`);
  }

  if (detailLinks.size === 0) {
    console.log('[4khdhub.one] no detail links found');
    return [];
  }

  console.log(`[4khdhub.one] found ${detailLinks.size} detail links`);

  // Fetch each detail page and extract HubCloud IDs
  const hubcloudIds = new Set();
  for (const link of Array.from(detailLinks).slice(0, 3)) {
    const detailHtml = curl(link, { ua: DESKTOP_UA, referer: 'https://4khdhub.one/', timeout: 8 });
    if (!detailHtml) continue;

    // Extract HubCloud drive IDs
    for (const m of detailHtml.matchAll(/hubcloud\.(?:ist|cx|club|fans)\/drive\/([a-zA-Z0-9_-]+)/gi)) {
      hubcloudIds.add(m[1]);
    }
  }

  if (hubcloudIds.size === 0) {
    console.log('[4khdhub.one] no HubCloud IDs found');
    return [];
  }

  console.log(`[4khdhub.one] found ${hubcloudIds.size} HubCloud IDs`);

  // Build stream objects — each HubCloud ID becomes a stream that plays
  // through our /api/direct proxy (which resolves HubCloud server-side)
  const streams = [];
  let idx = 0;
  for (const hcId of Array.from(hubcloudIds).slice(0, 5)) {
    idx++;
    streams.push({
      name: `HerumHai · 4KHDHub #${idx}`,
      description: `Source: 4khdhub.one | HubCloud: ${hcId}\n${title || ''}`,
      // Route through our /api/direct proxy with the HubCloud URL
      url: `https://hubcloud.cx/drive/${hcId}`,
      behaviorHints: {
        notWebReady: true,
        filename: `${title || 'stream'}-${idx}.mkv`,
        proxyHeaders: {
          request: {
            'User-Agent': DESKTOP_UA,
            'Referer': 'https://4khdhub.one/',
          },
        },
        bingeGroup: `herumhai-4khdhub-${hcId}`,
      },
    });
  }
  return streams;
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
