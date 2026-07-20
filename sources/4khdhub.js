// ============================================================================
// sources/4khdhub.js — 4KHDHub.store Scraper (FIXED)
// ----------------------------------------------------------------------------
// 4khdhub.store is now a React SPA. Its data backend (moviepire.co) is
// CF-blocked, so the legacy JSON.parse hook often finds nothing.
//
// Flow:
//   1. Try xpass.top via direct HTTP FIRST (fast, no browser) — Phase 1
//   2. If xpass.top fails, open 4khdhub.store/watch/{tmdb_id} in browser — Phase 2
//   3. Hook JSON.parse to capture decrypted stream data
//   4. If still nothing, try AnyEmbed + VidSrc via browser — Phase 3
//
// The HLS stream requires Referer: https://player.videasy.to/ (for legacy path)
// or Referer: https://play.xpass.top/ (for xpass.top fallback)
// ============================================================================

import puppeteer from 'puppeteer';
import axios from 'axios';
import { scrapeUniversalEmbeds } from './universal_embeds.js';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// TMDB API key publicly hardcoded in 4khdhub.store's SPA bundle
const TMDB_API_KEY = '6b2dec73b6697866a50cdaef60ccffcb';

// Browser-based embed providers (used as last resort if xpass.top fails)
const EMBED_PROVIDERS_BROWSER = [
  { name: 'AnyEmbed',  url: (t) => `https://anyembed.xyz/embed?tmdb=${t.tmdbId}` },
  { name: 'VidSrc',    url: (t) => t.type === 'series' || t.type === 'anime'
      ? `https://vidsrc.win/embed/tv/${t.imdbId}/${t.season || 1}/${t.episode || 1}`
      : `https://vidsrc.win/embed/movie/${t.imdbId}` },
];

let _browser = null;

async function getBrowser() {
  if (_browser && _browser.connected) return _browser;
  _browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
      '--no-first-run',
      '--no-zygote', 
    ],
    defaultViewport: { width: 1366, height: 768 },
  });
  return _browser;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Scrape 4KHDHub.store for a movie/series/anime
 * @param {string} title     - Movie/anime title for search
 * @param {string} imdbId    - IMDb ID (tt1375666) — null for anime
 * @param {string} type      - 'movie' | 'series' | 'anime'
 * @param {number|null} season
 * @param {number|null} episode
 * @param {string|null} kitsuId - Kitsu ID (for anime)
 * @returns {Promise<Array>} Array of stream objects
 */
