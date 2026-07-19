// ============================================================================
// sources/hdghartv.js — HDGharTV.cc Scraper
// ----------------------------------------------------------------------------
// HDGharTV uses:
//   - REST API: /api/movies/public?page=1&limit=50&search={query}
//   - Movie detail: /api/movies/public/{id}
//   - Watch page: /watch (SPA that loads HLS player)
//   - CDN: cdn3.streamraiwind.stream (HLS with token)
//
// Flow:
//   1. Search via API to find movie ID
//   2. Open /movie/{id} page in browser
//   3. Click "Play Now" button
//   4. Capture HLS stream URL from network traffic
//   5. Return with proxyHeaders (Referer: https://hdghartv.cc/)
// ============================================================================

import puppeteer from 'puppeteer';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const API_BASE = 'https://hdghartv.cc/api';

/**
 * Search HDGharTV for a movie
 */
async function searchMovie(title) {
  try {
    const res = await fetch(`${API_BASE}/movies/public?page=1&limit=50&search=${encodeURIComponent(title)}`, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.data?.[0] || null;
  } catch (e) {
    console.log(`  [hdghartv] search error: ${e.message}`);
    return null;
  }
}

/**
 * Scrape HDGharTV for a movie/series
 */
export async function scrapeHDGharTV(title, imdbId, type = 'movie', season = null, episode = null) {
  if (!title) return [];

  // Step 1: Search via API
  console.log(`  [hdghartv] searching API for: ${title}`);
  const movie = await searchMovie(title);
  if (!movie) {
    console.log(`  [hdghartv] no results`);
    return [];
  }
  console.log(`  [hdghartv] found: ${movie.title} (ID: ${movie._id})`);

  // Step 2: Open in browser and capture HLS stream
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',  '--disable-gpu'],
  });

  const page = await browser.newPage();
  await page.setUserAgent(USER_AGENT);

  let streamUrl = null;

  // Capture HLS stream URL from network traffic
  page.on('response', async (res) => {
    const url = res.url();
    if (url.includes('.m3u8') && url.includes('streamraiwind') && !streamUrl) {
      streamUrl = url;
      console.log(`  [hdghartv] ✅ HLS stream: ${url.slice(0, 100)}...`);
    }
  });

  try {
    // Open movie page
    await page.goto(`https://hdghartv.cc/movie/${movie._id}`, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise((r) => setTimeout(r, 3000));

    // Click "Play Now" button
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes('Play Now'));
      if (btn) btn.click();
    });
    await new Promise((r) => setTimeout(r, 10000));

    if (streamUrl) {
      console.log(`  [hdghartv] ✅ Stream captured!`);
      return [{
        name: `HerumHai 🎯 Auto • HDGharTV`,
        description: `🍿 ${movie.title}\n🎥 HLS Stream\n🛰️ Source: HDGharTV`,
        url: streamUrl,
        behaviorHints: {
          notWebReady: false, // HLS is web-ready
          proxyHeaders: {
            request: {
              'User-Agent': USER_AGENT,
              'Referer': 'https://hdghartv.cc/',
            },
          },
        },
        sourceSlug: 'hdghartv',
      }];
    }
  } catch (e) {
    console.log(`  [hdghartv] error: ${e.message}`);
  } finally {
    await browser.close().catch(() => {});
  }

  return [];
}
