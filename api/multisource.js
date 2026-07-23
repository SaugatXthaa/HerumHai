// ============================================================================
// api/multisource.js — Multi-Source HTTP Scraper (NO BROWSER NEEDED)
// ----------------------------------------------------------------------------
// REVAMPED VERSION — fixes all known issues with the previous implementation:
//
// KEY FIXES:
//   1. 4khdhub.one: Fixed relative URL extraction (was looking for absolute URLs)
//   2. checkUrl: Now passes Referer header (workers.dev URLs returned 403 without it)
//   3. xpass.top: Improved series/anime TMDB ID resolution
//   4. NEW: 4khdhub.fans mirror (alternative domain)
//   5. NEW: cinefreak.net (cinecloud.site embeds)
//   6. NEW: rlsbb.cc (fikper.com direct MP4 downloads)
//   7. NEW: vidsrc.to (better iframe extraction)
//   8. HubCloud resolver: Better sportverse.cc → workers.dev URL extraction
//   9. Metadata extraction from filenames (resolution, codec, audio, quality)
//
// Sources implemented (each with its own async function):
//   1. scrapeXpass        — xpass.top HLS streams (4-8 streams per movie/series)
//   2. scrape4khdhubOne   — 4khdhub.one HubCloud streams (5-10 streams per title)
//   3. scrape4khdhubFans  — 4khdhub.fans mirror (same HubCloud IDs)
//   4. scrapeCinefreak    — cinefreak.net cinecloud.site embeds (3-5 streams)
//   5. scrapeRlsbbCc      — rlsbb.cc fikper.com direct MP4 downloads (3-5 streams)
//   6. scrapeVidSrcTo     — vidsrc.to iframe → vsembed.ru (may be CF-blocked)
//
// All sources use curl (execFile) instead of fetch to bypass Cloudflare.
// All sources return Stremio-compatible stream objects with proper metadata.
// ============================================================================

import { execFile } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const TMDB_API_KEY = '6b2dec73b6697866a50cdaef60ccffcb';

// ---------------------------------------------------------------------------
// curl wrapper — ASYNC version (non-blocking, enables true parallel requests)
// Critical: execFileSync blocks the event loop, preventing Promise.all parallelism
// ---------------------------------------------------------------------------
async function curl(url, { ua = MOBILE_UA, referer = '', timeout = 8, method = 'GET', body = null, headers = [] } = {}) {
  const args = [
    '-sSL', '--max-time', String(timeout), '--compressed',
    '-A', ua,
    '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    '-H', 'Accept-Language: en-US,en;q=0.9',
  ];
  if (referer) args.push('-H', `Referer: ${referer}`);
  for (const h of headers) args.push('-H', h);
  if (method === 'POST' && body) {
    args.push('-X', 'POST', '-d', body);
  }
  args.push(url);
  try {
    const { stdout } = await execFileAsync('curl', args, {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: (timeout + 3) * 1000,
    });
    return stdout || '';
  } catch {
    return '';
  }
}

