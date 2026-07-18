// ============================================================================
// sources/4khdhub.js — 4KHDHub.store Scraper (FSL streams via videasy.to player)
// ----------------------------------------------------------------------------
// Reverse-engineered from 4KHDHub.store's videasy.to player.
//
// Flow:
//   1. Open 4khdhub.store/watch/{tmdb_id} in browser
//   2. Hook JSON.parse to capture decrypted stream data
//   3. The player calls api.speedracelight.com (encrypted) → videasy.to decrypts
//   4. Player calls JSON.parse with decrypted {sources:[{url:"...master.m3u8"}]}
//   5. We capture that URL → return as HLS stream
//
// The HLS stream requires Referer: https://player.videasy.to/
// ============================================================================

import puppeteer from 'puppeteer';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

let _browser = null;

async function getBrowser() {
  if (_browser && _browser.connected) return _browser;
  _browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--single-process',
    ],
    defaultViewport: { width: 1366, height: 768 },
  });
  return _browser;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Scrape 4KHDHub.store for a movie/series
 * @param {string} title - Movie title for search
 * @param {string} imdbId - IMDb ID (tt1375666)
 * @param {string} type - 'movie' or 'series'
 * @param {number|null} season - Season number (for series)
 * @param {number|null} episode - Episode number (for series)
 * @returns {Promise<Array>} Array of stream objects
 */
export async function scrape4KHDHub(title, imdbId, type = 'movie', season = null, episode = null) {
  if (!title && !imdbId) return [];

  const browser = await getBrowser();
  const page = await browser.newPage();
  await page.setUserAgent(USER_AGENT);

  const capturedStreams = [];

  // Hook JSON.parse in ALL frames to capture decrypted stream data
  await page.evaluateOnNewDocument(() => {
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
    const searchUrl = `https://4khdhub.store/search?q=${encodeURIComponent(title || imdbId)}`;
    console.log(`  [4khdhub] searching: ${searchUrl.slice(0, 80)}`);
    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(3000);

    // Find the watch link
    const watchLinks = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a[href]'))
        .map((a) => a.href)
        .filter((href) => href.includes('/watch/') || href.includes('/movie/') || href.includes('/series/'))
        .slice(0, 5);
    });

    if (watchLinks.length === 0) {
      console.log(`  [4khdhub] no results found`);
      return [];
    }

    // Step 2: Open the watch page
    const watchUrl = watchLinks[0];
    console.log(`  [4khdhub] opening: ${watchUrl.slice(0, 80)}`);
    await page.goto(watchUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(5000);

    // Step 3: Click play to trigger the player
    await page.mouse.click(640, 360);
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
    await sleep(5000);

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
                    notWebReady: false, // HLS streams are web-ready
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

    console.log(`  [4khdhub] found ${capturedStreams.length} streams`);
    return capturedStreams;
  } catch (e) {
    console.log(`  [4khdhub] error: ${e.message}`);
    return [];
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
