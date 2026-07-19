// ============================================================================
// sources/new_sources.js — New Source Scrapers (movieseq, cinewave, tatvamovies)
// ----------------------------------------------------------------------------
// All 3 sites use the same underlying embed providers:
//   - movieseq.com → /embed/movie/{tmdbId} → nextgencloudfabric.com (VAPlayer)
//   - watch.cinewave.qzz.io → SPA → 2embed.cc, airflix1.com, cinemaos.tech, etc.
//   - tatvamovies.vercel.app → nxsha.space + vaplayer.ru embeds
//
// Since these all use TMDB-ID-based embeds, we can resolve IMDB→TMDB and call
// the embed providers directly. We use puppeteer to render the embed pages
// and capture .m3u8 URLs from network traffic (same as PenguPlay).
// ============================================================================

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version:17.0 Mobile/15E148 Safari/604.1';
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const TMDB_API_KEY = '6b2dec73b6697866a50cdaef60ccffcb';

// ---------------------------------------------------------------------------
// TMDB ID resolution (IMDB → TMDB)
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

// (curlGet removed — using puppeteer instead)

// ---------------------------------------------------------------------------
// MoviesEQ scraper — movieseq.com
// ----------------------------------------------------------------------------
// Flow:
//   1. Resolve IMDB → TMDB ID
//   2. Fetch https://movieseq.com/embed/movie/{tmdbId}
//   3. The page embeds nextgencloudfabric.com (same as VAPlayer)
//   4. Use puppeteer to render + capture .m3u8 URLs
// ---------------------------------------------------------------------------
import puppeteer from 'puppeteer';