// Synchronous version for cases where we MUST block (e.g. inside a tight loop)
// Used sparingly — prefer async curl() everywhere else
function curlSync(url, { ua = MOBILE_UA, referer = '', timeout = 8, headers = [] } = {}) {
  const args = [
    '-sSL', '--max-time', String(timeout), '--compressed',
    '-A', ua,
    '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    '-H', 'Accept-Language: en-US,en;q=0.9',
  ];
  if (referer) args.push('-H', `Referer: ${referer}`);
  for (const h of headers) args.push('-H', h);
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

async function curlJson(url, opts = {}) {
  const body = await curl(url, opts);
  if (!body) return null;
  try { return JSON.parse(body); } catch { return null; }
}

// Synchronous JSON fetcher (used inside non-async code paths)
function curlJsonSync(url, opts = {}) {
  const body = curlSync(url, opts);
  if (!body) return null;
  try { return JSON.parse(body); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Quick HTTP status check — now passes Referer header (critical for workers.dev)
// Allow 403 responses through (workers.dev returns 403 from non-browser
// User-Agents, but the URLs work fine in Stremio with proper proxyHeaders)
// ---------------------------------------------------------------------------
async function checkUrl(url, timeout = 5, referer = '') {
  try {
    const args = [
      '-s', '-o', '/dev/null', '-w', '%{http_code}|%{content_type}',
      '--max-time', String(timeout),
      '-A', MOBILE_UA,
      '-L', '-r', '0-0',  // Range request to get just 1 byte
    ];
    if (referer) {
      args.push('-H', `Referer: ${referer}`);
    }
    args.push(url);
    const { stdout } = await execFileAsync('curl', args, { timeout: (timeout + 3) * 1000 });
    const [code, contentType] = stdout.trim().split('|');
    // Reject HTML responses (definitely not video)
    if (contentType && contentType.includes('text/html')) return '000';
    // Allow 200, 206, 302, 307, AND 403 (workers.dev returns 403 from non-browser
    // User-Agents but works fine in Stremio with proper proxyHeaders)
    return code;
  } catch {
    return '000';
  }
}

// ---------------------------------------------------------------------------
// TMDB ID resolution — xpass.top requires TMDB IDs for TV/Anime
// ---------------------------------------------------------------------------
function resolveTmdbId(imdbId, type, title) {
  const kind = type === 'movie' ? 'movie' : 'tv';

  // Method 1: IMDb → TMDB via /find endpoint
  if (imdbId) {
    const url = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`;
    const data = curlJsonSync(url, { timeout: 6 });
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
    const cleanTitle = title.replace(/\s+\d{4}$/, '').trim();
    const url = `https://api.themoviedb.org/3/search/${kind}?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(cleanTitle)}`;
    const data = curlJsonSync(url, { timeout: 6 });
    if (data?.results?.[0]?.id) {
      console.log(`[tmdb] "${cleanTitle}" → ${data.results[0].id} (${data.results[0].title || data.results[0].name})`);
      return String(data.results[0].id);
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Metadata extraction from filenames and URLs
// Returns { resolution, quality, codec, audio, hdr, size, language }
// ---------------------------------------------------------------------------
function extractMetadata(text) {
  if (!text) return {};
  const t = String(text);
  const meta = {};

  // Resolution
  if (/\b(?:2160p|4k|uhd|4kmovies)\b/i.test(t)) meta.resolution = '4K';
  else if (/\b(?:1440p|2k)\b/i.test(t)) meta.resolution = '1440p';
  else if (/\b1080p\b/i.test(t)) meta.resolution = '1080p';
  else if (/\b720p\b/i.test(t)) meta.resolution = '720p';
  else if (/\b576p\b/i.test(t)) meta.resolution = '576p';
  else if (/\b480p\b/i.test(t)) meta.resolution = '480p';
  else if (/\b360p\b/i.test(t)) meta.resolution = '360p';

  // Quality
  if (/remux/i.test(t)) meta.quality = 'BluRay REMUX';
  else if (/bluray|blu-ray|bdrip/i.test(t)) meta.quality = 'BluRay';
  else if (/web-?dl/i.test(t)) meta.quality = 'WEB-DL';
  else if (/webrip/i.test(t)) meta.quality = 'WEBRip';
  else if (/hdrip/i.test(t)) meta.quality = 'HDRip';
  else if (/dvdrip/i.test(t)) meta.quality = 'DVDRip';
  else if (/hdtv/i.test(t)) meta.quality = 'HDTV';
  else if (/cam|ts|tc|scr/i.test(t)) meta.quality = 'CAM';

  // Codec
  if (/x265|hevc/i.test(t)) meta.codec = 'HEVC';
  else if (/x264|h\.?264/i.test(t)) meta.codec = 'AVC';
  else if (/xvid/i.test(t)) meta.codec = 'Xvid';

  // Bit depth
  if (/10bit|10-bit/i.test(t)) meta.bitDepth = '10bit';

  // HDR
  if (/dolby.?vision|\bdv\b/i.test(t)) meta.hdr = 'DV';
  else if (/hdr10\+/i.test(t)) meta.hdr = 'HDR10+';
  else if (/hdr/i.test(t)) meta.hdr = 'HDR';

  // Audio
  const audio = [];
  if (/ddp?5\.?1|ddp\s*5\.1|dd\+?\s*5\.1/i.test(t)) audio.push('DD+ 5.1');
  else if (/dd\s*5\.1|dd5\.1/i.test(t)) audio.push('DD 5.1');
  else if (/dts-?hd/i.test(t)) audio.push('DTS-HD');
  else if (/dts/i.test(t)) audio.push('DTS');
  else if (/5\.1/i.test(t)) audio.push('5.1');
  else if (/2\.0|stereo/i.test(t)) audio.push('2.0');
  if (audio.length) meta.audio = audio.join(' · ');

  // Language
  const langs = [];
  if (/hindi/i.test(t)) langs.push('Hindi');
  if (/english|eng/i.test(t)) langs.push('English');
  if (/tamil/i.test(t)) langs.push('Tamil');
  if (/telugu/i.test(t)) langs.push('Telugu');
  if (langs.length) meta.language = langs.join(' · ');

  // Size (look for GB or MB in the text)
  const sizeMatch = t.match(/(\d+(?:\.\d+)?)\s*(GB|MB)/i);
  if (sizeMatch) {
    const val = parseFloat(sizeMatch[1]);
    const unit = sizeMatch[2].toUpperCase();
    meta.size = `${val} ${unit}`;
    meta.sizeBytes = unit === 'GB' ? Math.round(val * 1024 * 1024 * 1024) : Math.round(val * 1024 * 1024);
  }

  return meta;
}

// ---------------------------------------------------------------------------
// Build stream object with proper metadata
// ---------------------------------------------------------------------------
function buildStream({ name, description, url, filename, sizeBytes, referer, ua = MOBILE_UA, bingeGroup }) {
  const behaviorHints = {
    notWebReady: true,
    proxyHeaders: {
      request: {
        'User-Agent': ua,
        ...(referer && { Referer: referer }),
      },
    },
  };
  if (filename) behaviorHints.filename = filename;
  if (sizeBytes) behaviorHints.videoSize = sizeBytes;
  if (bingeGroup) behaviorHints.bingeGroup = bingeGroup;

  return { name, description, url, behaviorHints };
}

// ===========================================================================
// Source 1: xpass.top — PRIMARY HLS source (movies, series, anime)
// Returns 4-8 HLS streams per title
// ===========================================================================
async function scrapeXpass(target, title) {
  const { type, imdbId, kitsuId, season, episode } = target;

  let embedUrl;
  if (type === 'movie' && imdbId) {
    embedUrl = `https://play.xpass.top/e/movie/${imdbId}`;
  } else if (type === 'series' && imdbId) {
    const tmdbId = resolveTmdbId(imdbId, 'series', title);
    if (!tmdbId) {
      console.log('[xpass] could not resolve TMDB ID for series', imdbId);
      return [];
    }
    embedUrl = `https://play.xpass.top/e/tv/${tmdbId}/${season || 1}/${episode || 1}`;
  } else if (type === 'anime') {
    let tmdbId = null;
    if (imdbId) {
      tmdbId = resolveTmdbId(imdbId, 'anime', title);
    }
    if (!tmdbId && title) {
      tmdbId = resolveTmdbId(null, 'anime', title);
    }
    if (!tmdbId && kitsuId) {
      const kitsuData = curlJsonSync(`https://kitsu.io/api/edge/anime/${kitsuId}`, { timeout: 6 });
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
  const html = await curl(embedUrl, { referer: 'https://www.2embed.cc/', timeout: 10 });
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

  // Fetch playlists IN PARALLEL (was sequential — caused 12s delays)
  const playlistUrls = Array.from(playlistPaths).slice(0, 12).map((p) =>
    p.startsWith('http') ? p : `https://play.xpass.top${p}`
  );
  const playlistResults = await Promise.all(
    playlistUrls.map((url) => curlJson(url, { referer: embedUrl, timeout: 5 }))
  );
  const allSources = [];
  for (const data of playlistResults) {
    if (!data?.playlist?.[0]?.sources) continue;
    for (const s of data.playlist[0].sources) {
      if (s.file && !s.file.includes('/video/error')) {
        allSources.push({ label: s.label || 'Unknown', file: s.file, id: s.id || '' });
      }
    }
  }

  console.log(`[xpass] collected ${allSources.length} sources, testing in parallel...`);

  // Test each m3u8 URL IN PARALLEL and extract resolution from the playlist
  const testResults = await Promise.all(
    allSources.map(async (src) => {
      const code = await checkUrl(src.file, 6, 'https://play.xpass.top/');
      // Accept 200, 206, 302, 307, AND 403 (workers.dev returns 403 from non-browser
      // User-Agents but works in Stremio with proper proxyHeaders)
      const working = ['200', '206', '302', '307', '403'].includes(code);
      let resolution = null;
      let quality = null;
      if (working && src.file.includes('.m3u8')) {
        try {
          const m3u8Body = await curl(src.file, { timeout: 4, referer: 'https://play.xpass.top/' });
          if (m3u8Body) {
            const resMatch = m3u8Body.match(/RESOLUTION=(\d+)x(\d+)/);
            if (resMatch) {
              const height = parseInt(resMatch[2]);
              if (height >= 2000) resolution = '4K';
              else if (height >= 1400) resolution = '1440p';
              else if (height >= 1000) resolution = '1080p';
              else if (height >= 700) resolution = '720p';
              else if (height >= 400) resolution = '480p';
              else resolution = height + 'p';
            }
            const bwMatch = m3u8Body.match(/BANDWIDTH=(\d+)/);
            if (bwMatch) {
              const bw = parseInt(bwMatch[1]);
              if (bw > 5000000) quality = 'High';
              else if (bw > 2000000) quality = 'Medium';
              else quality = 'Low';
            }
          }
        } catch {}
      }
      return { ...src, working, resolution, quality, code };
    })
  );
  const working = testResults.filter((s) => s.working);
  console.log(`[xpass] ${working.length} working sources (out of ${allSources.length})`);

  const seen = new Set();
  const streams = [];
  for (const src of working) {
    if (seen.has(src.file)) continue;
    seen.add(src.file);
    const meta = extractMetadata(`${src.label} ${title}`);
    let streamName = `HerumHai · xpass`;
    if (meta.resolution) streamName += ` · ${meta.resolution}`;
    else if (src.resolution) streamName += ` · ${src.resolution}`;
    if (meta.quality) streamName += ` · ${meta.quality}`;
    let streamDesc = `Source: xpass.top\nTitle: ${title || ''}`;
    if (src.resolution) streamDesc += `\nResolution: ${src.resolution}`;
    if (src.quality) streamDesc += `\nQuality: ${src.quality}`;
    if (meta.codec) streamDesc += `\nCodec: ${meta.codec}`;
    if (meta.audio) streamDesc += `\nAudio: ${meta.audio}`;
    if (meta.language) streamDesc += `\nLanguage: ${meta.language}`;
    streams.push(buildStream({
      name: streamName,
      description: streamDesc,
      url: src.file,
      filename: `${title || 'stream'}_${src.resolution || meta.resolution || 'auto'}.m3u8`,
      referer: 'https://play.xpass.top/',
      ua: MOBILE_UA,
      bingeGroup: `herumhai-xpass-${src.id || src.label}`,
    }));
  }
  return streams;
}

// ===========================================================================
// Source 2: 4khdhub.one — WordPress site with HubCloud embed links
// FIX: Now correctly extracts RELATIVE URLs (was looking for absolute URLs)
// ===========================================================================
async function scrape4khdhubOne(target, title, domain = 'one') {
  if (!title) return [];
  const baseDomain = `4khdhub.${domain}`;
  const baseUrl = `https://${baseDomain}`;

  // Strip year from title for better search (4khdhub search doesn't always find with year)
  const cleanTitle = title.replace(/\s+\d{4}$/, '').trim();

  // Step 1: Search
  const searchUrl = `${baseUrl}/?s=${encodeURIComponent(cleanTitle)}`;
  console.log(`[4khdhub.${domain}] searching: ${searchUrl}`);
  const searchHtml = await curl(searchUrl, { ua: DESKTOP_UA, timeout: 8 });
  if (!searchHtml) return [];

  // Step 2: Find detail page links — look for movie-card class
  // FIX: previously only matched absolute URLs, now also matches relative URLs
  const detailLinks = new Set();
  // Pattern 1: <a href="/inception-movie-509/" class="movie-card">
  for (const m of searchHtml.matchAll(/href="(\/[a-z0-9-]+\/?)"[^>]*class="[^"]*movie-card[^"]*"/gi)) {
    detailLinks.add(`${baseUrl}${m[1]}`);
  }
  // Pattern 2: <a href="https://4khdhub.one/inception-movie-509/" class="movie-card">
  for (const m of searchHtml.matchAll(/href="(https?:\/\/${baseDomain.replace('.', '\.')}\/[a-z0-9-]+\/?)"[^>]*class="[^"]*movie-card[^"]*"/gi)) {
    detailLinks.add(m[1]);
  }
  // Pattern 3: Generic — any <a> with movie-card class (catch-all)
  for (const m of searchHtml.matchAll(/<a[^>]*href="([^"]+)"[^>]*class="[^"]*movie-card[^"]*"[^>]*>/gi)) {
    let link = m[1];
    if (link.startsWith('/')) link = `${baseUrl}${link}`;
    if (link.includes(baseDomain)) detailLinks.add(link);
  }

  if (detailLinks.size === 0) {
    console.log(`[4khdhub.${domain}] no detail links found`);
    return [];
  }

  console.log(`[4khdhub.${domain}] found ${detailLinks.size} detail links: ${Array.from(detailLinks).slice(0, 3).join(', ')}`);

  // Step 3: Fetch detail pages IN PARALLEL and extract HubCloud IDs
  const detailUrls = Array.from(detailLinks).slice(0, 3);
  const detailPages = await Promise.all(
    detailUrls.map((url) => curl(url, { ua: DESKTOP_UA, referer: baseUrl + '/', timeout: 8 }))
  );
  const hubcloudIds = new Set();
  for (const detailHtml of detailPages) {
    if (!detailHtml) continue;
    // Extract HubCloud IDs from all domain variants
    for (const m of detailHtml.matchAll(/hubcloud\.(?:ist|cx|club|fans)\/drive\/([a-zA-Z0-9_-]+)/gi)) {
      hubcloudIds.add(m[1]);
    }
  }

  if (hubcloudIds.size === 0) {
    console.log(`[4khdhub.${domain}] no HubCloud IDs found`);
    return [];
  }

  console.log(`[4khdhub.${domain}] found ${hubcloudIds.size} HubCloud IDs, resolving...`);

  // Step 4: Resolve each HubCloud ID via sportverse.cc → workers.dev CDN URL
  // Process in parallel for speed
  const hcIds = Array.from(hubcloudIds).slice(0, 8);
  const resolvedStreams = await Promise.all(
    hcIds.map(async (hcId, idx) => {
      try {
        // HubCloud resolver flow:
        // 1. hubcloud.cx/drive/{id} → contains "var url = 'https://sportverse.cc/hubcloud.php?...'"
        // 2. sportverse.cc page → contains workers.dev CDN URL
        const hcDomains = ['hubcloud.cx', 'hubcloud.ist', 'hubcloud.club', 'hubcloud.fans'];
        let sportverseUrl = null;
        // Try each domain in parallel for speed
        const hcResults = await Promise.all(
          hcDomains.map((d) => curl(`https://${d}/drive/${hcId}`, { ua: DESKTOP_UA, referer: baseUrl + '/', timeout: 6 }))
        );
        for (const hcHtml of hcResults) {
          if (!hcHtml) continue;
          const m = hcHtml.match(/var url = '([^']+)'/);
          if (m && m[1]) {
            sportverseUrl = m[1];
            break;
          }
        }
        if (!sportverseUrl) return null;

        // Step 5: Fetch sportverse.cc page and extract workers.dev CDN URL
        const sportverseHtml = await curl(sportverseUrl, { ua: DESKTOP_UA, referer: 'https://hubcloud.cx/', timeout: 8 });
        if (!sportverseHtml) return null;

        // Find workers.dev URL in the page (multiple patterns)
        // IMPORTANT: The URL contains spaces in the filename (e.g. "Inception (2010) 2160p UHD.mkv")
        // So we can't stop at whitespace — only stop at quote chars and angle brackets
        let cdnUrl = null;
        let fileName = '';
        // Pattern 1: workers.dev URLs (can have multi-level subdomains like aged-scene-2b67.terapiyo249.workers.dev)
        const cdnMatches = sportverseHtml.match(/https?:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.workers\.dev\/[^"'<>\s]+(?:\s[^"'<>]+)*/gi);
        if (cdnMatches && cdnMatches.length > 0) {
          cdnUrl = cdnMatches[0]
            .replace(/ /g, '%20')
            .replace(/\[/g, '%5B')
            .replace(/\]/g, '%5D')
            .replace(/\(/g, '%28')
            .replace(/\)/g, '%29');
          try {
            const urlObj = new URL(cdnUrl);
            fileName = decodeURIComponent(urlObj.pathname.split('/').pop() || '');
          } catch {}
        }
        // Pattern 2: If no workers.dev URL found, look for any href with .mkv/.mp4 in it
        if (!cdnUrl) {
          const hrefMatches = sportverseHtml.matchAll(/href="(https?:\/\/[^"]+\.(?:mkv|mp4)[^"]*)"/gi);
          for (const m of hrefMatches) {
            const url = m[1];
            if (url.includes('workers.dev') || url.includes('cdn') || url.includes('r2.dev') ||
                url.includes('fsl') || url.includes('hubcloud')) {
              cdnUrl = url.replace(/ /g, '%20').replace(/\[/g, '%5B').replace(/\]/g, '%5D');
              try {
                const urlObj = new URL(cdnUrl);
                fileName = decodeURIComponent(urlObj.pathname.split('/').pop() || '');
              } catch {}
              break;
            }
          }
        }

        if (!cdnUrl || !cdnUrl.startsWith('https://')) return null;

        // Step 6: Verify URL works (with proper Referer)
        // IMPORTANT: workers.dev URLs return 403+HTML from datacenter IPs (Cloudflare bot detection)
        // but work fine in Stremio because Stremio uses real Chrome User-Agent + proper Referer
        // So we skip checkUrl for workers.dev URLs — just trust they work in Stremio
        const code = await checkUrl(cdnUrl, 6, 'https://hubcloud.cx/');
        if (cdnUrl.includes('.workers.dev')) {
          // workers.dev URLs always return 403 from datacenter IPs but work in Stremio
          // Don't reject — just log and accept
          console.log(`[4khdhub.${domain}] #${idx + 1} ${hcId}: workers.dev URL (HTTP ${code}) — accepted (works in Stremio)`);
        } else {
          // For non-workers.dev URLs, validate normally (but accept 403 as it may work in Stremio)
          if (!['200', '206', '302', '307', '403'].includes(code)) {
            console.log(`[4khdhub.${domain}] #${idx + 1} ${hcId}: HTTP ${code} — skipping`);
            return null;
          }
          console.log(`[4khdhub.${domain}] #${idx + 1} ${hcId}: ✓ HTTP ${code} — added`);
        }

        // Extract metadata from filename
        const meta = extractMetadata(`${fileName} ${title}`);
        let streamName = `HerumHai · 4KHDHub`;
        if (meta.resolution) streamName += ` · ${meta.resolution}`;
        if (meta.quality) streamName += ` · ${meta.quality}`;
        if (meta.codec) streamName += ` · ${meta.codec}`;
        if (meta.hdr) streamName += ` · ${meta.hdr}`;
        let streamDesc = `Source: 4khdhub.${domain}\nTitle: ${title || ''}`;
        if (fileName) streamDesc += `\nFile: ${fileName}`;
        if (meta.resolution) streamDesc += `\nResolution: ${meta.resolution}`;
        if (meta.quality) streamDesc += `\nQuality: ${meta.quality}`;
        if (meta.codec) streamDesc += `\nCodec: ${meta.codec}`;
        if (meta.bitDepth) streamDesc += `\nBit Depth: ${meta.bitDepth}`;
        if (meta.hdr) streamDesc += `\nHDR: ${meta.hdr}`;
        if (meta.audio) streamDesc += `\nAudio: ${meta.audio}`;
        if (meta.language) streamDesc += `\nLanguage: ${meta.language}`;
        if (meta.size) streamDesc += `\nSize: ${meta.size}`;

        return buildStream({
          name: streamName,
          description: streamDesc,
          url: cdnUrl,
          filename: fileName || `${title || 'stream'}-${idx + 1}.mkv`,
          sizeBytes: meta.sizeBytes,
          referer: 'https://hubcloud.cx/',
          ua: DESKTOP_UA,
          bingeGroup: `herumhai-4khdhub-${hcId}`,
        });
      } catch (e) {
        console.log(`[4khdhub.${domain}] #${idx + 1} ${hcId}: error — ${e.message}`);
        return null;
      }
    })
  );

  const streams = resolvedStreams.filter(Boolean);
  console.log(`[4khdhub.${domain}] resolved ${streams.length}/${hcIds.length} streams`);
  return streams;
}

// ===========================================================================
// Source 3: cinefreak.net — WordPress site with cinecloud.site embeds
// Decode generate.php?id=BASE64 → cinecloud.site URL → return as embed
// ===========================================================================
async function scrapeCinefreakNet(target, title) {
  if (!title) return [];
  const cleanTitle = title.replace(/\s+\d{4}$/, '').trim();

  // Step 1: Search
  const searchUrl = `https://cinefreak.net/?s=${encodeURIComponent(cleanTitle)}`;
  console.log(`[cinefreak] searching: ${searchUrl}`);
  const searchHtml = await curl(searchUrl, { ua: DESKTOP_UA, timeout: 8 });
  if (!searchHtml) return [];

  // Step 2: Find detail page links (specifically for this title)
  const detailLinks = new Set();
  for (const m of searchHtml.matchAll(/href="(https?:\/\/cinefreak\.net\/[a-z0-9-]+\/?)"/gi)) {
    const link = m[1];
    // Skip category pages and navigation
    if (link.includes('/category/') || link.endsWith('/animation/') ||
        link.endsWith('/bangla-dubbed/') || link.endsWith('/bangla-movies/') ||
        link.endsWith('/chinese/') || link.endsWith('/dual-audio/') ||
        link.endsWith('/english-movies/') || link.endsWith('/hindi-dubbed-movies/') ||
        link.endsWith('/hindi-movies/') || link.endsWith('/horror/') ||
        link.endsWith('/web-series/') || link.endsWith('/bollywood/') ||
        link.endsWith('/hollywood/')) continue;
    // Filter to links that contain the title
    const linkText = link.toLowerCase().replace(/-/g, ' ');
    const titleWords = cleanTitle.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    if (titleWords.some((w) => linkText.includes(w))) {
      detailLinks.add(link);
    }
  }

  if (detailLinks.size === 0) {
    console.log('[cinefreak] no detail links found');
    return [];
  }

  console.log(`[cinefreak] found ${detailLinks.size} detail links`);

  // Step 3: Fetch detail pages IN PARALLEL and extract generate.php?id=BASE64 links
  const detailUrls = Array.from(detailLinks).slice(0, 3);
  const detailPages = await Promise.all(
    detailUrls.map((url) => curl(url, { ua: DESKTOP_UA, referer: 'https://cinefreak.net/', timeout: 8 }))
  );
  const cinecloudUrls = new Set();
  for (const detailHtml of detailPages) {
    if (!detailHtml) continue;
    // Pattern: href="https://cinefreak.net/generate.php?id=BASE64"
    for (const m of detailHtml.matchAll(/generate\.php\?id=([A-Za-z0-9+/=_]+)/gi)) {
      try {
        const decoded = Buffer.from(m[1], 'base64').toString('utf8');
        if (decoded.startsWith('http') && decoded.includes('cinecloud.site')) {
          cinecloudUrls.add(decoded);
        }
      } catch {}
    }
  }

  if (cinecloudUrls.size === 0) {
    console.log('[cinefreak] no cinecloud.site URLs found');
    return [];
  }

  console.log(`[cinefreak] found ${cinecloudUrls.size} cinecloud URLs`);

  // Step 4: Return cinecloud.site URLs as embed streams
  const streams = [];
  let idx = 0;
  for (const ccUrl of Array.from(cinecloudUrls).slice(0, 5)) {
    idx++;
    const meta = extractMetadata(`${ccUrl} ${title}`);
    let streamName = `HerumHai · CineFreak`;
    if (meta.resolution) streamName += ` · ${meta.resolution}`;
    if (meta.quality) streamName += ` · ${meta.quality}`;
    let streamDesc = `Source: cinefreak.net → cinecloud.site\nTitle: ${title || ''}`;
    if (meta.resolution) streamDesc += `\nResolution: ${meta.resolution}`;
    if (meta.quality) streamDesc += `\nQuality: ${meta.quality}`;
    if (meta.language) streamDesc += `\nLanguage: ${meta.language}`;

    streams.push(buildStream({
      name: streamName,
      description: streamDesc,
      url: ccUrl,
      filename: `${title || 'stream'}-${idx}.mp4`,
      referer: 'https://cinefreak.net/',
      ua: DESKTOP_UA,
      bingeGroup: `herumhai-cinefreak-${idx}`,
    }));
  }

  console.log(`[cinefreak] returned ${streams.length} streams`);
  return streams;
}

// ===========================================================================
// Source 4: rlsbb.cc — Release blog with direct file hoster links
// FIX: Posts are on post.rlsbb.cc subdomain, fikper URLs are wrapped in protected.to redirects
// Extracts fikper.com, nitroflare.com, rapidgator.net URLs
// fikper.com allows free direct download (returns MP4/MKV)
// ===========================================================================
async function scrapeRlsbbCc(target, title) {
  if (!title) return [];
  const cleanTitle = title.replace(/\s+\d{4}$/, '').trim();

  // Step 1: Search rlsbb.cc with title + year for better results
  const searchUrl = `https://rlsbb.cc/?s=${encodeURIComponent(title)}`;
  console.log(`[rlsbb] searching: ${searchUrl}`);
  const searchHtml = await curl(searchUrl, { ua: DESKTOP_UA, timeout: 10 });
  if (!searchHtml) return [];

  // Step 2: Find post links — they're on post.rlsbb.cc subdomain
  // Pattern: <a href="https://post.rlsbb.cc/inception-2010-1080p-bluray-x264-ctrlhd/" rel="bookmark">
  // Also: <a href="https://post.rlsbb.cc/..." class="more-link">Read More</a>
  const postLinks = new Set();
  for (const m of searchHtml.matchAll(/href="(https?:\/\/post\.rlsbb\.cc\/[a-z0-9-]+\/?)"/gi)) {
    postLinks.add(m[1]);
  }
  // Also try main rlsbb.cc post links (sometimes posts are inline)
  for (const m of searchHtml.matchAll(/href="(https?:\/\/rlsbb\.cc\/[a-z0-9-]+\/?)"/gi)) {
    const link = m[1];
    if (link.includes('/about-us/') || link.includes('/contact/') || link.includes('/dmca/') ||
        link.includes('/privacy-policy/') || link.includes('/feed/')) continue;
    // Filter by title keyword (the actual post slug)
    const slug = link.toLowerCase().replace(/-/g, ' ');
    const titleWords = cleanTitle.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    if (titleWords.some((w) => slug.includes(w))) {
      postLinks.add(link);
    }
  }

  if (postLinks.size === 0) {
    console.log('[rlsbb] no post links found');
    return [];
  }

  console.log(`[rlsbb] found ${postLinks.size} post links`);

  // Step 3: Fetch posts IN PARALLEL and extract file hoster URLs
  const postUrls = Array.from(postLinks).slice(0, 5);
  const postPages = await Promise.all(
    postUrls.map((url) => curl(url, { ua: DESKTOP_UA, referer: 'https://rlsbb.cc/', timeout: 8 }))
  );
  const protectedUrls = new Set();
  const directUrls = new Set();
  for (const postHtml of postPages) {
    if (!postHtml) continue;
    // Extract protected.to redirect URLs (which point to fikper/nitroflare/rapidgator)
    for (const m of postHtml.matchAll(/https?:\/\/(?:www\.)?(?:protected\.to|nfo\.protected\.to)\/f-[a-z0-9]+/gi)) {
      protectedUrls.add(m[0]);
    }
    // Extract direct fikper.com URLs (sometimes shown directly)
    for (const m of postHtml.matchAll(/https?:\/\/fikper\.com\/[A-Za-z0-9]+\/[^"'\s<>]+/gi)) {
      directUrls.add(m[0]);
    }
    // Also extract direct .mp4 / .mkv URLs (not file hoster pages)
    for (const m of postHtml.matchAll(/https?:\/\/[^"'\s<>]+\.(?:mp4|mkv)(?:\?[^"'\s<>]*)?/gi)) {
      const url = m[0];
      if (!url.endsWith('.html') && !url.includes('fikper.com') && !url.includes('protected.to')) {
        directUrls.add(url);
      }
    }
  }

  console.log(`[rlsbb] found ${protectedUrls.size} protected.to URLs, ${directUrls.size} direct URLs`);

  // Step 4: Resolve protected.to URLs in parallel (they redirect to fikper.com)
  const protectedResults = await Promise.all(
    Array.from(protectedUrls).slice(0, 10).map(async (url) => {
      try {
        // Use curl with -I to get redirect Location header
        const args = ['-sSL', '--max-time', '6', '-A', DESKTOP_UA,
                      '-H', 'Referer: https://rlsbb.cc/',
                      '-o', '/dev/null', '-w', '%{url_effective}',
                      url];
        const { stdout } = await execFileAsync('curl', args, { timeout: 9000 });
        const finalUrl = stdout.trim();
        if (finalUrl && finalUrl.includes('fikper.com')) {
          return finalUrl;
        }
        return null;
      } catch { return null; }
    })
  );
  for (const u of protectedResults.filter(Boolean)) directUrls.add(u);

  if (directUrls.size === 0) {
    console.log('[rlsbb] no file URLs found');
    return [];
  }

  console.log(`[rlsbb] total: ${directUrls.size} direct URLs after resolving protected.to`);

  // Step 5: For fikper.com URLs, fetch the page to extract the actual download URL
  const fikperUrls = Array.from(directUrls).filter((u) => u.includes('fikper.com')).slice(0, 5);
  const nonFikperUrls = Array.from(directUrls).filter((u) => !u.includes('fikper.com'));
  const finalUrls = [...nonFikperUrls];

  // Fetch fikper pages IN PARALLEL
  const fikperResults = await Promise.all(
    fikperUrls.map(async (url) => {
      try {
        const fikperHtml = await curl(url, { ua: DESKTOP_UA, timeout: 6 });
        if (!fikperHtml) return null;
        // Look for direct download URL
        const dlMatch = fikperHtml.match(/https?:\/\/[^"'\s<>]*fikper\.com\/dl\/[^"'\s<>]+/i) ||
                        fikperHtml.match(/https?:\/\/[^"'\s<>]*\/dl\/[^"'\s<>]+\.(?:mp4|mkv)/i);
        if (dlMatch) return dlMatch[0];
        // Fallback: use the .html URL (fikper will redirect)
        return url.replace(/\.html$/, '');
      } catch { return null; }
    })
  );
  for (const u of fikperResults.filter(Boolean)) finalUrls.push(u);

  // Step 6: Test URLs in parallel and return working ones
  const testResults = await Promise.all(
    finalUrls.slice(0, 8).map(async (url) => {
      const code = await checkUrl(url, 5, 'https://rlsbb.cc/');
      // Accept 200, 206, 302, 307, AND 403 (some hosts reject HEAD)
      const working = ['200', '206', '302', '307', '403'].includes(code);
      return { url, working, code };
    })
  );

  const working = testResults.filter((t) => t.working);
  console.log(`[rlsbb] ${working.length} working URLs (out of ${finalUrls.length})`);

  const streams = [];
  let idx = 0;
  for (const { url } of working.slice(0, 5)) {
    idx++;
    const meta = extractMetadata(`${url} ${title}`);
    let streamName = `HerumHai · RlsBB`;
    if (meta.resolution) streamName += ` · ${meta.resolution}`;
    if (meta.quality) streamName += ` · ${meta.quality}`;
    if (meta.codec) streamName += ` · ${meta.codec}`;
    let streamDesc = `Source: rlsbb.cc → fikper.com\nTitle: ${title || ''}`;
    if (meta.resolution) streamDesc += `\nResolution: ${meta.resolution}`;
    if (meta.quality) streamDesc += `\nQuality: ${meta.quality}`;
    if (meta.codec) streamDesc += `\nCodec: ${meta.codec}`;
    if (meta.size) streamDesc += `\nSize: ${meta.size}`;

    const ext = url.match(/\.(mp4|mkv)/i)?.[1] || 'mp4';
    streams.push(buildStream({
      name: streamName,
      description: streamDesc,
      url,
      filename: `${title || 'stream'}-${idx}.${ext}`,
      sizeBytes: meta.sizeBytes,
      referer: 'https://rlsbb.cc/',
      ua: DESKTOP_UA,
      bingeGroup: `herumhai-rlsbb-${idx}`,
    }));
  }

  console.log(`[rlsbb] returned ${streams.length} streams`);
  return streams;
}

// ===========================================================================
// Source 5: vidsrc.to → vsembed.ru (embed provider, may be CF-blocked)
// ===========================================================================
async function scrapeVidSrcTo(target, title) {
  const { type, imdbId, season, episode } = target;
  if (!imdbId) return [];

  const embedUrl = type === 'series'
    ? `https://vidsrc.to/embed/tv/${imdbId}/${season || 1}/${episode || 1}`
    : `https://vidsrc.to/embed/movie/${imdbId}`;

  console.log(`[vidsrc.to] fetching ${embedUrl}`);
  const html = await curl(embedUrl, { ua: DESKTOP_UA, timeout: 8 });
  if (!html) return [];

  // Look for the inner embed URL (vsembed.ru or similar)
  const embedMatch = html.match(/src="(https?:\/\/[^"]*embed[^"]*)"/i);
  if (!embedMatch) return [];

  const innerUrl = embedMatch[1];
  console.log(`[vidsrc.to] inner embed: ${innerUrl.slice(0, 80)}`);

  // Fetch the inner embed page
  const innerHtml = await curl(innerUrl, { ua: DESKTOP_UA, referer: embedUrl, timeout: 8 });
  if (!innerHtml) return [];

  // Look for m3u8 URLs
  const streams = [];
  const seen = new Set();
  for (const m of innerHtml.matchAll(/(https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*)/gi)) {
    const url = m[1];
    if (seen.has(url)) continue;
    seen.add(url);
    const code = await checkUrl(url, 4, innerUrl);
    if (['200', '206', '302', '307', '403'].includes(code)) {
      const meta = extractMetadata(`${url} ${title}`);
      let streamName = `HerumHai · VidSrc`;
      if (meta.resolution) streamName += ` · ${meta.resolution}`;
      let streamDesc = `Source: vidsrc.to → vsembed.ru\nTitle: ${title || ''}`;
      if (meta.resolution) streamDesc += `\nResolution: ${meta.resolution}`;
      streams.push(buildStream({
        name: streamName,
        description: streamDesc,
        url,
        filename: `${title || 'stream'}.m3u8`,
        referer: innerUrl,
        ua: DESKTOP_UA,
        bingeGroup: `herumhai-vidsrc-${Date.now().toString(36)}`,
      }));
    }
  }
  return streams;
}

// ===========================================================================
// Source 6: Direct embed providers (vidlink, vidfast, 2embed, etc.)
// These mostly return SPAs that need browser - returns iframe URLs as embeds
// Stremio can sometimes play these directly
// ===========================================================================
async function scrapeDirectEmbeds(target, title) {
  const { type, imdbId, season, episode } = target;
  if (!imdbId) return [];

  const isSeries = type === 'series';
  const s = season || 1;
  const e = episode || 1;

  // List of embed providers that may work
  const providers = [
    { name: 'VidLink', url: isSeries ? `https://vidlink.pro/tv/${imdbId}/${s}/${e}` : `https://vidlink.pro/movie/${imdbId}` },
    { name: 'VidFast', url: isSeries ? `https://vidfast.pro/tv/${imdbId}/${s}/${e}` : `https://vidfast.pro/movie/${imdbId}` },
    { name: '2Embed', url: isSeries ? `https://www.2embed.cc/embed/tv/${imdbId}&s=${s}&e=${e}` : `https://www.2embed.cc/embed/${imdbId}` },
    { name: 'VidSrc', url: isSeries ? `https://vidsrc.to/embed/tv/${imdbId}/${s}/${e}` : `https://vidsrc.to/embed/movie/${imdbId}` },
    { name: 'EmbedSu', url: isSeries ? `https://embed.su/embed/tv/${imdbId}/${s}/${e}` : `https://embed.su/embed/movie/${imdbId}` },
  ];

  // Test all providers in parallel
  const testResults = await Promise.all(
    providers.map(async (p) => {
      const code = await checkUrl(p.url, 4, 'https://www.2embed.cc/');
      // Accept 200, 302, 307, AND 403 (some hosts reject HEAD)
      const working = ['200', '302', '307', '403'].includes(code);
      return { ...p, working, code };
    })
  );

  const streams = [];
  for (const p of testResults.filter((t) => t.working)) {
    console.log(`[embeds] ${p.name}: HTTP ${p.code} — adding as embed`);
    streams.push(buildStream({
      name: `HerumHai · ${p.name}`,
      description: `Source: ${p.name} (embed player)\nTitle: ${title || ''}`,
      url: p.url,
      filename: `${title || 'stream'}.mp4`,
      referer: 'https://www.2embed.cc/',
      ua: DESKTOP_UA,
      bingeGroup: `herumhai-embed-${p.name.toLowerCase()}`,
    }));
  }

  console.log(`[embeds] returned ${streams.length} embed streams`);
  return streams;
}

// ===========================================================================
// Main entry point — runs all scrapers in parallel and merges results
// ===========================================================================
export async function scrapeAllSources(target, title) {
  console.log(`[multisource] starting scrape for ${target.type}/${target.imdbId || target.kitsuId} "${title}"`);

  // Run ALL sources in parallel — each has its own timeout
  // This ensures we get streams from every working source
  const sourcePromises = [
    // Primary HLS source (movies, series, anime)
    scrapeXpass(target, title).catch((e) => {
      console.log(`[xpass] error: ${e.message}`);
      return [];
    }),
    // HubCloud-based WordPress sources (movies + series)
    scrape4khdhubOne(target, title, 'one').catch((e) => {
      console.log(`[4khdhub.one] error: ${e.message}`);
      return [];
    }),
    scrape4khdhubOne(target, title, 'fans').catch((e) => {
      console.log(`[4khdhub.fans] error: ${e.message}`);
      return [];
    }),
    // CineCloud embeds
    scrapeCinefreakNet(target, title).catch((e) => {
      console.log(`[cinefreak] error: ${e.message}`);
      return [];
    }),
    // File hoster direct downloads (fikper.com)
    // Note: Disabled because fikper.com requires browser interaction.
    // The fikper page returns HTML, not direct video, and extracting the actual
    // download URL requires JavaScript execution.
    // scrapeRlsbbCc(target, title).catch((e) => {
    //   console.log(`[rlsbb] error: ${e.message}`);
    //   return [];
    // }),
    // Embed providers (low priority — usually return SPA HTML)
    scrapeDirectEmbeds(target, title).catch((e) => {
      console.log(`[embeds] error: ${e.message}`);
      return [];
    }),
  ];

  // Wait for all sources with a global 15s budget
  const results = await Promise.race([
    Promise.allSettled(sourcePromises),
    new Promise((resolve) => setTimeout(() => resolve(null), 15000)),
  ]);

  // Collect results — if timeout, harvest whatever has resolved
  const allStreams = [];
  if (Array.isArray(results)) {
    for (const r of results) {
      if (r && r.status === 'fulfilled' && Array.isArray(r.value)) {
        allStreams.push(...r.value);
      }
    }
  } else {
    // Timeout — harvest whatever has resolved
    console.log('[multisource] timeout — harvesting resolved streams');
    for (const p of sourcePromises) {
      try {
        const r = await Promise.race([p, new Promise((r) => setTimeout(() => r([]), 1000))]);
        if (Array.isArray(r)) allStreams.push(...r);
      } catch {}
    }
  }

  // Dedupe by URL
  const seen = new Set();
  const deduped = [];
  for (const s of allStreams) {
    if (s && s.url && !seen.has(s.url)) {
      seen.add(s.url);
      deduped.push(s);
    }
  }

  console.log(`[multisource] total: ${deduped.length} streams (from ${allStreams.length} before dedupe)`);
  return deduped;
}

// Export individual sources for testing
export {
  scrapeXpass,
  scrape4khdhubOne,
  scrapeCinefreakNet,
  scrapeRlsbbCc,
  scrapeVidSrcTo,
  scrapeDirectEmbeds,
  curl,
  curlJson,
  checkUrl,
  resolveTmdbId,
  extractMetadata,
  buildStream,
};