export async function scrape4KHDHub(title, imdbId, type = 'movie', season = null, episode = null, kitsuId = null) {
  if (!title && !imdbId && !kitsuId) return [];

  // ---------- Phase 1: Try xpass.top via direct HTTP FIRST (fast, no browser) ----------
  // xpass.top works for movies, TV series, AND anime — all via IMDB or TMDB ID.
  // For anime without IMDB ID, it resolves kitsu→TMDB internally.
  if (imdbId || kitsuId) {
    console.log(`  [4khdhub] trying xpass.top via direct HTTP first (no browser)`);
    try {
      const xpassStreams = await scrapeUniversalEmbeds(title, imdbId, type, season, episode, kitsuId);
      if (xpassStreams.length > 0) {
        // Re-label as 4KHDHub for source attribution
        const relabeled = xpassStreams.map((s) => ({
          ...s,
          name: s.name.replace('Universal', '4KHDHub'),
          description: s.description.replace('xpass.top', '4KHDHub'),
          sourceSlug: '4khdhub',
        }));
        console.log(`  [4khdhub] ✓ xpass.top returned ${relabeled.length} streams — skipping browser path`);
        return relabeled;
      }
      console.log(`  [4khdhub] xpass.top returned 0 streams — falling back to browser scraping`);
    } catch (e) {
      console.log(`  [4khdhub] xpass.top error: ${e.message} — falling back to browser scraping`);
    }
  }

  // ---------- Phase 2: Browser-based legacy 4khdhub.store scraping ----------
  const browser = await getBrowser();
  const page = await browser.newPage();
    
    // Block heavy assets to save memory (HidenCloud optimization)
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });
  await page.setUserAgent(USER_AGENT);

  const capturedStreams = [];

  // Hook JSON.parse in ALL frames to capture decrypted stream data
  await page.evaluateOnNewDocument(() => {
    // Stealth overrides — anti-bot (same as PenguPlay)
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = window.chrome || { runtime: {} };
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    const origParse = JSON.parse;
    window.__capturedStreams = [];
    JSON.parse = function (text) {
      try {
        const result = origParse.call(this, text);
        const str = JSON.stringify(result);
        if (str && str.includes('sources') && (str.includes('.m3u8') || str.includes('hubcloud'))) {
          window.__capturedStreams.push(result);
        }
        return result;
      } catch (e) {
        return origParse.call(this, text);
      }
    };
  });

  try {
    // Step 1: Search for the movie on 4KHDHub
    const searchUrl = `https://4khdhub.store/search?q=${encodeURIComponent(title || imdbId || kitsuId)}`;
    console.log(`  [4khdhub] searching: ${searchUrl.slice(0, 80)}`);
    // BUGFIX: use 'domcontentloaded' instead of 'networkidle2' — the SPA's
    // long-polling ad scripts prevent networkidle2 from ever firing, causing
    // 30s hangs on every request.
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await sleep(5000);

    // Find the watch link
    const watchLinks = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a[href]'))
        .map((a) => a.href)
        .filter((href) => href.includes('/watch/') || href.includes('/movie/') || href.includes('/series/'))
        .slice(0, 5);
    });

    if (watchLinks.length === 0) {
      console.log(`  [4khdhub] no results found — falling back to browser embed providers`);
      return scrape4KHDHubViaBrowserEmbeds(title, imdbId, type, season, episode, browser);
    }

    // Step 2: Open the watch page
    const watchUrl = watchLinks[0];
    console.log(`  [4khdhub] opening: ${watchUrl.slice(0, 80)}`);
    await page.goto(watchUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await sleep(8000);

    // Step 3: Click play to trigger the player
    await page.mouse.click(640, 360).catch(() => {});
    await sleep(5000);

    // Also try clicking any play button
    await page.evaluate(() => {
      const btns = document.querySelectorAll('button, [role=button], [class*=play]');
      btns.forEach((b) => {
        if (b.textContent.toLowerCase().includes('play') || b.className.includes('play')) {
          b.click();
        }
      });
    });
    await sleep(8000);

    // Step 4: Check ALL frames for captured stream data
    for (const frame of page.frames()) {
      try {
        const captured = await frame.evaluate(() => window.__capturedStreams || []).catch(() => []);
        for (const data of captured) {
          if (data.sources && Array.isArray(data.sources)) {
            for (const source of data.sources) {
              if (source.url && source.url.includes('.m3u8')) {
                console.log(`  [4khdhub] ✅ HLS stream found: ${source.url.slice(0, 80)}...`);
                capturedStreams.push({
                  name: `HerumHai 🎯 ${source.quality || 'Auto'} • 4KHDHub`,
                  description: `🍿 ${title}\n🎥 HLS Stream\n🛰️ Source: 4KHDHub · FSL`,
                  url: source.url,
                  behaviorHints: {
                    notWebReady: false,
                    proxyHeaders: {
                      request: {
                        'User-Agent': USER_AGENT,
                        'Referer': 'https://player.videasy.to/',
                      },
                    },
                  },
                  sourceSlug: '4khdhub',
                });
              }
            }
          }
        }
      } catch {}
    }

    console.log(`  [4khdhub] legacy path found ${capturedStreams.length} streams`);
    if (capturedStreams.length > 0) return capturedStreams;

    // Legacy JSON.parse hook found nothing — try browser embed providers
    console.log(`  [4khdhub] legacy path returned 0 streams — falling back to browser embed providers`);
    return scrape4KHDHubViaBrowserEmbeds(title, imdbId, type, season, episode, browser);
  } catch (e) {
    console.log(`  [4khdhub] error: ${e.message}`);
    return scrape4KHDHubViaBrowserEmbeds(title, imdbId, type, season, episode, browser);
  } finally {
    await page.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// FALLBACK: Browser-based embed provider scraper
// ----------------------------------------------------------------------------
// Called when both xpass.top (Phase 1) and legacy 4khdhub.store (Phase 2) fail.
// Opens AnyEmbed / VidSrc in browser and captures .m3u8 from network traffic.
// ---------------------------------------------------------------------------
async function resolveTmdbId(imdbId, type) {
  if (!imdbId) return null;
  try {
    const kind = type === 'series' || type === 'anime' ? 'tv' : 'movie';
    const url = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`;
    const res = await axios.get(url, { timeout: 8000, validateStatus: () => true });
    if (res.status === 200) {
      const arr = res.data?.[`${kind}_results`] || [];
      if (arr[0]?.id) return String(arr[0].id);
    }
  } catch {}
  return null;
}

async function scrape4KHDHubViaBrowserEmbeds(title, imdbId, type, season, episode, browser) {
  const tmdbId = await resolveTmdbId(imdbId, type);
  if (!tmdbId && !imdbId) {
    console.log(`  [4khdhub:embeds] no IMDB or TMDB ID — cannot call browser embed providers`);
    return [];
  }
  console.log(`  [4khdhub:embeds] imdb=${imdbId} tmdb=${tmdbId || 'n/a'} — trying ${EMBED_PROVIDERS_BROWSER.length} browser providers`);

  const allStreams = [];

  for (const provider of EMBED_PROVIDERS_BROWSER) {
    const target = { imdbId, tmdbId, type, season, episode };
    const embedUrl = provider.url(target);
    if (!embedUrl) continue;

    let page;
    try {
      page = await browser.newPage();
      await page.setUserAgent(USER_AGENT);
      await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

      const captured = new Set();

      // Capture .m3u8 from network traffic + scan JSON bodies for embedded URLs
      page.on('response', async (resp) => {
        try {
          const u = resp.url();
          if (/\.m3u8(\?|$)/i.test(u)) {
            if (!captured.has(u)) {
              captured.add(u);
              console.log(`  [4khdhub:embeds:${provider.name}] ✓ HLS: ${u.slice(0, 80)}`);
            }
            return;
          }
          // Scan JSON API bodies for embedded stream URLs
          if (/\/api\/|\/ajax\/|\/sources?\b|\.json/i.test(u)) {
            const ct = resp.headers()['content-type'] || '';
            if (ct.includes('json') || ct.includes('text')) {
              try {
                const body = await resp.text();
                const re = /https?:\/\/[^\s"'<>\]\\\)]+\.m3u8(?:\?[^\s"'<>\]\\\)]*)?/gi;
                let m;
                while ((m = re.exec(body)) !== null) {
                  if (!captured.has(m[0])) {
                    captured.add(m[0]);
                    console.log(`  [4khdhub:embeds:${provider.name}] ✓ HLS (from JSON): ${m[0].slice(0, 80)}`);
                  }
                }
              } catch {}
            }
          }
        } catch {}
      });

      await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });

      // Click play button if present
      try {
        await page.waitForSelector('button, .play-btn, [class*="play"], video', { timeout: 6000 });
        await page.click('button, .play-btn, [class*="play"]').catch(() => {});
      } catch {}

      // Wait for .m3u8 to appear in network traffic (up to 12s)
      const start = Date.now();
      while (Date.now() - start < 12000 && captured.size === 0) {
        await new Promise((r) => setTimeout(r, 1500));
      }
      // 3s grace period for late XHR
      if (captured.size > 0) await new Promise((r) => setTimeout(r, 3000));

      for (const m3u8 of captured) {
        allStreams.push({
          name: `HerumHai 🎬 Auto • 4KHDHub · ${provider.name}`,
          description: `🍿 ${title}\n📡 HLS Stream\n🛰️ Source: 4KHDHub · ${provider.name}`,
          url: m3u8,
          behaviorHints: {
            notWebReady: false,
            proxyHeaders: {
              request: {
                'User-Agent': USER_AGENT,
                'Referer': new URL(embedUrl).origin + '/',
              },
            },
          },
          sourceSlug: '4khdhub',
        });
      }

      console.log(`  [4khdhub:embeds:${provider.name}] ${captured.size} streams captured`);
    } catch (e) {
      console.log(`  [4khdhub:embeds:${provider.name}] error: ${e.message}`);
    } finally {
      if (page) await page.close().catch(() => {});
    }

    // Stop early if we have enough streams
    if (allStreams.length >= 3) break;
  }

  console.log(`  [4khdhub:embeds] total: ${allStreams.length} streams from browser providers`);
  return allStreams;
}

export async function closeBrowser() {
  if (_browser) {
    await _browser.close().catch(() => {});
    _browser = null;
  }
}