let _browser = null;
async function getBrowser() {
  if (_browser && _browser.connected) return _browser;
  _browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process', '--disable-blink-features=AutomationControlled'],
    defaultViewport: { width: 1920, height: 1080 },
  });
  return _browser;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function scrapeWithPuppeteer(embedUrl, sourceName, title, referer) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  await page.setUserAgent(DESKTOP_UA);
  if (referer) await page.setExtraHTTPHeaders({ Referer: referer, 'Accept-Language': 'en-US,en;q=0.9' });

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  });

  const m3u8Urls = new Set();
  page.on('response', (resp) => {
    const url = resp.url();
    if (/\.m3u8(\?|$)/i.test(url) || url.includes('putgate.com') || url.includes('onlinevisibilitysystem.site') || url.includes('cdnstr')) {
      m3u8Urls.add(url);
      console.log(`  [${sourceName}] ✓ stream captured: ${url.slice(0, 80)}`);
    }
  });

  try {
    await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(6000); // CF bypass: 6s wait

    let pageTitle = await page.title().catch(() => '');
    if (/just a moment|cloudflare|attention required/i.test(pageTitle)) {
      console.log(`  [${sourceName}] CF challenge — waiting 8s + reload`);
      await sleep(8000);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      await sleep(6000);
    }

    // Click play
    await page.evaluate(() => {
      document.querySelectorAll('button, [role=button], [class*=play], [class*=server]').forEach((el) => { try { el.click(); } catch {} });
    });
    await sleep(5000);

    const streams = [...m3u8Urls].map((url) => ({
      name: `HerumHai 🎬 Auto • ${sourceName}`,
      description: `🍿 ${title}\n📡 HLS Stream\n🛰️ Source: ${sourceName}`,
      url,
      behaviorHints: { notWebReady: false, proxyHeaders: { request: { 'User-Agent': DESKTOP_UA, 'Referer': new URL(embedUrl).origin + '/' } } },
      sourceSlug: sourceName.toLowerCase().replace(/\s/g, '_'),
    }));

    console.log(`  [${sourceName}] ✓ ${streams.length} streams`);
    return streams;
  } catch (e) {
    console.log(`  [${sourceName}] error: ${e.message}`);
    return [];
  } finally {
    await page.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// MoviesEQ — movieseq.com/embed/movie/{tmdbId}
// ---------------------------------------------------------------------------
export async function scrapeMoviesEQ(title, imdbId, type = 'movie', season = null, episode = null) {
  if (!imdbId) return [];
  const tmdbId = await resolveTmdbId(imdbId, type);
  if (!tmdbId) { console.log(`  [movieseq] could not resolve TMDB ID`); return []; }

  const embedPath = type === 'movie' ? `/embed/movie/${tmdbId}` : `/embed/tv/${tmdbId}/${season || 1}/${episode || 1}`;
  const embedUrl = `https://movieseq.com${embedPath}`;
  console.log(`  [movieseq] → ${embedUrl.slice(0, 80)}`);
  return scrapeWithPuppeteer(embedUrl, 'MoviesEQ', title, 'https://movieseq.com/');
}

// ---------------------------------------------------------------------------
// CineWave — watch.cinewave.qzz.io
// ----------------------------------------------------------------------------
// CineWave is an SPA that uses multiple embed providers:
//   2embed.cc, airflix1.com, cinemaos.tech, 111movies.net, fmovies.gd, hexa.su, mappletv.uk
// We try 2embed.cc first (same as our universal embed via xpass.top),
// then airflix1.com, then cinemaos.tech.
// ---------------------------------------------------------------------------
export async function scrapeCineWave(title, imdbId, type = 'movie', season = null, episode = null) {
  if (!imdbId) return [];
  console.log(`  [cinewave] → using 2embed.cc + airflix1.com embeds`);

  // CineWave uses 2embed.cc which we already handle via universal_embeds (xpass.top)
  // But let's also try airflix1.com directly with puppeteer
  const tmdbId = await resolveTmdbId(imdbId, type);
  if (!tmdbId) { console.log(`  [cinewave] could not resolve TMDB ID`); return []; }

  const embedPath = type === 'movie' ? `/movie/${tmdbId}` : `/tv/${tmdbId}/${season || 1}/${episode || 1}`;

  // Try airflix1.com (CineWave's primary embed provider)
  const airflixUrl = `https://airflix1.com${embedPath}`;
  console.log(`  [cinewave] → ${airflixUrl.slice(0, 80)}`);
  const streams = await scrapeWithPuppeteer(airflixUrl, 'CineWave', title, 'https://watch.cinewave.qzz.io/');

  // Also try cinemaos.tech
  if (streams.length === 0) {
    const cinemaosUrl = `https://cinemaos.tech${embedPath}`;
    console.log(`  [cinewave] → ${cinemaosUrl.slice(0, 80)}`);
    return scrapeWithPuppeteer(cinemaosUrl, 'CineWave', title, 'https://watch.cinewave.qzz.io/');
  }

  return streams;
}

// ---------------------------------------------------------------------------
// TatvaMovies — tatvamovies.vercel.app
// ----------------------------------------------------------------------------
// TatvaMovies uses 2 servers:
//   Server 1: nxsha.space/embed/movie/{tmdbId}
//   Server 2: vaplayer.ru/embed/movie/{imdbId}
// We try both with puppeteer.
// ---------------------------------------------------------------------------
export async function scrapeTatvaMovies(title, imdbId, type = 'movie', season = null, episode = null) {
  if (!imdbId) return [];
  const tmdbId = await resolveTmdbId(imdbId, type);
  if (!tmdbId) { console.log(`  [tatvamovies] could not resolve TMDB ID`); return []; }

  const moviePath = type === 'movie' ? `/movie/${tmdbId}` : `/tv/${tmdbId}/${season || 1}/${episode || 1}`;
  const imdbPath = type === 'movie' ? `/movie/${imdbId}` : `/tv/${imdbId}/${season || 1}/${episode || 1}`;

  // Server 1: nxsha.space (TMDB-based)
  const nxshaUrl = `https://nxsha.space/embed${moviePath}`;
  console.log(`  [tatvamovies] → ${nxshaUrl.slice(0, 80)}`);
  let streams = await scrapeWithPuppeteer(nxshaUrl, 'TatvaMovies', title, 'https://tatvamovies.vercel.app/');

  // Server 2: vaplayer.ru (IMDB-based) — only if Server 1 returned 0
  if (streams.length === 0) {
    const vaplayerUrl = `https://vaplayer.ru/embed${imdbPath}`;
    console.log(`  [tatvamovies] → ${vaplayerUrl.slice(0, 80)}`);
    streams = await scrapeWithPuppeteer(vaplayerUrl, 'TatvaMovies', title, 'https://tatvamovies.vercel.app/');
  }

  return streams;
}

export async function closeBrowser() {
  if (_browser) {
    await _browser.close().catch(() => {});
    _browser = null;
  }
}
