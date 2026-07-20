// ============================================================================
// api/stream.js — HerumHai Stream Resolver (PenguPlay Proxy + 24 Extra Scrapers)
// ----------------------------------------------------------------------------
// Architecture:
//
//   Stremio request
//        │
//        ├─→ PenguPlay proxy (1s) → returns 21 streams for Inception
//        │
//        └─→ Parallel scrape of 24+ extra sources (15s hard timeout each)
//              ├─ filmhds.com        ├─ hdhub4u.cl
//              ├─ nima4k.org         ├─ trybox.app
//              ├─ animeflix.dad      ├─ moviesleech.asia
//              ├─ allmovieland.one   ├─ overflix.lol
//              ├─ uhdmovies.casa     ├─ vidsrc.win
//              ├─ vegamovie.sn       ├─ worldfree4u.dog
//              ├─ moviescounter.boston ├─ 99hdfilms.com
//              ├─ anitaku.com.ro     ├─ animeheaven.me
//              ├─ animekaizoku.net   ├─ animekai.be
//              ├─ vidsrcme.ru        ├─ acermovies.fun
//              ├─ new4.moviesdrives.my ├─ moviedrive.org
//              └─ moviesmod.at       └─ anighar.cloud
//              ↓
//        Merge: PenguPlay streams + extra scraped streams
//              ↓
//        Return to Stremio (within 30s total)
//
// PenguPlay sources covered (proxy):
//   111477, 4khdhub, cinefreak, aniwaves, moviebox, mkvbase, moviesdrives,
//   vaplayer, videasy, zxcstream, animesuge, aether, artemis, vidlink,
//   vidfast, hdghartv
//
// Extra sources (real-time scrape — NOT in PenguPlay):
//   filmhds, hdhub4u, filmxy, ddlbase, nima4k, trybox, animeflix,
//   moviesleech, allmovieland, overflix, uhdmovies, mkvdrama, vidsrc,
//   fluxtv, bobmovies, katmoviehd, cinemacity, vegamovie, worldfree4u,
//   moviescounter, 99hdfilms, anitaku, animeheaven, animekaizoku, animekai,
//   animeraws, animeout, vidbox, vidsrcme, acermovies, moviesdrives.new4,
//   moviedrive, moviesmod, anighar
// ============================================================================

import { createHmac, randomBytes } from 'node:crypto';

// Import HdHub functions from streams2.js (merged into main stream response)
import {
  fetchHdHubStreams,
  rewriteHdHubStream,
  parseStremioIdHdHub,
} from './streams2.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DIRECT_URL_SECRET =
  process.env.DIRECT_URL_SECRET ||
  'herumhai-dev-secret-' + randomBytes(16).toString('hex');

const PENGU_UPSTREAM = 'https://pengu.uk';
const PENGU_TIMEOUT_MS = 15_000;

// Per-extra-source timeout — sources that don't respond in 12s are skipped
const EXTRA_SOURCE_TIMEOUT_MS = 12_000;
// Total budget for all extra sources (run in parallel, capped at this)
const EXTRA_TOTAL_BUDGET_MS = 20_000;

// 6-second Cloudflare Turnstile self-verification pause (same as PenguPlay)
const CLOUDFLARE_PAUSE_MS = 6_000;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const MIN_MP4_SIZE_BYTES = 50 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Caching Layer (Upstash Redis)
// ----------------------------------------------------------------------------
// When PenguPlay or HdHub go down, we serve streams from cache.
// Cache key: stream:{type}:{id}  →  JSON array of streams
// TTL: 24 hours (streams are re-fetched fresh after that)
//
// Set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN env vars in Vercel.
// If not set, caching is disabled (graceful fallback — we just don't cache).
// ----------------------------------------------------------------------------

const CACHE_TTL_SECONDS = 24 * 60 * 60;  // 24 hours

async function cacheGet(key) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const res = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.result) {
      return JSON.parse(data.result);
    }
    return null;
  } catch (e) {
    console.log(`[cache] get failed: ${e.message}`);
    return null;
  }
}

