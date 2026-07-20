// ============================================================================
// sources/moviepire.js — Moviepire.co API Scraper (4KHDHub's data backend)
// ----------------------------------------------------------------------------
// 4khdhub.store is a React SPA that uses moviepire.co as its data backend.
// moviepire.co is Cloudflare-protected but accessible with mobile UA.
//
// The stream URLs are fetched via React Server Actions (_serverFn endpoint)
// which require:
//   1. A valid session cookie (media_client_key)
//   2. A valid x-request-nonce header (generated client-side per session)
//
// This scraper uses puppeteer to:
//   1. Load video.moviepire.co/embed/movie/{tmdbId}
//   2. Wait for the _serverFn nonce to be generated
//   3. Click play button to trigger stream loading
//   4. Capture the _serverFn response which contains HubCloud IDs
//   5. Resolve HubCloud IDs → direct CDN URLs
//
// This is EXACTLY what PenguPlay does — render the SPA and capture network traffic.
// ============================================================================

import puppeteer from 'puppeteer';
import { scrapeUniversalEmbeds } from './universal_embeds.js';
import { resolveHubCloud, detectQuality, detectAudio, formatFileSize } from './hubcloud.js';

const USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

let _browser = null;

async function getBrowser() {
  if (_browser && _browser.connected) return _browser;
  _browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
    ],
    defaultViewport: { width: 1366, height: 768 },
  });
  return _browser;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Scrape Moviepire.co for a movie/series/anime
 * @param {string} title     - Movie title (for display)
 * @param {string} imdbId    - IMDB ID (tt1375666) — used to resolve TMDB ID
 * @param {string} type      - 'movie' | 'series' | 'anime'
 * @param {number|null} season
 * @param {number|null} episode
 * @param {string|null} kitsuId - Kitsu ID (for anime)
 * @returns {Promise<Array>} Array of stream objects
 */
