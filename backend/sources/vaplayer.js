// ============================================================================
// sources/vaplayer.js — VAPlayer Scraper (Puppeteer-based, CF bypass)
// ----------------------------------------------------------------------------
// VAPlayer is one of PenguPlay's main sources (9 of 21 streams for Inception).
// It uses vaplayer.ru → nextgencloudfabric.com → app.putgate.com / onlinevisibilitysystem.site
//
// Flow:
//   1. Launch puppeteer with stealth (navigator.webdriver=undefined, etc.)
//   2. Navigate to nextgencloudfabric.com/embed/movie/{imdbId}
//   3. Wait 6 seconds for Cloudflare auto-approval
//   4. If CF challenge, wait 8 more seconds + reload
//   5. Click play button to trigger stream loading
//   6. Capture .m3u8 URLs from network traffic
//   7. Return as HLS streams
//
// This is the SAME approach PenguPlay uses — puppeteer + CF bypass + network capture.
// ============================================================================

import puppeteer from 'puppeteer';
import { scrapeUniversalEmbeds } from './universal_embeds.js';
import { detectQuality } from './hubcloud.js';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

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
      '--disable-features=IsolateOrigins,site-per-process',
    ],
    defaultViewport: { width: 1920, height: 1080 },
  });
  return _browser;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Scrape VAPlayer for a movie/series/anime
 * @param {string} title     - Movie title (for display)
 * @param {string} imdbId    - IMDB ID (tt1375666)
 * @param {string} type      - 'movie' | 'series' | 'anime'
 * @param {number|null} season
 * @param {number|null} episode
 * @returns {Promise<Array>} Array of stream objects
 */
export async function scrapeVAPlayer(title, imdbId, type = 'movie', season = null, episode = null) {
  if (!imdbId) {
    console.log(`  [vaplayer] no IMDB ID — cannot scrape`);
    return [];
  }

  // Build the embed URL
  const embedPath = type === 'movie'
    ? `/embed/movie/${imdbId}`
    : `/embed/tv/${imdbId}/${season || 1}/${episode || 1}`;
  const embedUrl = `https://nextgencloudfabric.com${embedPath}`;

  console.log(`  [vaplayer] → ${embedUrl.slice(0, 80)}`);

  const browser = await getBrowser();
  const page = await browser.newPage();
  await page.setUserAgent(USER_AGENT);
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://vaplayer.ru/',
  });

  // Anti-bot overrides (same as PenguPlay)
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
  });

  const m3u8Urls = new Set();
  const putgateUrls = new Set();

  // Capture ALL network responses — .m3u8 + putgate + JSON API scanning
  page.on('response', async (resp) => {
    try {
      const url = resp.url();
      // 1. Direct .m3u8 URLs
      if (/\.m3u8(\?|$)/i.test(url)) {
        if (!m3u8Urls.has(url)) {
          m3u8Urls.add(url);
          console.log(`  [vaplayer] ✓ HLS captured: ${url.slice(0, 80)}`);
        }
        return;
      }
      // 2. putgate.com / onlinevisibilitysystem.site URLs (return m3u8 playlists)
      if (url.includes('putgate.com') || url.includes('onlinevisibilitysystem.site') || url.includes('cdnstr')) {
        if (!putgateUrls.has(url)) {
          putgateUrls.add(url);
          console.log(`  [vaplayer] ✓ Stream URL captured: ${url.slice(0, 80)}`);
        }
        return;
      }
      // 3. Scan JSON/text API responses for embedded .m3u8 URLs
      if (/\/api\/|\/ajax\/|\/sources?\b|\.json/i.test(url)) {
        const ct = resp.headers()['content-type'] || '';
        if (ct.includes('json') || ct.includes('text')) {
          try {
            const body = await resp.text();
            const re = /https?:\/\/[^\s"'<>\]\\\)]+\.m3u8(?:\?[^\s"'<>\]\\\)]*)?/gi;
            let m;
            while ((m = re.exec(body)) !== null) {
              if (!m3u8Urls.has(m[0])) {
                m3u8Urls.add(m[0]);
                console.log(`  [vaplayer] ✓ HLS from JSON API: ${m[0].slice(0, 80)}`);
              }
            }
          } catch {}
        }
      }
    } catch {}
  });

  try {
    await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });

    // CLOUDFLARE BYPASS — same as PenguPlay:
    // 1. Wait 6 seconds for CF Turnstile to self-verify
    await sleep(6000);

    let pageTitle = await page.title().catch(() => '');
    if (/just a moment|cloudflare|attention required|checking your browser/i.test(pageTitle)) {
      console.log(`  [vaplayer] CF challenge detected — waiting 8 more seconds...`);
      await sleep(8000);
      pageTitle = await page.title().catch(() => '');
      if (/just a moment|cloudflare/i.test(pageTitle)) {
        console.log(`  [vaplayer] CF still blocking — trying page reload...`);
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
        await sleep(6000);
      }
    }

    // Click play button to trigger stream loading
    await page.evaluate(() => {
      document.querySelectorAll('button, [role=button], [class*=play], [class*=server], [class*=quality]').forEach((el) => {
        try { el.click(); } catch {}
      });
    });
    await sleep(8000);

    // Try clicking again (some players need 2 clicks)
    await page.evaluate(() => {
      document.querySelectorAll('button, [role=button], [class*=play], [class*=server]').forEach((el) => {
        try { el.click(); } catch {}
      });
    });
    await sleep(5000);

    console.log(`  [vaplayer] captured ${m3u8Urls.size} HLS URLs, ${putgateUrls.size} putgate URLs`);

    // Build stream objects
    const streams = [];
    for (const url of [...m3u8Urls, ...putgateUrls]) {
      const quality = detectQuality(url);
      streams.push({
        name: `HerumHai 🎬 ${quality.label} • VAPlayer`,
        description: `🍿 ${title}\n📡 HLS Stream\n🛰️ Source: VAPlayer`,
        url,
        behaviorHints: {
          notWebReady: false,
          proxyHeaders: {
            request: {
              'User-Agent': USER_AGENT,
              'Referer': 'https://nextgencloudfabric.com/',
            },
          },
        },
        sourceSlug: 'vaplayer',
      });
    }

    console.log(`  [vaplayer] ✓ ${streams.length} streams`);
    if (streams.length > 0) return streams;
    
    // Fallback: universal embed (xpass.top) if puppeteer failed
    console.log(`  [vaplayer] puppeteer returned 0 — using universal embed fallback`);
    return scrapeUniversalEmbeds(title, imdbId, type, season, episode);
  } catch (e) {
    console.log(`  [vaplayer] error: ${e.message} — using universal embed fallback`);
    return scrapeUniversalEmbeds(title, imdbId, type, season, episode);
  } finally {
    await page.close().catch(() => {});
  }
}

export async function closeBrowser() {
  if (_browser) {
    await _browser.close().catch(() => {});
    _browser = null;
  }
}