async function cacheSet(key, value) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return;
  try {
    await fetch(`${url}/set/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ value: JSON.stringify(value), ex: CACHE_TTL_SECONDS }),
      signal: AbortSignal.timeout(3000),
    });
  } catch (e) {
    console.log(`[cache] set failed: ${e.message}`);
  }
}

// HubCloud domain rotation
const HUBCLOUD_DOMAINS = ['hubcloud.cx', 'hubcloud.ist', 'hubcloud.club', 'hubcloud.fans'];

// Honeypot filter
const HONEYPOT_REGEX = new RegExp(
  ['tutorial','how-to','howto','download-guide','guide','sample','trailer','demo',
   'placeholder','loading','spinner','promo','/ads/','advert','banner','logo',
   'favicon','beacon','pixel','sharethis','/analytics/'].join('|'),
  'i'
);

// Stream URL patterns
const STREAM_REGEX = new RegExp(
  ['\\.m3u8(?:\\?|$|/)','\\.mpd(?:\\?|$|/)','\\.mp4(?:\\?|$|/)','\\.ts(?:\\?|$|/)',
   '\\.mkv(?:\\?|$|/)','/hls/','/dash/','/seg-','/playlist','/manifest',
   'hubcloud\\.(?:ist|cx|club|fans)/drive/','gamerxyt\\.com/hubcloud\\.php',
   'video-downloads\\.googleusercontent\\.com',
   'files\\.jiomovies\\.workers\\.dev','lh3\\.googleusercontent\\.com/pw/'].join('|'),
  'i'
);

const HOST_DOMAINS = [
  'hubcloud.ist','hubcloud.cx','hubcloud.club','hubcloud.fans',
  'gamerxyt.com','video-downloads.googleusercontent.com',
  'files.jiomovies.workers.dev','lh3.googleusercontent.com',
  'pixeldrain','streamtape','vidsrc','vidplay','vidmoly','vmwesa.online',
  'gdtot','gdflix','filepress','buzzheavier','doodstream','mixdrop',
  'drive.google.com','docs.google.com',
];

const BLOCK_DOMAINS = [
  'googlesyndication.com','googletagmanager.com','doubleclick.net','google-analytics.com',
  'facebook.com','coinhive.com','adsterra.com','propellerads.com','popads.net',
  'mgid.com','taboola.com','outbrain.com','disqus.com','hotjar.com','sentry.io',
  'cloudflareinsights.com','winexch.com','a-ads.com','adsboosters.xyz','bonuscaf.com',
];

// ---------------------------------------------------------------------------
// PenguPlay Config Builder
// ---------------------------------------------------------------------------

const PENGUPLAY_DEFAULT_SOURCES = [
  'source_4khdhub', 'source_moviebox', 'source_moviesdrives',
  'source_vaplayer', 'source_hdghartv',
];

const ALL_PENGUPLAY_SOURCE_KEYS = [
  'source_111477','source_4khdhub','source_cinefreak','source_aniwaves',
  'source_moviebox','source_mkvbase','source_moviesdrives','source_vaplayer',
  'source_videasy','source_zxcstream','source_animesuge','source_aether',
  'source_artemis','source_vidlink','source_vidfast','source_hdghartv',
];

const ALL_QUALITY_KEYS = ['res_2160', 'res_1080', 'res_720', 'res_480', 'res_360'];
const ALL_AUDIO_KEYS = [
  'audio_english','audio_hindi','audio_tamil','audio_telugu','audio_korean',
  'audio_japanese','audio_chinese','audio_spanish','audio_french','audio_german',
  'audio_italian','audio_portuguese','audio_russian','audio_arabic','audio_thai',
  'audio_vietnamese','audio_malay','audio_indonesian',
];

function buildPenguConfig(userConfig = {}) {
  const config = {};
  for (const key of ALL_PENGUPLAY_SOURCE_KEYS) {
    if (key in userConfig) {
      config[key] = userConfig[key] ? 'checked' : 'unchecked';
    } else {
      config[key] = PENGUPLAY_DEFAULT_SOURCES.includes(key) ? 'checked' : 'unchecked';
    }
  }
  for (const key of ALL_QUALITY_KEYS) {
    config[key] = key in userConfig ? (userConfig[key] ? 'checked' : 'unchecked') : 'checked';
  }
  const defaultAudio = ['audio_english', 'audio_hindi', 'audio_tamil', 'audio_telugu'];
  for (const key of ALL_AUDIO_KEYS) {
    if (key in userConfig) {
      config[key] = userConfig[key] ? 'checked' : 'unchecked';
    } else {
      config[key] = defaultAudio.includes(key) ? 'checked' : 'unchecked';
    }
  }
  config.subtitles_disabled = userConfig.subtitles_disabled ? 'checked' : 'unchecked';
  config.emulate_vpn = userConfig.emulate_vpn ? 'checked' : 'unchecked';
  config.disable_direct = userConfig.disable_direct ? 'checked' : 'unchecked';
  return config;
}

function encodeConfig(config) {
  return Buffer.from(JSON.stringify(config)).toString('base64url');
}

// ---------------------------------------------------------------------------
// PenguPlay Auto-Discovery — fetches PenguPlay's manifest and detects new sources
// If PenguPlay adds a new source, we automatically support it via the proxy.
// This runs once per request (cached for 5 minutes via _penguSourcesCache).
// ----------------------------------------------------------------------------

let _penguSourcesCache = null;
let _penguSourcesCacheTime = 0;
const PENGU_CACHE_TTL_MS = 5 * 60 * 1000;  // 5 minutes

async function getDiscoveredPenguSources() {
  // Return cached if fresh
  if (_penguSourcesCache && Date.now() - _penguSourcesCacheTime < PENGU_CACHE_TTL_MS) {
    return _penguSourcesCache;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(`${PENGU_UPSTREAM}/manifest.json`, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      console.log(`[auto-discover] PenguPlay manifest returned ${res.status}`);
      return _penguSourcesCache || [];
    }

    const data = await res.json();
    const configItems = data.config || [];
    const sources = configItems
      .filter((c) => c.key && c.key.startsWith('source_'))
      .map((c) => ({
        key: c.key,
        slug: c.key.replace('source_', ''),
        name: c.title,
        defaultEnabled: c.default === 'checked',
      }));

    // Check for new sources we don't know about
    const knownSlugs = new Set(ALL_PENGUPLAY_SOURCE_KEYS.map((k) => k.replace('source_', '')));
    const newSources = sources.filter((s) => !knownSlugs.has(s.slug));

    if (newSources.length > 0) {
      console.log(`[auto-discover] ✨ Found ${newSources.length} NEW PenguPlay source(s):`);
      for (const s of newSources) {
        console.log(`[auto-discover]   + ${s.slug} (${s.name}) — auto-enabled via proxy`);
      }
    }

    _penguSourcesCache = sources;
    _penguSourcesCacheTime = Date.now();
    return sources;
  } catch (e) {
    console.log(`[auto-discover] failed: ${e.message}`);
    return _penguSourcesCache || [];
  }
}

// ---------------------------------------------------------------------------
// Extra Sources Registry — 24+ sources NOT in PenguPlay
// ---------------------------------------------------------------------------

const EXTRA_SOURCES = [
  { slug: 'filmhds', name: 'FilmHDS', homepage: 'https://filmhds.com', searchPath: '/?s={query}', type: 'movie_series' },
  { slug: 'hdhub4u', name: 'HDHub4u', homepage: 'https://new2.hdhub4u.cl', searchPath: '/?s={query}', type: 'movie_series' },
  { slug: 'nima4k', name: 'Nima4K', homepage: 'https://nima4k.org', searchPath: '/?s={query}', type: 'movie_series' },
  { slug: 'trybox', name: 'TryBox', homepage: 'https://trybox.app', searchPath: '/search?q={query}', type: 'movie_series' },
  { slug: 'animeflix', name: 'AnimeFlix', homepage: 'https://animeflix.dad', searchPath: '/search?q={query}', type: 'anime' },
  { slug: 'moviesleech', name: 'MoviesLeech', homepage: 'https://moviesleech.asia', searchPath: '/?s={query}', type: 'movie_series' },
  { slug: 'allmovieland', name: 'AllMovieLand', homepage: 'https://allmovieland.one', searchPath: '/?s={query}', type: 'movie_series' },
  { slug: 'overflix', name: 'OverFlix', homepage: 'https://overflix.lol', searchPath: '/?s={query}', type: 'movie_series' },
  { slug: 'uhdmovies', name: 'UHDMovies', homepage: 'https://uhdmovies.casa', searchPath: '/?s={query}', type: 'movie_series' },
  { slug: 'vegamovie', name: 'VegaMovie', homepage: 'https://vegamovie.sn', searchPath: '/?s={query}', type: 'movie_series' },
  { slug: 'worldfree4u', name: 'WorldFree4u', homepage: 'https://worldfree4u.dog', searchPath: '/?s={query}', type: 'movie_series' },
  { slug: 'moviescounter', name: 'MoviesCounter', homepage: 'https://moviescounter.boston', searchPath: '/?s={query}', type: 'movie_series' },
  { slug: '99hdfilms', name: '99HD Films', homepage: 'https://www.99hdfilms.com', searchPath: '/?s={query}', type: 'movie_series' },
  { slug: 'anitaku', name: 'AniTaku', homepage: 'https://anitaku.com.ro', searchPath: '/search.html?keyword={query}', type: 'anime' },
  { slug: 'animeheaven', name: 'AnimeHeaven', homepage: 'https://animeheaven.me', searchPath: '/search?q={query}', type: 'anime' },
  { slug: 'animekaizoku', name: 'AnimeKaizoku', homepage: 'https://animekaizoku.net', searchPath: '/?s={query}', type: 'anime' },
  { slug: 'animekai', name: 'AnimeKai', homepage: 'https://animekai.be', searchPath: '/search?q={query}', type: 'anime' },
  { slug: 'vidsrcme', name: 'VidSrc.me', homepage: 'https://vidsrcme.ru', searchPath: '/embed/movie/{imdb}', type: 'embed' },
  { slug: 'acermovies', name: 'AcerMovies', homepage: 'https://acermovies.fun', searchPath: '/?s={query}', type: 'movie_series' },
  { slug: 'moviesdrives_new4', name: 'MoviesDrives (New4)', homepage: 'https://new4.moviesdrives.my', searchPath: '/?s={query}', type: 'movie_series' },
  { slug: 'moviedrive', name: 'MovieDrive', homepage: 'https://moviedrive.org', searchPath: '/?s={query}', type: 'movie_series' },
  { slug: 'moviesmod', name: 'MoviesMod', homepage: 'https://moviesmod.at', searchPath: '/?s={query}', type: 'movie_series' },
  { slug: 'anighar', name: 'AniGhar', homepage: 'https://anighar.cloud', searchPath: '/?s={query}', type: 'anime' },
  // New anime sources
  { slug: 'skyanime', name: 'SkyAnime', homepage: 'https://iamlegend.vercel.app', searchPath: '/search?q={query}', type: 'anime' },
  { slug: 'animesky', name: 'AnimeSky', homepage: 'https://animesky.top', searchPath: '/?s={query}', type: 'anime' },
  // Embed sources that resolve via HLS (fast)
  { slug: 'vidsrc', name: 'VidSrc', homepage: 'https://vidsrc.win', searchPath: '/embed/movie/{imdb}', type: 'embed' },
  { slug: 'vidbox', name: 'VidBox', homepage: 'https://vidbox.dev', searchPath: '/embed/movie/{imdb}', type: 'embed' },
  { slug: '2embed', name: '2Embed', homepage: 'https://www.2embed.to', searchPath: '/embed/{imdb}', type: 'embed' },
  { slug: 'gomo', name: 'Gomo', homepage: 'https://gomo.to', searchPath: '/embed/movie/{imdb}', type: 'embed' },
];

// ---------------------------------------------------------------------------
// Browser Launcher — @sparticuz/chromium + puppeteer-core
// Same stealth config as PenguPlay's scraper:
//   - navigator.webdriver = undefined (CF bypass)
//   - window.chrome = { runtime: {} }
//   - 6-second CF Turnstile self-verification pause
//   - Ad/tracker/miner domain blocking at network layer
// Used as fallback when fetch() hits Cloudflare 403/503
// ---------------------------------------------------------------------------

let _browser = null;
let _browserLaunchPromise = null;

async function getBrowser() {
  if (_browser) return _browser;
  if (_browserLaunchPromise) return _browserLaunchPromise;
  _browserLaunchPromise = (async () => {
    try {
      const chromium = (await import('@sparticuz/chromium')).default;
      const puppeteer = (await import('puppeteer-core')).default;
      const executablePath = await chromium.executablePath();
      _browser = await puppeteer.launch({
        args: [
          ...chromium.args,
          '--disable-blink-features=AutomationControlled',
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--disable-infobars',
          '--disable-gpu',
          '--mute-audio',
          '--blink-settings=imagesEnabled=false',
        ],
        defaultViewport: {
          width: 1920, height: 1080, deviceScaleFactor: 1, hasTouch: false, isLandscape: true,
        },
        executablePath,
        headless: chromium.headless,
        ignoreHTTPSErrors: true,
      });
      console.log('[browser] launched stealth chromium');
      return _browser;
    } catch (e) {
      console.log(`[browser] launch failed: ${e.message}`);
      return null;
    } finally {
      _browserLaunchPromise = null;
    }
  })();
  return _browserLaunchPromise;
}

async function browserFetchHtml(url, { referer, timeout = 25_000 } = {}) {
  const browser = await getBrowser();
  if (!browser) return null;

  const page = await browser.newPage();
  await page.setUserAgent(USER_AGENT);
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

  // PenguPlay's anti-bot stack — spoof webdriver, chrome, plugins, languages
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  });

  // Block ad/tracker/miner domains at network layer (PenguPlay pattern)
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = req.url();
    if (BLOCK_DOMAINS.some((d) => u.includes(d))) req.abort();
    else req.continue();
  });

  try {
    const gotoOpts = { waitUntil: 'domcontentloaded', timeout: 40_000 };
    if (referer) {
      await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9', Referer: referer });
    }
    await page.goto(url, gotoOpts);

    // CRITICAL: 6-second Cloudflare Turnstile self-verification pause
    // (exact same as PenguPlay's scraper)
    await new Promise((r) => setTimeout(r, CLOUDFLARE_PAUSE_MS));

    // Check if CF challenge page is still showing
    const title = await page.title().catch(() => '');
    if (/just a moment|cloudflare|attention required/i.test(title)) {
      console.log(`  [browser] CF challenge still active — waiting 8 more seconds`);
      await new Promise((r) => setTimeout(r, 8000));
    }

    return await page.content();
  } catch (e) {
    console.log(`  [browser] fetch failed: ${e.message}`);
    return null;
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Browser Network Interception Scraper — PenguPlay's actual scraping technique.
 *
 * Instead of parsing HTML (which misses JS-loaded streams), this function:
 *   1. Launches stealth Chromium (same config as PenguPlay)
 *   2. Captures ALL network requests for .m3u8/.mp4/.ts/.mkv URLs
 *   3. Navigates: search page → detail page → click play
 *   4. Waits for video player to initialize and request stream segments
 *   5. Returns captured stream URLs with their request headers
 *
 * This is the ONLY reliable way to extract streams from sites that use
 * JS-loaded embed players (vidsrc, 2embed, animeflix, etc.)
 */
async function browserScrapeStreams(url, { referer, timeout = 20_000 } = {}) {
  const browser = await getBrowser();
  if (!browser) return [];

  const page = await browser.newPage();
  await page.setUserAgent(USER_AGENT);
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

  // PenguPlay's anti-bot stack
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  });

  // Capture stream URLs from network traffic (PenguPlay's core technique)
  const capturedStreams = [];
  const seenUrls = new Set();

  // Enable response interception to capture stream URLs
  page.on('response', (response) => {
    try {
      const reqUrl = response.url();
      if (!reqUrl || !reqUrl.startsWith('http')) return;

      // Honeypot filter
      if (HONEYPOT_REGEX.test(reqUrl)) return;
      if (/\/cdn-cgi\//.test(reqUrl)) return;
      if (/\/embed\/(?:movie|tv|anime)\//.test(reqUrl)) return;

      const ct = (response.headers()['content-type'] || '').toLowerCase();
      const rtype = response.request().resourceType();
      if (['script', 'stylesheet', 'image', 'font'].includes(rtype)) return;

      // Check for stream URLs (same patterns as PenguPlay)
      const isMediaCT = /mpegurl|dash\+xml|mp2t|video\/mp4|video\/webm/.test(ct);
      const isMediaURL = STREAM_REGEX.test(reqUrl);
      const isHost = HOST_DOMAINS.some((d) => reqUrl.toLowerCase().includes(d));

      if (!isMediaCT && !isMediaURL && !isHost) return;

      // Size gate for MP4s
      if (reqUrl.toLowerCase().includes('.mp4') || ct === 'video/mp4') {
        const cl = parseInt(response.headers()['content-length'] || '0', 10);
        if (cl && cl < MIN_MP4_SIZE_BYTES) return;
      }

      if (!seenUrls.has(reqUrl)) {
        seenUrls.add(reqUrl);
        const reqHeaders = response.request().headers();
        capturedStreams.push({
          url: reqUrl,
          headers: reqHeaders,
          contentType: ct,
          size: parseInt(response.headers()['content-length'] || '0', 10),
        });
        console.log(`    [net-capture] ${ct.slice(0, 30).padEnd(30)} ${reqUrl.slice(0, 100)}`);
      }
    } catch {}
  });

  // Block ad/tracker domains
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = req.url();
    if (BLOCK_DOMAINS.some((d) => u.includes(d))) req.abort();
    else req.continue();
  });

  try {
    if (referer) {
      await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9', Referer: referer });
    }
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40_000 });

    // 6-second CF Turnstile pause (same as PenguPlay)
    await new Promise((r) => setTimeout(r, CLOUDFLARE_PAUSE_MS));

    const title = await page.title().catch(() => '');
    if (/just a moment|cloudflare|attention required/i.test(title)) {
      console.log(`  [browser-scrape] CF challenge — waiting 8 more seconds`);
      await new Promise((r) => setTimeout(r, 8000));
    }

    // Try clicking play button (search in main page + all iframes)
    const playSelectors = [
      'button.vjs-big-play-button', '.vjs-big-play-button',
      '.jw-icon-display', '.jw-display-icon-container',
      '.plyr__control--overlaid', '.play-button', '.play_btn', '.playbtn',
      "button[aria-label*='Play']", 'video',
    ];
    for (const sel of playSelectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          await el.click({ delay: 50 });
          console.log(`  [browser-scrape] clicked: ${sel}`);
          break;
        }
      } catch {}
    }

    // Try clicking play in iframes
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      for (const sel of playSelectors) {
        try {
          const el = await frame.$(sel);
          if (el) {
            await el.click({ delay: 50 });
            console.log(`  [browser-scrape] clicked iframe: ${sel}`);
            break;
          }
        } catch {}
      }
    }

    // Wait for streams to appear in network traffic
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      if (capturedStreams.length > 0) break;
    }

    console.log(`  [browser-scrape] captured ${capturedStreams.length} streams from network`);
    return capturedStreams;
  } catch (e) {
    console.log(`  [browser-scrape] failed: ${e.message}`);
    return capturedStreams;
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Fetch a page with browser fallback for Cloudflare-protected sources.
 * Same strategy as PenguPlay: try fetch() first (fast), fall back to
 * puppeteer if CF blocks (403/503).
 */
async function fetchHtmlWithBrowserFallback(url, { referer, timeout = 15_000 } = {}) {
  // Try plain fetch first (fast path)
  try {
    const res = await fetchHtml(url, { headers: referer ? { Referer: referer } : {}, timeout });
    if (res.status !== 403 && res.status !== 503) {
      return res;
    }
    console.log(`  [fetch] CF ${res.status} — falling back to browser`);
  } catch (e) {
    console.log(`  [fetch] failed (${e.message}) — falling back to browser`);
  }
  // Fall back to browser
  const html = await browserFetchHtml(url, { referer, timeout: 25_000 });
  if (!html) return { status: 0, headers: {}, body: '', finalUrl: url };
  return { status: 200, headers: {}, body: html, finalUrl: url };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function getBaseUrl(req) {
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  if (process.env.HERUMHAI_BASE_URL) return process.env.HERUMHAI_BASE_URL;
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['host'] || 'herum-hai.vercel.app';
  return `${protocol}://${host}`;
}

async function fetchHtml(url, { headers = {}, timeout = 15_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        ...headers,
      },
      signal: controller.signal,
      redirect: 'follow',
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text, finalUrl: res.url };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// PenguPlay Token Decoder + Re-signer
// ---------------------------------------------------------------------------

function decodePenguToken(tokenB64) {
  try {
    const b64 = tokenB64.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf-8'));
  } catch { return null; }
}

function encodeOurToken(tokenData) {
  return Buffer.from(JSON.stringify(tokenData)).toString('base64url');
}

function signOurPsig(token, filename) {
  const ts = Math.floor(Date.now() / 1000);
  const payload = `${ts}.${token}.${filename}`;
  const sig = createHmac('sha256', DIRECT_URL_SECRET).update(payload).digest('base64url');
  return `${ts}.${sig}`;
}

function rewriteStreamUrl(penguUrl, ourBaseUrl) {
  // Pass through PenguPlay's original URL directly.
  // PenguPlay's /direct/ URLs require their server to proxy the stream
  // (they validate the psig signature server-side and redirect to the CDN).
  // Stremio follows the redirect and plays from the CDN directly.
  // We do NOT wrap in our own /direct/ proxy (Vercel can't stream video).
  return penguUrl;
}

function rewritePenguStream(stream, ourBaseUrl) {
  if (!stream) return stream;
  if (!stream.url) return stream;
  // Replace PenguPlay → HerumHai AND remove 🐧 emoji
  const newName = (stream.name || '')
    .replace(/PenguPlay/g, 'HerumHai')
    .replace(/🐧\s*/g, '')
    .trim();
  const newDescription = (stream.description || '').replace(/PenguPlay/g, 'HerumHai');

  // Pass through PenguPlay's original URL — their server handles the streaming
  // PenguPlay's /direct/{source}/{token}/{filename}?psig= URLs work because:
  //   1. Stremio requests the URL from pengu.uk
  //   2. PenguPlay validates psig, resolves the CDN URL server-side
  //   3. PenguPlay returns a 307 redirect to the actual CDN (Google Drive, etc.)
  //   4. Stremio follows the redirect and plays from the CDN directly
  //   5. Seeking works because the CDN supports Range headers
  //
  // We do NOT add our own proxyHeaders — PenguPlay handles everything server-side.
  // Their proxyHeaders is {} (empty) for a reason: no custom headers needed.
  const bh = stream.behaviorHints || {};

  return {
    ...stream,
    name: newName,
    description: newDescription,
    url: stream.url,  // pass through PenguPlay's original URL
    behaviorHints: bh,  // keep PenguPlay's original behaviorHints (including their proxyHeaders)
  };
}

// ---------------------------------------------------------------------------
// PenguPlay Upstream Fetcher
// ---------------------------------------------------------------------------

async function fetchPenguStreams(target, userConfig) {
  const config = buildPenguConfig(userConfig);

  // Auto-discover new PenguPlay sources — NON-BLOCKING
  // Use cached value if available (refreshed every 5 min in background)
  // Don't await if cache is empty — just use what we have
  if (_penguSourcesCache) {
    for (const src of _penguSourcesCache) {
      if (!(src.key in config)) {
        config[src.key] = src.defaultEnabled ? 'checked' : 'unchecked';
      }
    }
  }
  // Trigger background refresh (non-blocking)
  getDiscoveredPenguSources().catch(() => {});

  const configB64 = encodeConfig(config);

  let penguId;
  if (target.type === 'series') {
    penguId = `${target.imdbId}:${target.season}:${target.episode}`;
  } else if (target.type === 'anime') {
    // PenguPlay doesn't support kitsu: IDs — but if we have an IMDb ID, use it
    // (anime content is searched via title → IMDb conversion in resolveStreams)
    if (target.imdbId && target.imdbId.startsWith('tt')) {
      penguId = target.imdbId;
    } else {
      return [];
    }
  } else {
    penguId = target.imdbId;
  }

  const penguUrl = `${PENGU_UPSTREAM}/${configB64}/stream/${target.type}/${penguId}.json`;
  console.log(`[pengu] fetching streams for ${penguId}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PENGU_TIMEOUT_MS);

  try {
    const res = await fetch(penguUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!res.ok) {
      console.error(`[pengu] HTTP ${res.status}`);
      return [];
    }
    const data = await res.json();
    return data.streams || [];
  } catch (e) {
    console.error(`[pengu] fetch failed: ${e.message}`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// HubCloud Resolver (for extra sources that use HubCloud embeds)
// ---------------------------------------------------------------------------

async function resolveHubCloud(hubcloudId) {
  for (const domain of HUBCLOUD_DOMAINS) {
    const landingUrl = `https://${domain}/drive/${hubcloudId}`;
    try {
      const landing = await fetchHtml(landingUrl, {
        headers: { Referer: `https://${domain}/` },
        timeout: 10_000,
      });
      if (landing.status !== 200 || !landing.body) continue;

      const gamerxytMatch = landing.body.match(
        /https?:\/\/gamerxyt\.com\/hubcloud\.php\?host=[^"&\s]+&id=[^"&\s]+&token=[A-Za-z0-9+/=]+/i
      );
      if (!gamerxytMatch) continue;

      const proxy = await fetchHtml(gamerxytMatch[0], {
        headers: { Referer: landingUrl },
        timeout: 10_000,
      });
      const body = proxy.body || '';

      // Pattern 1: Cloudflare Workers
      const workersMatch = body.match(
        /https:\/\/files\.jiomovies\.workers\.dev\/[A-Za-z0-9]+::[A-Za-z0-9]+\/\d+\/[^"'\s<>]+/i
      );
      if (workersMatch) {
        const directUrl = workersMatch[0];
        const fnMatch = directUrl.match(/\/\d+\/(.+)$/);
        const sizeMatch = directUrl.match(/\/(\d+)\//);
        return {
          directUrl,
          filename: fnMatch ? decodeURIComponent(fnMatch[1]) : '',
          fileSize: sizeMatch ? parseInt(sizeMatch[1], 10) : 0,
          cookie: proxy.headers.get('set-cookie') || '',
          cdn: 'workers',
          referer: landingUrl,
        };
      }

      // Pattern 2: GDrive lh3
      const gdriveSrcMatch = body.match(/https:\/\/lh3\.googleusercontent\.com\/pw\/[A-Za-z0-9_\-+=]+/i);
      if (gdriveSrcMatch) {
        return { directUrl: gdriveSrcMatch[0], filename: '', fileSize: 0, cookie: '', cdn: 'gdrive-lh3', referer: landingUrl };
      }

      // Pattern 3: video-downloads.googleusercontent.com
      const gdriveDlMatch = body.match(/https:\/\/video-downloads\.googleusercontent\.com\/[A-Za-z0-9_\-]+/i);
      if (gdriveDlMatch) {
        return { directUrl: gdriveDlMatch[0], filename: '', fileSize: 0, cookie: '', cdn: 'gdrive-dl', referer: landingUrl };
      }
    } catch { continue; }
  }
  return null;
}

function extractHubCloudIds(html) {
  const ids = new Set();
  const re = /hubcloud\.(?:ist|cx|club|fans)\/drive\/([A-Za-z0-9_-]+)/gi;
  let m;
  while ((m = re.exec(html)) !== null) ids.add(m[1]);
  return Array.from(ids);
}

// ---------------------------------------------------------------------------
// Stream Builder for Extra Sources
// ---------------------------------------------------------------------------

function detectQuality(filenameOrUrl) {
  const t = (filenameOrUrl || '').toLowerCase();
  if (/2160p|4k|uhd|remux/.test(t)) return { label: '4K', rank: 2160 };
  if (/1080p|fhd|1080/.test(t)) return { label: '1080p', rank: 1080 };
  if (/720p|hd|720/.test(t)) return { label: '720p', rank: 720 };
  if (/480p|sd|480/.test(t)) return { label: '480p', rank: 480 };
  if (/360p|360/.test(t)) return { label: '360p', rank: 360 };
  return { label: '1080p', rank: 1080 };
}

function detectAudio(filename) {
  const t = (filename || '').toLowerCase();
  const langs = [];
  if (/hindi/i.test(t)) langs.push('Hindi');
  if (/tamil/i.test(t)) langs.push('Tamil');
  if (/telugu/i.test(t)) langs.push('Telugu');
  if (/english/i.test(t)) langs.push('English');
  if (/japanese/i.test(t)) langs.push('Japanese');
  if (/korean/i.test(t)) langs.push('Korean');
  return langs.length > 0 ? langs : ['English'];
}

function formatFileSize(bytes) {
  if (!bytes) return '';
  const gb = bytes / 1024 / 1024 / 1024;
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

function buildExtraStream({ source, title, filename, fileSize, directUrl, cdn, referer, cookie, index }) {
  const quality = detectQuality(filename || directUrl);
  const audio = detectAudio(filename);

  const descLines = [];
  if (title) descLines.push(`🍿 ${title}`);
  const techParts = [quality.label];
  if (/bluray|blueray/i.test(filename)) techParts.push('BluRay');
  if (/web-dl|webdl/i.test(filename)) techParts.push('WEB-DL');
  if (techParts.length > 1) descLines.push(`🎞️ ${techParts.join(' • ')}`);
  descLines.push(`🛰️ Source: ${source.name}`);
  if (fileSize) descLines.push(`💾 ${formatFileSize(fileSize)}`);
  if (audio.length > 0) descLines.push(`🎧 Audio: ${audio.join(', ')}`);

  const snowflake = quality.rank >= 2160 ? '❄️' : quality.rank >= 1080 ? '🎯' : '📺';
  const name = `HerumHai ${snowflake} ${quality.label} • ${source.name}`;

  // CRITICAL FIX: Return the direct CDN URL directly — do NOT wrap in /direct/ proxy.
  // Vercel serverless functions can't stream video (returns 302 SSO redirect).
  // Stremio's player handles proxyHeaders natively — it sends the correct
  // Referer/User-Agent/Cookie when fetching the stream.
  return {
    name,
    description: descLines.join('\n'),
    url: directUrl,  // direct CDN URL — no proxy
    behaviorHints: {
      notWebReady: true,
      filename: filename || `${title || source.slug}.mp4`,
      proxyHeaders: {
        request: {
          'User-Agent': USER_AGENT,
          ...(referer ? { Referer: referer } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
      },
      bingeGroup: `herumhai-${source.slug}-${cdn}-${quality.label}-${index}`,
    },
  };
}

// Mutable ref for base URL (set per-request)
let _baseUrlRef = '';
function setBaseUrl(url) { _baseUrlRef = url; }
function getBaseUrlRef() { return _baseUrlRef || 'https://herum-hai.vercel.app'; }

// ---------------------------------------------------------------------------
// Bespoke Scrapers — PenguPlay-style per-source implementations
// ----------------------------------------------------------------------------
// Each scraper knows exactly how to find streams for its source.
// These run INDEPENDENTLY of PenguPlay/HdHub — if those go down, these still work.
// ----------------------------------------------------------------------------

/**
 * VidSrc bespoke scraper
 * Pattern: vidsrc.win/embed/movie/{imdb} → iframe chain → .m3u8 / .mp4
 * Uses browser network interception (same as PenguPlay's technique)
 */
async function scrapeVidSrc(target) {
  const embedUrl = target.type === 'series'
    ? `https://vidsrc.win/embed/tv/${target.imdbId}/${target.season}/${target.episode}`
    : `https://vidsrc.win/embed/movie/${target.imdbId}`;
  console.log(`  [bespoke:vidsrc] → ${embedUrl.slice(0, 80)}`);
  return browserScrapeStreams(embedUrl, { referer: 'https://vidsrc.win/' });
}

/**
 * 2Embed bespoke scraper
 * Pattern: 2embed.to/embed/{imdb} → iframe → .m3u8 / .mp4
 */
async function scrape2Embed(target) {
  const embedUrl = target.type === 'series'
    ? `https://www.2embed.to/embed/tv/${target.imdbId}/${target.season}/${target.episode}`
    : `https://www.2embed.to/embed/${target.imdbId}`;
  console.log(`  [bespoke:2embed] → ${embedUrl.slice(0, 80)}`);
  return browserScrapeStreams(embedUrl, { referer: 'https://www.2embed.to/' });
}

/**
 * AnimeFlix bespoke scraper
 * Pattern: animeflix.dad/search?q={title} → detail → .m3u8 HLS
 */
async function scrapeAnimeFlix(target, title) {
  if (!title) return [];
  const searchUrl = `https://animeflix.dad/search?q=${encodeURIComponent(title)}`;
  console.log(`  [bespoke:animeflix] → ${searchUrl.slice(0, 80)}`);
  // Search → find detail → scrape streams
  const searchHtml = await fetchHtmlWithBrowserFallback(searchUrl, { timeout: 12_000 });
  if (!searchHtml.body) return [];
  // Find first anime detail link
  const detailMatch = searchHtml.body.match(/href="(\/(?:anime|watch|series)\/[^"]+)"/i);
  if (!detailMatch) return [];
  const detailUrl = `https://animeflix.dad${detailMatch[1]}`;
  console.log(`  [bespoke:animeflix] → detail: ${detailUrl.slice(0, 80)}`);
  return browserScrapeStreams(detailUrl, { referer: searchUrl });
}

/**
 * VidSrc.me bespoke scraper
 * Pattern: vidsrc.me/embed/{imdb}/ → direct .mp4 / .m3u8
 */
async function scrapeVidSrcMe(target) {
  const embedUrl = `https://vidsrc.me/embed/${target.imdbId}/`;
  console.log(`  [bespoke:vidsrcme] → ${embedUrl.slice(0, 80)}`);
  return browserScrapeStreams(embedUrl, { referer: 'https://vidsrc.me/' });
}

/**
 * Gomo bespoke scraper
 * Pattern: gomo.to/embed/movie/{imdb} → iframe → .m3u8
 */
async function scrapeGomo(target) {
  const embedUrl = `https://gomo.to/embed/movie/${target.imdbId}`;
  console.log(`  [bespoke:gomo] → ${embedUrl.slice(0, 80)}`);
  return browserScrapeStreams(embedUrl, { referer: 'https://gomo.to/' });
}

// ---------------------------------------------------------------------------
// Per-Source Scraper (HubCloud + direct stream extraction)
// ---------------------------------------------------------------------------

async function scrapeExtraSource(source, target, title) {
  const query = title || target.imdbId || target.kitsuId;
  if (!query) return [];

  // Route to bespoke scrapers first (PenguPlay-style per-source implementations)
  // These run INDEPENDENTLY of PenguPlay/HdHub — they work even if those are down
  if (source.slug === 'vidsrc') {
    const captured = await scrapeVidSrc(target);
    if (captured.length > 0) {
      return captured.slice(0, 3).map((cap, i) => buildExtraStream({
        source, title, filename: '', fileSize: cap.size || 0,
        directUrl: cap.url, cdn: 'vidsrc', referer: cap.headers.referer || '',
        cookie: cap.headers.cookie || '', index: i + 1,
      }));
    }
  }
  if (source.slug === '2embed') {
    const captured = await scrape2Embed(target);
    if (captured.length > 0) {
      return captured.slice(0, 3).map((cap, i) => buildExtraStream({
        source, title, filename: '', fileSize: cap.size || 0,
        directUrl: cap.url, cdn: '2embed', referer: cap.headers.referer || '',
        cookie: cap.headers.cookie || '', index: i + 1,
      }));
    }
  }
  if (source.slug === 'animeflix' && target.type === 'anime') {
    const captured = await scrapeAnimeFlix(target, title);
    if (captured.length > 0) {
      return captured.slice(0, 3).map((cap, i) => buildExtraStream({
        source, title, filename: '', fileSize: cap.size || 0,
        directUrl: cap.url, cdn: 'animeflix', referer: cap.headers.referer || '',
        cookie: cap.headers.cookie || '', index: i + 1,
      }));
    }
  }
  if (source.slug === 'vidsrcme') {
    const captured = await scrapeVidSrcMe(target);
    if (captured.length > 0) {
      return captured.slice(0, 3).map((cap, i) => buildExtraStream({
        source, title, filename: '', fileSize: cap.size || 0,
        directUrl: cap.url, cdn: 'vidsrcme', referer: cap.headers.referer || '',
        cookie: cap.headers.cookie || '', index: i + 1,
      }));
    }
  }
  if (source.slug === 'gomo') {
    const captured = await scrapeGomo(target);
    if (captured.length > 0) {
      return captured.slice(0, 3).map((cap, i) => buildExtraStream({
        source, title, filename: '', fileSize: cap.size || 0,
        directUrl: cap.url, cdn: 'gomo', referer: cap.headers.referer || '',
        cookie: cap.headers.cookie || '', index: i + 1,
      }));
    }
  }

  let searchUrl;
  if (source.type === 'embed') {
    searchUrl = source.homepage + source.searchPath
      .replace('{imdb}', target.imdbId || '')
      .replace('{kitsu}', target.kitsuId || '');
  } else {
    searchUrl = source.homepage + source.searchPath.replace('{query}', encodeURIComponent(query));
  }

  console.log(`  [extra:${source.slug}] → ${searchUrl.slice(0, 120)}`);

  // Use PenguPlay-style fetch with browser fallback for Cloudflare-protected sites
  const searchRes = await fetchHtmlWithBrowserFallback(searchUrl, {
    referer: source.homepage,
    timeout: 12_000,
  });
  let searchHtml = searchRes.body || '';

  if (!searchHtml) {
    console.log(`  [extra:${source.slug}] no HTML returned`);
    return [];
  }

  // Extract HubCloud IDs (primary strategy — same as PenguPlay)
  let hubcloudIds = extractHubCloudIds(searchHtml);

  // For embed sources, extract direct stream URLs (.m3u8, .mp4, etc.)
  const directStreams = [];
  if (source.type === 'embed') {
    const streamUrls = searchHtml.match(STREAM_REGEX) || [];
    for (const urlMatch of streamUrls) {
      const fullUrlMatch = searchHtml.match(new RegExp('https?://[^"\'\\s<>]*' + urlMatch.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&').slice(0, 30), 'i'));
      if (fullUrlMatch && !HONEYPOT_REGEX.test(fullUrlMatch[0])) {
        directStreams.push(fullUrlMatch[0]);
      }
    }
  }

  // Find detail page (for non-embed sources) — more HubCloud IDs usually there
  if (source.type !== 'embed') {
    const detailLinkMatch = searchHtml.match(
      /href="(https?:\/\/[^"]*(?:\/\d{4}\/|\/movie\/|\/film\/|\/series\/|\/watch\/|\/tv\/|\/episode\/)[^"]+)"/i
    );
    if (detailLinkMatch) {
      try {
        const detailRes = await fetchHtmlWithBrowserFallback(detailLinkMatch[1], {
          referer: searchUrl,
          timeout: 10_000,
        });
        if (detailRes.body) {
          hubcloudIds = [...new Set([...hubcloudIds, ...extractHubCloudIds(detailRes.body)])];
          const detailStreamUrls = detailRes.body.match(STREAM_REGEX) || [];
          for (const urlMatch of detailStreamUrls) {
            const fullUrlMatch = detailRes.body.match(new RegExp('https?://[^"\'\\s<>]*' + urlMatch.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&').slice(0, 30), 'i'));
            if (fullUrlMatch && !HONEYPOT_REGEX.test(fullUrlMatch[0])) {
              directStreams.push(fullUrlMatch[0]);
            }
          }
        }
      } catch {}
    }
  }

  const streams = [];

  // Resolve HubCloud IDs → direct CDN URLs (PenguPlay's exact same flow)
  for (const id of hubcloudIds.slice(0, 3)) {
    try {
      const resolved = await resolveHubCloud(id);
      if (resolved && resolved.directUrl) {
        streams.push(buildExtraStream({
          source,
          title,
          filename: resolved.filename || '',
          fileSize: resolved.fileSize || 0,
          directUrl: resolved.directUrl,
          cdn: resolved.cdn,
          referer: resolved.referer,
          cookie: resolved.cookie,
          index: streams.length + 1,
        }));
      }
    } catch (e) {
      console.log(`  [extra:${source.slug}] hubcloud ${id} failed: ${e.message}`);
    }
  }

  // Add direct streams (m3u8/mp4 from embed sources)
  for (const url of directStreams.slice(0, 2)) {
    if (url.startsWith('https://')) {
      streams.push(buildExtraStream({
        source,
        title,
        filename: '',
        fileSize: 0,
        directUrl: url,
        cdn: 'direct',
        referer: searchUrl,
        cookie: '',
        index: streams.length + 1,
      }));
    }
  }

  console.log(`  [extra:${source.slug}] found ${streams.length} streams from HTML scraping`);

  // FALLBACK: If no streams found via HTML scraping, use PenguPlay's browser
  // network interception technique — launch browser, navigate to the page,
  // click play, and capture .m3u8/.mp4/.ts URLs from network traffic.
  // This is the SAME technique PenguPlay uses server-side.
  if (streams.length === 0) {
    console.log(`  [extra:${source.slug}] no HTML streams — trying browser network capture`);

    // For embed sources, scrape the embed URL directly
    // For movie_series sources, scrape the detail page (if found) or search page
    let browserScrapeUrl;
    if (source.type === 'embed') {
      browserScrapeUrl = searchUrl;
    } else {
      // Try to find detail page link from search HTML
      const detailLinkMatch = searchHtml.match(
        /href="(https?:\/\/[^"]*(?:\/\d{4}\/|\/movie\/|\/film\/|\/series\/|\/watch\/|\/tv\/|\/episode\/)[^"]+)"/i
      );
      browserScrapeUrl = detailLinkMatch ? detailLinkMatch[1] : searchUrl;
    }

    const capturedStreams = await browserScrapeStreams(browserScrapeUrl, {
      referer: source.homepage,
      timeout: 20_000,
    });

    for (const cap of capturedStreams.slice(0, 3)) {
      streams.push(buildExtraStream({
        source,
        title,
        filename: '',
        fileSize: cap.size || 0,
        directUrl: cap.url,
        cdn: 'browser-capture',
        referer: cap.headers.referer || browserScrapeUrl,
        cookie: cap.headers.cookie || '',
        index: streams.length + 1,
      }));
    }

    console.log(`  [extra:${source.slug}] browser capture found ${capturedStreams.length} streams`);
  }

  console.log(`  [extra:${source.slug}] total: ${streams.length} streams`);
  return streams;
}

// ---------------------------------------------------------------------------
// ID Parser + Title Resolver
// ---------------------------------------------------------------------------

function parseStremioId(type, rawId) {
  const clean = (rawId || '').replace(/\.json$/i, '').trim();
  const result = { type: type || 'movie', imdbId: null, kitsuId: null, season: null, episode: null, rawId: clean };
  if (type === 'anime' || clean.startsWith('kitsu:')) {
    result.type = 'anime';
    const parts = clean.split(':');
    if (parts[0] === 'kitsu') {
      result.kitsuId = parts[1] || null;
      result.episode = parts[2] ? parseInt(parts[2], 10) || 1 : 1;
    } else {
      result.kitsuId = parts[0] || null;
      result.episode = parts[1] ? parseInt(parts[1], 10) || 1 : 1;
    }
    return result;
  }
  if (clean.startsWith('tmdb:')) {
    // TMDB ID support — pass through to HdHub (PenguPlay doesn't support tmdb:)
    result.imdbId = clean;  // use as fallback ID
    result.tmdbId = clean;
    if (type === 'series') {
      const parts = clean.split(':');
      result.season = parts[2] ? parseInt(parts[2], 10) || null : null;
      result.episode = parts[3] ? parseInt(parts[3], 10) || null : null;
    }
    return result;
  }
  if (type === 'series') {
    const parts = clean.split(':');
    result.imdbId = parts[0] || null;
    result.season = parts[1] ? parseInt(parts[1], 10) || null : null;
    result.episode = parts[2] ? parseInt(parts[2], 10) || null : null;
    return result;
  }
  result.imdbId = clean;
  return result;
}

async function resolveTitle(target) {
  try {
    if (target.type === 'anime' && target.kitsuId) {
      // Try Cinemeta first (follows redirects)
      try {
        const res = await fetch(`https://v3-cinemeta.strem.io/meta/anime/kitsu:${target.kitsuId}.json`, {
          signal: AbortSignal.timeout(5000),
          redirect: 'follow',
        });
        if (res.ok) {
          const data = await res.json();
          const name = data?.meta?.name || '';
          if (name) return name;
        }
      } catch {}

      // Fallback: Kitsu API directly
      try {
        const res = await fetch(`https://kitsu.io/api/edge/anime/${target.kitsuId}`, {
          signal: AbortSignal.timeout(5000),
          headers: { Accept: 'application/vnd.api+json' },
        });
        if (res.ok) {
          const data = await res.json();
          const name = data?.data?.attributes?.canonicalTitle || data?.data?.attributes?.titles?.en || '';
          if (name) return name;
        }
      } catch {}

      // Kitsu.io API already returns the canonical title above.
      // (Previous Jikan fallback was broken — it passed kitsuId as a `q=` title
      // search, returning the wrong anime. Removed.)
      return '';
    }
    if (target.imdbId) {
      const metaType = target.type === 'series' ? 'series' : 'movie';
      const res = await fetch(`https://v3-cinemeta.strem.io/meta/${metaType}/${target.imdbId}.json`, {
        signal: AbortSignal.timeout(5000),
        redirect: 'follow',
      });
      const data = await res.json();
      const name = data?.meta?.name || '';
      const year = data?.meta?.year || '';
      return year ? `${name} ${year}` : name;
    }
  } catch {}
  return '';
}

// ---------------------------------------------------------------------------
// Backend Streams — calls our dedicated backend (Render.com) which has:
//   - Universal embed scraper (play.xpass.top via curl — works for ALL content)
//   - AnimeSky dedicated scraper (FirePlayer API — multi-audio anime)
//   - 4KHDHub with xpass.top fallback
//   - Streamex (StreameX SPA bypass)
// The backend is where all the dedicated scrapers live. The Vercel addon calls
// it via /streams3/ endpoint to merge those streams with PenguPlay + HdHub.
//
// Set BACKEND_URL env var in Vercel to enable (e.g., https://herumhai-backend.onrender.com)
// If not set, this is a no-op (returns empty array).
// ---------------------------------------------------------------------------

async function fetchBackendStreams(target) {
  const backendUrl = process.env.BACKEND_URL;
  if (!backendUrl) {
    console.log(`[backend] BACKEND_URL not set — skipping`);
    return [];
  }

  // Build the ID string for the backend
  let backendId;
  let backendType = target.type;
  if (target.type === 'series') {
    backendId = `${target.imdbId}:${target.season || 1}:${target.episode || 1}`;
  } else if (target.type === 'anime') {
    // Pass kitsu ID with episode — backend handles kitsu→TMDB resolution
    backendId = target.kitsuId
      ? `kitsu:${target.kitsuId}:${target.episode || 1}`
      : target.imdbId;
  } else {
    backendId = target.imdbId;
  }

  if (!backendId) {
    console.log(`[backend] no ID to send — skipping`);
    return [];
  }

  const fetchUrl = `${backendUrl}/stream/${backendType}/${backendId}.json`;
  console.log(`[backend] → ${fetchUrl.slice(0, 80)}`);

  try {
    const res = await fetch(fetchUrl, {
      headers: { 'User-Agent': 'HerumHai-Vercel/1.0', Accept: 'application/json' },
      signal: AbortSignal.timeout(20000),  // 20s — backend has its own 60s timeout
    });
    if (!res.ok) {
      console.log(`[backend] HTTP ${res.status}`);
      return [];
    }
    const data = await res.json();
    const streams = data.streams || [];
    console.log(`[backend] ✓ ${streams.length} streams (cached=${data.cached || false})`);
    return streams;
  } catch (e) {
    console.log(`[backend] error: ${e.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Main Resolver — PenguPlay + parallel extra scraping
// ----------------------------------------------------------------------------

async function resolveStreams(target, userConfig, baseUrl) {
  setBaseUrl(baseUrl);
  const startTime = Date.now();

  // Resolve title for search queries
  const title = await resolveTitle(target);
  console.log(`  resolved title: '${title}'`);

  // ANIME FIX: If this is an anime (kitsu: ID), convert it to a title-based search
  // PenguPlay and HdHub don't support kitsu: IDs, but they DO have anime content
  // if you search by title (e.g., "Attack on Titan", "Death Note")
  // So we create a "virtual" movie/series target with the anime's title
  let searchTarget = target;
  if (target.type === 'anime' && target.kitsuId && title) {
    // Try searching as a movie first (many anime are movies)
    searchTarget = {
      ...target,
      type: 'movie',
      imdbId: null,  // Clear kitsu — search by title only
      kitsuId: null,
    };
    console.log(`  [anime] converted kitsu:${target.kitsuId} → title search: "${title}"`);
  }

  // Filter extra sources — for anime, search ALL sources (not just anime-type)
  // because many movie sites also host anime movies
  const extraCandidates = EXTRA_SOURCES.filter((s) => {
    // For anime, include all source types (movie sites often have anime movies)
    if (target.type === 'anime') return s.type === 'anime' || s.type === 'movie_series' || s.type === 'embed';
    return s.type === 'movie_series' || s.type === 'embed';
  });

  // ===========================================================================
  // HYBRID ARCHITECTURE — Our scrapers PRIMARY + PenguPlay/HdHub SECONDARY
  // ===========================================================================
  // 1. Backend (Render) — PRIMARY — our 34+ independent scrapers
  // 2. Extra sources — 24 independent WordPress/SPA scrapers
  // 3. PenguPlay proxy — SECONDARY — adds extra streams (HubCloud GDrive links)
  // 4. HdHub proxy — SECONDARY — adds OD direct CDN streams
  //
  // Our independent sources run FIRST. PenguPlay/HdHub fill in EXTRA streams
  // so the user gets maximum choice. If PenguPlay/HdHub go down, our sources
  // still work.
  // ===========================================================================
  console.log(`[scraper] starting backend + ${extraCandidates.length} extra + PenguPlay + HdHub`);

  // 1. Backend sources (PRIMARY — universal embeds + AnimeSky + 4KHDHub + 30 more)
  const backendPromise = fetchBackendStreams(target).then((streams) => {
    console.log(`[backend] returned ${streams.length} streams in ${Date.now() - startTime}ms`);
    return streams;
  }).catch((e) => {
    console.log(`[backend] failed (graceful degradation): ${e.message}`);
    return [];
  });

  // 1b. PenguPlay proxy (SECONDARY — adds HubCloud GDrive streams)
  const penguPromise = fetchPenguStreams(searchTarget, userConfig).then((streams) => {
    console.log(`[pengu] returned ${streams.length} streams in ${Date.now() - startTime}ms`);
    return streams;
  }).catch((e) => {
    console.log(`[pengu] failed (graceful degradation): ${e.message}`);
    return [];
  });

  // 1c. HdHub proxy (SECONDARY — adds OD direct CDN streams)
  const hdhubTarget = parseStremioIdHdHub(searchTarget.type, searchTarget.imdbId || '');
  if (searchTarget.season != null) hdhubTarget.season = searchTarget.season;
  if (searchTarget.episode != null) hdhubTarget.episode = searchTarget.episode;
  if (searchTarget.rawId && searchTarget.rawId.startsWith('tmdb:')) {
    hdhubTarget.tmdbId = searchTarget.rawId;
  }
  const hdhubPromise = fetchHdHubStreams(hdhubTarget, userConfig).then((streams) => {
    console.log(`[hdhub] returned ${streams.length} streams in ${Date.now() - startTime}ms`);
    return streams
      .map((s) => rewriteHdHubStream(s, baseUrl))
      .filter(Boolean);
  }).catch((e) => {
    console.log(`[hdhub] failed (graceful degradation): ${e.message}`);
    return [];
  });

  // 2. Extra source scrapers (24 independent sources — backup)
  const extraPromises = extraCandidates.map((source) =>
    Promise.race([
      scrapeExtraSource(source, target, title),
      new Promise((resolve) => setTimeout(() => {
        console.log(`  [extra:${source.slug}] timeout — skipping`);
        resolve([]);
      }, EXTRA_SOURCE_TIMEOUT_MS)),
    ])
  );

  // Wait for ALL sources in parallel
  const [backendStreams, penguStreams, hdhubStreams] = await Promise.all([backendPromise, penguPromise, hdhubPromise]);

  // Wait for extra sources (with total budget)
  const extraBudgetTimer = new Promise((resolve) => setTimeout(resolve, EXTRA_TOTAL_BUDGET_MS));
  const extraResults = await Promise.race([
    Promise.all(extraPromises),
    extraBudgetTimer.then(() => extraPromises.map(async (p) => {
      try { return await Promise.race([p, Promise.resolve([])]); } catch { return []; }
    })),
  ]);

  // Flatten extra results
  const extraStreams = (await Promise.all(extraResults)).flat();
  console.log(`[scraper] extra sources returned ${extraStreams.length} streams in ${Date.now() - startTime}ms`);

  // Merge: backend (primary) + pengu (secondary) + hdhub (secondary) + extra (backup)
  const rewrittenPengu = penguStreams.map((s) => rewritePenguStream(s, baseUrl));
  const allStreams = [...backendStreams, ...rewrittenPengu, ...hdhubStreams, ...extraStreams];
  console.log(`[scraper] merged: ${backendStreams.length} backend + ${rewrittenPengu.length} pengu + ${hdhubStreams.length} hdhub + ${extraStreams.length} extra = ${allStreams.length} total`);

  // FILTER OUT:
  //   - Donation banners (streams with externalUrl instead of url)
  //   - Promotional entries from PenguPlay (e.g., "✨ Donations Needed!")
  // We only return actual playable streams to Stremio.
  const playableStreams = allStreams.filter((s) => {
    // Must have a streamable url (skip pure-externalUrl entries)
    if (!s.url || typeof s.url !== 'string') return false;
    if (s.externalUrl && !s.url) return false;
    // Filter out anything that looks like a donation/promo entry
    const name = (s.name || '').toLowerCase();
    const desc = (s.description || '').toLowerCase();
    if (name.includes('donation') || name.includes('donate') || name.includes('support')) return false;
    if (desc.includes('pengu.uk/donate') || desc.includes('pengu.uk/tg')) return false;
    if (name.startsWith('✨') && (name.includes('donat') || name.includes('support'))) return false;
    return true;
  });

  // Label download streams with ⬇️ prefix for easy identification
  // Download streams = streams with [Download] in description OR from HdHub's
  // "Download |" source tag. These are direct file downloads (MKV/MP4) that
  // Stremio can save locally rather than stream.
  const labeledStreams = playableStreams.map((s) => {
    const desc = s.description || '';
    const name = s.name || '';
    const isDownload = desc.includes('[Download]') || desc.includes('Download |');
    if (isDownload && !name.includes('⬇️')) {
      return { ...s, name: `⬇️ ${name}` };
    }
    return s;
  });

  // Apply downloads_only filter if requested (?downloads_only=true)
  let finalStreams = labeledStreams;
  if (userConfig.downloads_only) {
    finalStreams = labeledStreams.filter((s) => {
      const desc = s.description || '';
      const name = s.name || '';
      return name.includes('⬇️') || desc.includes('[Download]') || desc.includes('Download |');
    });
    console.log(`[scraper] downloads_only filter: ${labeledStreams.length} → ${finalStreams.length} streams`);
  }

  // Dedupe by URL
  const seen = new Set();
  const unique = [];
  for (const s of finalStreams) {
    if (!seen.has(s.url)) {
      seen.add(s.url);
      unique.push(s);
    }
  }

  // Sort streams by quality hierarchy:
  //   1. Quality: 4K (2160p) → 1080p → 720p → 480p → 360p → unknown
  //   2. Source type: REMUX → BluRay → WEB-DL → WEBRip → other
  //   3. File size: largest first (higher bitrate = better quality)
  //   Download streams (⬇️) go to the bottom
  const sorted = unique.sort((a, b) => {
    // Download streams to the bottom
    const aDl = (a.name || '').includes('⬇️') ? 1 : 0;
    const bDl = (b.name || '').includes('⬇️') ? 1 : 0;
    if (aDl !== bDl) return aDl - bDl;

    // Parse quality from name/description/filename
    const getText = (s) => ((s.name || '') + ' ' + (s.description || '') + ' ' + (s.behaviorHints?.filename || '')).toLowerCase();
    const aText = getText(a);
    const bText = getText(b);

    // Quality rank: 4K=5, 1080p=4, 720p=3, 480p=2, 360p=1, unknown=0
    const getQualityRank = (t) => {
      if (/2160p|4k|uhd/.test(t)) return 5;
      if (/1080p|fhd/.test(t)) return 4;
      if (/720p|hd/.test(t)) return 3;
      if (/480p|sd/.test(t)) return 2;
      if (/360p/.test(t)) return 1;
      return 0;
    };
    const aQ = getQualityRank(aText);
    const bQ = getQualityRank(bText);
    if (aQ !== bQ) return bQ - aQ;  // Higher quality first

    // Source type rank: REMUX=4, BluRay=3, WEB-DL=2, WEBRip=1, other=0
    const getSourceRank = (t) => {
      if (/remux/.test(t)) return 4;
      if (/blu-?ray|blueray/.test(t)) return 3;
      if (/web-?dl|webdl/.test(t)) return 2;
      if (/webrip|web-rip/.test(t)) return 1;
      return 0;
    };
    const aS = getSourceRank(aText);
    const bS = getSourceRank(bText);
    if (aS !== bS) return bS - aS;  // Higher source quality first

    // File size: largest first (videoSize or parsed from description)
    const getSize = (s) => {
      if (s.behaviorHints?.videoSize) return s.behaviorHints.videoSize;
      const sizeMatch = (s.description || '').match(/([\d.]+)\s*(GB|MB|TB)/i);
      if (sizeMatch) {
        const num = parseFloat(sizeMatch[1]);
        const unit = sizeMatch[2].toUpperCase();
        if (unit === 'TB') return num * 1024 * 1024;
        if (unit === 'GB') return num * 1024;
        return num;  // MB
      }
      return 0;
    };
    return getSize(b) - getSize(a);  // Larger file first
  });

  const downloadCount = sorted.filter((s) => s.name?.includes('⬇️')).length;
  console.log(`[scraper] total sorted streams: ${sorted.length} (${downloadCount} download) (in ${Date.now() - startTime}ms)`);
  return sorted;
}

// ---------------------------------------------------------------------------
// Quality Filter + Stream Formatter
// ----------------------------------------------------------------------------
// Applies the user's quality selection (res_2160, res_1080, etc.) and
// nameTemplate/descriptionTemplate from the Configure-WebUI to ALL streams
// (both our own scraped streams AND PenguPlay/HdHub proxied streams).
// ---------------------------------------------------------------------------

function filterByQuality(streams, userConfig) {
  // If no quality filters are set, return all streams
  const hasFilter = ['res_2160','res_1440','res_1080','res_720','res_576','res_480','res_360','res_240','res_144']
    .some(k => k in userConfig);
  if (!hasFilter) return streams;

  // Build allowed resolutions
  const allowed = new Set();
  if (userConfig.res_2160) allowed.add('2160p'); allowed.add('4k'); allowed.add('uhd');
  if (userConfig.res_1440) allowed.add('1440p'); allowed.add('2k');
  if (userConfig.res_1080) allowed.add('1080p'); allowed.add('fhd');
  if (userConfig.res_720) allowed.add('720p'); allowed.add('hd');
  if (userConfig.res_576) allowed.add('576p');
  if (userConfig.res_480) allowed.add('480p'); allowed.add('sd');
  if (userConfig.res_360) allowed.add('360p');
  if (userConfig.res_240) allowed.add('240p');
  if (userConfig.res_144) allowed.add('144p');

  // If ALL are selected, return all
  if (allowed.size === 0 || allowed.has('all')) return streams;

  return streams.filter(s => {
    const text = ((s.name || '') + ' ' + (s.description || '') + ' ' + (s.behaviorHints?.filename || '')).toLowerCase();
    // HLS master playlists contain all qualities — always include
    if (s.url && s.url.includes('.m3u8') && !text.includes('480p') && !text.includes('720p') && !text.includes('1080p')) return true;
    // Check if any allowed quality keyword matches
    for (const q of allowed) {
      if (text.includes(q)) return true;
    }
    // If no quality info in stream, include it (better to show than hide)
    if (!text.includes('2160p') && !text.includes('1080p') && !text.includes('720p') && !text.includes('480p') && !text.includes('360p')) return true;
    return false;
  });
}

function formatStreams(streams, userConfig, title) {
  const nameTpl = userConfig.nameTemplate;
  const descTpl = userConfig.descriptionTemplate;
  if (!nameTpl && !descTpl) return streams;

  // Extract stream info from name/description
  function extractInfo(s) {
    const text = (s.name || '') + ' ' + (s.description || '') + ' ' + (s.behaviorHints?.filename || '');
    const resolution = (text.match(/2160p|4k/i) ? '2160p' :
                       text.match(/1440p|2k/i) ? '1440p' :
                       text.match(/1080p/i) ? '1080p' :
                       text.match(/720p/i) ? '720p' :
                       text.match(/480p/i) ? '480p' :
                       text.match(/360p/i) ? '360p' : 'Auto');
    const source = (s.sourceSlug || 'HerumHai');
    const sizeMatch = text.match(/([\d.]+)\s*(GB|MB|TB)/i);
    const size = sizeMatch ? sizeMatch[0] : 'Unknown';
    const provider = source;
    const year = ''; // Not available in stream data
    return { resolution, source, size, provider, year, title: title || '' };
  }

  // Simple template replacement
  function applyTemplate(tpl, info) {
    if (!tpl) return null;
    return tpl
      .replace(/\{stream\.title\}/g, info.title)
      .replace(/\{stream\.year\}/g, info.year)
      .replace(/\{stream\.resolution\}/g, info.resolution)
      .replace(/\{stream\.source\}/g, info.source)
      .replace(/\{stream\.size\}/g, info.size)
      .replace(/\{stream\.provider\}/g, info.provider);
  }

  return streams.map(s => {
    const info = extractInfo(s);
    const newName = applyTemplate(nameTpl, info);
    const newDesc = applyTemplate(descTpl, info);
    return {
      ...s,
      ...(newName ? { name: newName } : {}),
      ...(newDesc ? { description: newDesc } : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// Vercel Serverless Function Entry
// ----------------------------------------------------------------------------

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(204).end();

  const baseUrl = getBaseUrl(req);
  const { type, id } = req.query;
  let parsedType = type;
  let parsedId = id;

  if (!parsedType || !parsedId) {
    const parts = (req.url || '').split('?')[0].split('/').filter(Boolean);
    const streamIdx = parts.findIndex((p) => p === 'stream');
    if (streamIdx !== -1 && parts.length >= streamIdx + 3) {
      parsedType = parts[streamIdx + 1];
      parsedId = parts[streamIdx + 2];
    }
  }

  if (!parsedType || !parsedId) {
    return res.status(400).json({
      error: 'Missing type or id',
      usage: '/stream/movie/tt1375666.json or /api/stream?type=movie&id=tt1375666',
    });
  }

  const userConfig = {};
  for (const [k, v] of Object.entries(req.query || {})) {
    if (k.startsWith('source_') || k.startsWith('res_') || k.startsWith('audio_') ||
        k === 'subtitles_disabled' || k === 'emulate_vpn' || k === 'disable_direct' ||
        k === 'downloads_only' || k === 'torbox' || k === 'qualities' || k === 'sort') {
      userConfig[k] = v !== 'false' && v !== '0' && v !== 'unchecked';
    }
    // Capture formatter templates (from Configure-WebUI)
    if (k === 'nameTemplate' || k === 'descriptionTemplate') {
      userConfig[k] = v;
    }
  }

  const target = parseStremioId(parsedType, parsedId);
  console.log(`\n[/api/stream] ${parsedType}/${parsedId} →`, JSON.stringify(target));

  // Check cache first — if we have a recent result, serve it instantly.
  // This is our fallback when PenguPlay/HdHub are down.
  const cacheKey = `stream:${parsedType}:${parsedId}`;
  const cached = await cacheGet(cacheKey);
  if (cached && Array.isArray(cached) && cached.length > 0) {
    console.log(`[cache] HIT — serving ${cached.length} streams from cache`);
    // Rewrite cached URLs to use current baseUrl (in case deployment URL changed)
    const rewrittenCached = cached.map((s) => {
      if (!s.url) return s;
      // URLs already point to /direct/ — just replace the host
      try {
        const url = new URL(s.url);
        return { ...s, url: `${baseUrl}${url.pathname}${url.search}` };
      } catch { return s; }
    });
    return res.status(200).json({ streams: rewrittenCached });
  }
  console.log(`[cache] MISS — fetching fresh streams`);

  try {
    let streams = await resolveStreams(target, userConfig, baseUrl);

    // Apply quality filter from Configure-WebUI (res_2160, res_1080, etc.)
    streams = filterByQuality(streams, userConfig);
    console.log(`[quality-filter] ${streams.length} streams after quality filter`);

    // Apply stream formatter from Configure-WebUI (nameTemplate, descriptionTemplate)
    // Resolve title for the formatter (needed for {stream.title} placeholder)
    let formatTitle = '';
    try {
      formatTitle = await resolveTitle(target);
    } catch {}
    streams = formatStreams(streams, userConfig, formatTitle || '');
    console.log(`[formatter] applied nameTemplate/descriptionTemplate to ${streams.length} streams`);

    // Cache the result (non-blocking) — but only if we got streams
    if (streams.length > 0) {
      cacheSet(cacheKey, streams).catch(() => {});
      console.log(`[cache] stored ${streams.length} streams for ${cacheKey}`);
    }

    return res.status(200).json({ streams });
  } catch (e) {
    console.error(`[/api/stream] fatal: ${e.message}`);
    // Last resort: try cache even if it was a MISS earlier (might have been
    // populated by a parallel request)
    const emergencyCache = await cacheGet(cacheKey);
    if (emergencyCache && emergencyCache.length > 0) {
      console.log(`[cache] EMERGENCY — serving ${emergencyCache.length} streams from cache after error`);
      return res.status(200).json({ streams: emergencyCache });
    }
    return res.status(200).json({ streams: [] });
  }
}
