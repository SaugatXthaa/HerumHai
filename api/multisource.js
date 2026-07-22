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
function curl(url, { ua = MOBILE_UA, referer = '', timeout = 8, method = 'GET', body = null } = {}) {
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
// Use async execFile for non-blocking URL checks (critical for Promise.all)
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);

async function checkUrl(url, timeout = 5) {
  try {
    const { stdout } = await execFileAsync('curl', [
      '-s', '-o', '/dev/null', '-w', '%{http_code}|%{content_type}',
      '--max-time', String(timeout),
      '-A', MOBILE_UA,
      '-L', '-r', '0-0',  // Range request to get just 1 byte
      url,
    ], { timeout: (timeout + 3) * 1000 });
    const [code, contentType] = stdout.trim().split('|');
    // Reject HTML responses (not video)
    if (contentType && contentType.includes('text/html')) return '000';
    return code;
  } catch {
    return '000';
  }
}

// ---------------------------------------------------------------------------
// TMDB ID resolution — xpass.top requires TMDB IDs for TV/Anime
// Uses curl (not fetch) for reliability on Vercel serverless
// ---------------------------------------------------------------------------
function resolveTmdbId(imdbId, type, title) {
  const kind = type === 'movie' ? 'movie' : 'tv';

  // Method 1: IMDb → TMDB via /find endpoint
  if (imdbId) {
    const url = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`;
    const data = curlJson(url, { timeout: 6 });
    if (data) {
      const arr = data?.[`${kind}_results`] || [];
      if (arr[0]?.id) {
        console.log(`[tmdb] ${imdbId} → ${arr[0].id} (${arr[0].title || arr[0].name})`);
        return String(arr[0].id);
      }
    }
  }

  // Method 2: Title → TMDB via search
  if (title) {
    // Strip year from title for better search results
    // (resolveTitle returns "Title YYYY" but TMDB search works better with just "Title")
    const cleanTitle = title.replace(/\s+\d{4}$/, '').trim();
    const url = `https://api.themoviedb.org/3/search/${kind}?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(cleanTitle)}`;
    const data = curlJson(url, { timeout: 6 });
    if (data?.results?.[0]?.id) {
      console.log(`[tmdb] "${cleanTitle}" → ${data.results[0].id} (${data.results[0].title || data.results[0].name})`);
      return String(data.results[0].id);
    }
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
    // Series need TMDB ID — resolve IMDb → TMDB using curl (not fetch)
    const tmdbId = resolveTmdbId(imdbId, 'series', title);
    if (!tmdbId) {
      console.log(`[xpass] could not resolve TMDB ID for series ${imdbId}`);
      return [];
    }
    embedUrl = `https://play.xpass.top/e/tv/${tmdbId}/${season || 1}/${episode || 1}`;
  } else if (type === 'anime') {
    // Anime needs TMDB ID — resolve from kitsu/title using curl
    let tmdbId = null;
    if (imdbId) {
      tmdbId = resolveTmdbId(imdbId, 'anime', title);
    }
    if (!tmdbId && title) {
      tmdbId = resolveTmdbId(null, 'anime', title);
    }
    if (!tmdbId && kitsuId) {
      // Get title from kitsu API via curl, then search TMDB
      const kitsuData = curlJson(`https://kitsu.io/api/edge/anime/${kitsuId}`, { timeout: 6 });
      if (kitsuData) {
        const kitsuTitle = kitsuData?.data?.attributes?.canonicalTitle;
        if (kitsuTitle) {
          console.log(`[kitsu] ${kitsuId} → "${kitsuTitle}"`);
          tmdbId = resolveTmdbId(null, 'anime', kitsuTitle);
        }
      }
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

  // Fetch playlists — limit to 8 for speed (was 15)
  const allSources = [];
  for (const path of Array.from(playlistPaths).slice(0, 8)) {
    const url = path.startsWith('http') ? path : `https://play.xpass.top${path}`;
    const data = curlJson(url, { referer: embedUrl, timeout: 5 });
    if (!data?.playlist?.[0]?.sources) continue;
    for (const s of data.playlist[0].sources) {
      if (s.file && !s.file.includes('/video/error')) {
        allSources.push({ label: s.label || 'Unknown', file: s.file, id: s.id || '' });
      }
    }
  }

  console.log(`[xpass] collected ${allSources.length} sources, testing in parallel...`);

  // Test each m3u8 URL IN PARALLEL (was sequential — caused Vercel timeouts)
  const testResults = await Promise.all(
    allSources.map(async (src) => ({
      ...src,
      working: ["200","206","302","307"].includes(await checkUrl(src.file, 7)),
    }))
  );
  const working = testResults.filter(s => s.working);
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
// Resolves HubCloud IDs via sportverse.cc to direct CDN URLs (workers.dev)
//
// Resolution chain:
//   1. Search 4khdhub.one → find detail page links
//   2. Fetch detail page → extract HubCloud drive IDs
//   3. For each ID: hubcloud.cx/drive/ID → extract sportverse.cc resolver URL
//   4. sportverse.cc resolver page → extract workers.dev CDN URL
//   5. Test CDN URL → return as stream (marked ⬇️ for download since CDN
//      returns ZIP-compressed MKV that Stremio can't stream but can download)
//
// NOTE: The workers.dev CDN returns ZIP-compressed files (content-type: application/x-zip)
// Stremio's ffmpeg player can't stream ZIP files, but they CAN be downloaded.
// Streams are prefixed with ⬇️ to indicate download-only.
// Most files also return 403 (GDrive quota exceeded) — only ~1 in 7 works at any given time.
// ---------------------------------------------------------------------------
async function scrape4khdhubOne(target, title) {
  if (!title) return [];

  // Step 1: Search 4khdhub.one
  const searchUrl = `https://4khdhub.one/?s=${encodeURIComponent(title)}`;
  console.log(`[4khdhub.one] searching: ${searchUrl}`);
  const searchHtml = curl(searchUrl, { ua: DESKTOP_UA, timeout: 8 });
  if (!searchHtml) return [];

  // Find detail page links
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
  for (const m of searchHtml.matchAll(/href="(\/[^"]+)"/g)) {
    const link = m[1];
    if (skipExtensions.some(ext => link.endsWith(ext))) continue;
    if (skipPrefixes.some(p => link.startsWith(p))) continue;
    if (link === '/' || link.startsWith('/?')) continue;
    if (!/\/[a-z0-9-]+\/?$/i.test(link)) continue;
    detailLinks.add(`https://4khdhub.one${link}`);
  }

  if (detailLinks.size === 0) {
    console.log('[4khdhub.one] no detail links found');
    return [];
  }

  console.log(`[4khdhub.one] found ${detailLinks.size} detail links`);

  // Step 2: Fetch detail pages and extract HubCloud IDs
  const hubcloudIds = new Set();
  for (const link of Array.from(detailLinks).slice(0, 5)) {
    const detailHtml = curl(link, { ua: DESKTOP_UA, referer: 'https://4khdhub.one/', timeout: 6 });
    if (!detailHtml) continue;
    for (const m of detailHtml.matchAll(/hubcloud\.(?:ist|cx|club|fans)\/drive\/([a-zA-Z0-9_-]+)/gi)) {
      hubcloudIds.add(m[1]);
    }
  }

  if (hubcloudIds.size === 0) {
    console.log('[4khdhub.one] no HubCloud IDs found');
    return [];
  }

  console.log(`[4khdhub.one] found ${hubcloudIds.size} HubCloud IDs, resolving via sportverse.cc...`);

  // Step 3-5: Resolve each HubCloud ID via sportverse.cc
  const streams = [];
  let idx = 0;
  for (const hcId of Array.from(hubcloudIds).slice(0, 5)) {
    idx++;
    try {
      // Step 3: Get sportverse.cc resolver URL from hubcloud.cx page
      const hcHtml = curl(`https://hubcloud.cx/drive/${hcId}`, { ua: DESKTOP_UA, timeout: 6 });
      if (!hcHtml) continue;
      const resolverMatch = hcHtml.match(/var url = '([^']+)'/);
      if (!resolverMatch) continue;
      const resolverUrl = resolverMatch[1];

      // Step 4: Fetch sportverse.cc page and extract workers.dev CDN URL
      const sportverseHtml = curl(resolverUrl, { ua: DESKTOP_UA, referer: 'https://hubcloud.cx/', timeout: 8 });
      if (!sportverseHtml) continue;

      // Find workers.dev URL in the page
      const workersIdx = sportverseHtml.indexOf('workers.dev');
      if (workersIdx < 0) continue;
      const hrefStart = sportverseHtml.lastIndexOf('href="', workersIdx);
      if (hrefStart < 0) continue;
      const urlStart = hrefStart + 6;
      const urlEnd = sportverseHtml.indexOf('"', urlStart);
      const cdnUrl = sportverseHtml.substring(urlStart, urlEnd)
        .replace(/ /g, '%20')
        .replace(/\[/g, '%5B')
        .replace(/\]/g, '%5D');

      if (!cdnUrl || !cdnUrl.startsWith('https://')) continue;

      // Step 5: Test the CDN URL (8s timeout — workers.dev can be slow)
      const code = await checkUrl(cdnUrl, 10);
      if (!['200', '206'].includes(code)) {
        console.log(`[4khdhub.one] #${idx} ${hcId}: HTTP ${code} — skipping (quota exceeded)`);
        continue;
      }

      console.log(`[4khdhub.one] #${idx} ${hcId}: ✓ HTTP ${code} — added as download stream`);

      // Mark as download (⬇️) since CDN returns ZIP-compressed MKV
      streams.push({
        name: `⬇️ HerumHai · 4KHDHub #${idx}`,
        description: `Source: 4khdhub.one | HubCloud: ${hcId} | Download (ZIP/MKV)\n${title || ''}`,
        url: cdnUrl,
        behaviorHints: {
          notWebReady: true,
          filename: `${title || 'stream'}-${idx}.mkv`,
          proxyHeaders: {
            request: {
              'User-Agent': DESKTOP_UA,
            },
          },
          bingeGroup: `herumhai-4khdhub-${hcId}`,
        },
      });
    } catch (e) {
      console.log(`[4khdhub.one] #${idx} ${hcId}: error — ${e.message}`);
    }
  }

  console.log(`[4khdhub.one] resolved ${streams.length}/${hubcloudIds.size} HubCloud streams`);
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
    const code = await checkUrl(url, 4);
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

  // Run xpass first (primary source — fast and reliable)
  const xpassStreams = await scrapeXpass(target, title).catch(e => { console.log(`[xpass] error: ${e.message}`); return []; });
  console.log(`[multisource] xpass returned ${xpassStreams.length} streams`);

  // If xpass found enough streams, skip slow secondary sources
  if (xpassStreams.length >= 5) {
    console.log(`[multisource] enough streams from xpass (${xpassStreams.length}), skipping slow sources`);
    return xpassStreams;
  }

  // Run secondary sources in parallel (only if xpass didn't find enough)
  const [hubcloudStreams, vidsrcStreams] = await Promise.all([
    scrape4khdhubOne(target, title).catch(e => { console.log(`[4khdhub.one] error: ${e.message}`); return []; }),
    scrapeVidSrcTo(target, title).catch(e => { console.log(`[vidsrc.to] error: ${e.message}`); return []; }),
  ]);

  const allStreams = [...xpassStreams, ...hubcloudStreams, ...vidsrcStreams];
  console.log(`[multisource] total: ${allStreams.length} streams (xpass=${xpassStreams.length}, hubcloud=${hubcloudStreams.length}, vidsrc=${vidsrcStreams.length})`);
  return allStreams;
}