export async function scrapeMoviepire(title, imdbId, type = 'movie', season = null, episode = null, kitsuId = null) {
  // Resolve TMDB ID from IMDB ID or kitsu ID
  let tmdbId = null;
  if (imdbId) {
    tmdbId = await resolveTmdbFromImdb(imdbId, type);
  } else if (kitsuId) {
    tmdbId = await resolveTmdbFromKitsu(kitsuId);
  }
  if (!tmdbId) {
    console.log(`  [moviepire] could not resolve TMDB ID (imdb=${imdbId}, kitsu=${kitsuId})`);
    return [];
  }

  console.log(`  [moviepire] TMDB ID: ${tmdbId} — loading embed player`);

  const browser = await getBrowser();
  const page = await browser.newPage();
  await page.setUserAgent(USER_AGENT);
  await page.setExtraHTTPHeaders({ Referer: 'https://4khdhub.store/' });

  const hubcloudIds = new Set();
  const m3u8Urls = new Set();

  // Capture ALL network responses — look for HubCloud IDs and .m3u8 URLs
  page.on('response', async (resp) => {
    try {
      const url = resp.url();
      const ct = resp.headers()['content-type'] || '';

      // Direct .m3u8 URLs
      if (/\.m3u8(\?|$)/i.test(url)) {
        m3u8Urls.add(url);
        return;
      }

      // Scan JSON/text responses for HubCloud IDs and .m3u8 URLs
      if (ct.includes('json') || ct.includes('text') || ct.includes('framed')) {
        const body = await resp.text();
        // HubCloud IDs
        const hcRe = /hubcloud\.[a-z]+\/drive\/([A-Za-z0-9_-]+)/gi;
        let m;
        while ((m = hcRe.exec(body)) !== null) {
          hubcloudIds.add(m[1]);
        }
        // .m3u8 URLs in JSON
        const m3u8Re = /https?:\/\/[^\s"'<>\]\\\)]+\.m3u8(?:\?[^\s"'<>\]\\\)]*)?/gi;
        while ((m = m3u8Re.exec(body)) !== null) {
          m3u8Urls.add(m[0]);
        }
      }
    } catch {}
  });

  try {
    // Build the embed URL
    const embedPath = type === 'movie'
      ? `/embed/movie/${tmdbId}`
      : `/embed/tv/${tmdbId}/${season || 1}/${episode || 1}`;
    const embedUrl = `https://video.moviepire.co${embedPath}`;

    console.log(`  [moviepire] → ${embedUrl.slice(0, 80)}`);
    await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(3000);

    // Click play button to trigger _serverFn calls
    await page.evaluate(() => {
      document.querySelectorAll('button, [class*=play], [class*=server], [class*=quality]').forEach((el) => {
        try { el.click(); } catch {}
      });
    });
    await sleep(5000);

    // Try clicking server/quality buttons that may have appeared
    await page.evaluate(() => {
      document.querySelectorAll('button, [role=button], [class*=server], [class*=quality], [class*=download]').forEach((el) => {
        try { el.click(); } catch {}
      });
    });
    await sleep(3000);

    console.log(`  [moviepire] captured ${hubcloudIds.size} HubCloud IDs, ${m3u8Urls.size} HLS URLs`);

    // Resolve HubCloud IDs → direct CDN URLs
    const streams = [];
    for (const id of [...hubcloudIds].slice(0, 5)) {
      try {
        const resolved = await resolveHubCloud(id);
        if (resolved && resolved.directUrl) {
          const quality = detectQuality(resolved.filename || resolved.directUrl);
          const audio = detectAudio(resolved.filename);
          streams.push({
            name: `HerumHai ${quality.rank >= 2160 ? '❄️' : '🎯'} ${quality.label} • 4KHDHub · Moviepire`,
            description: `🍿 ${title}\n💾 ${formatFileSize(resolved.fileSize)}\n🎧 Audio: ${audio.join(', ')}`,
            url: resolved.directUrl,
            behaviorHints: {
              notWebReady: true,
              filename: resolved.filename || '',
              videoSize: resolved.fileSize || 0,
              proxyHeaders: {
                request: {
                  'User-Agent': USER_AGENT,
                  'Referer': resolved.referer || 'https://hubcloud.cx/',
                },
              },
            },
            sourceSlug: '4khdhub',
          });
        }
      } catch (e) {
        console.log(`  [moviepire] hubcloud ${id} failed: ${e.message}`);
      }
    }

    // Add direct HLS streams
    for (const m3u8 of [...m3u8Urls].slice(0, 3)) {
      const quality = detectQuality(m3u8);
      streams.push({
        name: `HerumHai 🎬 ${quality.label} • 4KHDHub · HLS`,
        description: `🍿 ${title}\n📡 HLS Stream\n🛰️ Source: Moviepire`,
        url: m3u8,
        behaviorHints: {
          notWebReady: false,
          proxyHeaders: {
            request: {
              'User-Agent': USER_AGENT,
              'Referer': 'https://video.moviepire.co/',
            },
          },
        },
        sourceSlug: '4khdhub',
      });
    }

    console.log(`  [moviepire] ✓ ${streams.length} streams`);
    if (streams.length > 0) return streams;
    
    // Fallback: universal embed (xpass.top) if puppeteer failed
    console.log(`  [moviepire] puppeteer returned 0 — using universal embed fallback`);
    return scrapeUniversalEmbeds(title, imdbId, type, season, episode);
  } catch (e) {
    console.log(`  [moviepire] error: ${e.message} — using universal embed fallback`);
    return scrapeUniversalEmbeds(title, imdbId, type, season, episode);
  } finally {
    await page.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// TMDB ID resolution
// ---------------------------------------------------------------------------
const TMDB_API_KEY = '6b2dec73b6697866a50cdaef60ccffcb';

async function resolveTmdbFromImdb(imdbId, type) {
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

async function resolveTmdbFromKitsu(kitsuId) {
  if (!kitsuId) return null;
  try {
    // Get title from Kitsu API
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
        // Search TMDB for this title
        const tmdbUrl = `https://api.themoviedb.org/3/search/tv?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(title)}`;
        const tmdbRes = await fetch(tmdbUrl, { signal: AbortSignal.timeout(5000) });
        if (tmdbRes.ok) {
          const tmdbData = await tmdbRes.json();
          if (tmdbData?.results?.[0]?.id) return String(tmdbData.results[0].id);
        }
      }
    }
  } catch {}
  return null;
}

export async function closeBrowser() {
  if (_browser) {
    await _browser.close().catch(() => {});
    _browser = null;
  }
}
