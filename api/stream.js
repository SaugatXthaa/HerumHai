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

// Import multi-source HTTP scraper (xpass + 4khdhub.one + vidsrc.to)
import { scrapeAllSources } from './multisource.js';
import { evaluateTemplate, BUILTIN_FORMATTER_DEFINITIONS } from './formatter-engine.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DIRECT_URL_SECRET =
  process.env.DIRECT_URL_SECRET ||
  'herumhai-dev-secret-' + randomBytes(16).toString('hex');

const PENGU_UPSTREAM = 'https://pengu.uk';
const PENGU_TIMEOUT_MS = 5_000;

// Per-extra-source timeout — sources that don't respond in 12s are skipped
const EXTRA_SOURCE_TIMEOUT_MS = 5_000;
// Total budget for all extra sources (run in parallel, capped at this)
const EXTRA_TOTAL_BUDGET_MS = 8_000;

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
  // Route PenguPlay URLs through our own /api/direct/pengu/ proxy.
  //
  // Why: PenguPlay's /direct/ endpoint now returns 403 Forbidden to Stremio's
  // default User-Agent. Stremio's ffmpeg-based player doesn't send browser
  // headers, so pengu.uk rejects the request.
  //
  // Fix: wrap the pengu.uk URL in our own proxy. Our /api/direct/pengu/
  // endpoint fetches pengu.uk with browser headers (UA + Referer) and pipes
  // the bytes back to Stremio with Range support for seeking.
  //
  // URL transformation:
  //   https://pengu.uk/direct/4khdhub/eyJ...?psig=...
  //   → https://herum-hai.vercel.app/api/direct/pengu/4khdhub/eyJ...?psig=...
  if (!penguUrl || typeof penguUrl !== 'string') return penguUrl;
  if (!penguUrl.includes('pengu.uk/direct/')) return penguUrl;
  // Strip the protocol + host, keep the path + query
  const pathAndQuery = penguUrl.replace(/^https?:\/\/pengu\.uk/, '');
  return `${ourBaseUrl}/api/direct/pengu${pathAndQuery}`;
}

// ---------------------------------------------------------------------------
// Route non-PenguPlay streams through our /api/direct proxy
// ----------------------------------------------------------------------------
// Many CDN URLs (Castle HLS, HubCloud, FSL, etc.) return 403 to Stremio's
// default User-Agent or require specific Referer headers. Stremio's
// proxyHeaders feature helps for some cases, but HLS streams (.m3u8)
// need ALL segment requests to carry the right headers — which only works
// if the stream is proxied through our server.
//
// This function wraps any non-pengu stream URL in our /api/direct/proxy
// endpoint, which fetches the upstream with browser headers + Range support.
// ---------------------------------------------------------------------------
function proxyStreamUrl(originalUrl, ourBaseUrl, referer) {
  if (!originalUrl || typeof originalUrl !== 'string') return originalUrl;
  // Don't proxy our own URLs
  if (originalUrl.includes('/api/direct/')) return originalUrl;
  // Don't proxy pengu URLs (handled separately)
  if (originalUrl.includes('pengu.uk')) return originalUrl;

  // Build the proxy URL: /api/direct/proxy?url=<encoded>&referer=<encoded>
  const params = new URLSearchParams();
  params.set('url', originalUrl);
  if (referer) params.set('referer', referer);
  return `${ourBaseUrl}/api/direct/proxy?${params.toString()}`;
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

  // Rewrite the URL to go through our proxy (avoids pengu.uk 403)
  const newUrl = rewriteStreamUrl(stream.url, ourBaseUrl);

  // Set browser proxyHeaders so Stremio sends proper UA/Referer even if it
  // hits pengu.uk directly (defensive — our proxy already adds these)
  const bh = { ...(stream.behaviorHints || {}) };
  bh.notWebReady = true;
  bh.proxyHeaders = bh.proxyHeaders || {};
  bh.proxyHeaders.request = {
    ...(bh.proxyHeaders.request || {}),
    'User-Agent': USER_AGENT,
    'Referer': 'https://pengu.uk/',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  bh.proxyHeaders.response = bh.proxyHeaders.response || {};

  return {
    ...stream,
    name: newName,
    description: newDescription,
    url: newUrl,
    behaviorHints: bh,
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
  const penguPromise = Promise.resolve([]).then(() => {
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

  // 1d. Multi-source HTTP scraper (PRIMARY — works without backend or puppeteer)
  // Scrapes xpass.top + 4khdhub.one + vidsrc.to using only HTTP (curl).
  // Returns 4-12 working streams per title.
  const xpassPromise = scrapeAllSources(searchTarget, title).then((streams) => {
    console.log(`[multisource] returned ${streams.length} streams in ${Date.now() - startTime}ms`);
    return streams;
  }).catch((e) => {
    console.log(`[multisource] failed (graceful degradation): ${e.message}`);
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
  const [backendStreams, penguStreams, hdhubStreams, xpassStreams] = await Promise.all([
    backendPromise, penguPromise, hdhubPromise, xpassPromise
  ]);

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

  // Merge: xpass (primary) + backend + pengu (secondary) + hdhub (secondary) + extra (backup)
  const rewrittenPengu = penguStreams.map((s) => rewritePenguStream(s, baseUrl));
  const allStreams = [...xpassStreams, ...backendStreams, ...rewrittenPengu, ...hdhubStreams, ...extraStreams];
  console.log(`[scraper] merged: ${xpassStreams.length} xpass + ${backendStreams.length} backend + ${rewrittenPengu.length} pengu + ${hdhubStreams.length} hdhub + ${extraStreams.length} extra = ${allStreams.length} total`);

  // FILTER OUT:
  //   - Donation banners (streams with externalUrl instead of url)
  //   - Promotional entries from PenguPlay (e.g., "✨ Donations Needed!")
  //   - PenguPlay signin.mp4 auth prompts (PenguPlay now requires Google login;
  //     without auth, it returns a promo video instead of real streams)
  //   - Any stream pointing to pengu.uk/signin or pengu.uk/direct that returns
  //     the auth promo (these are useless to the user)
  // We only return actual playable streams to Stremio.
  const playableStreams = allStreams.filter((s) => {
    // Must have a streamable url (skip pure-externalUrl entries)
    if (!s.url || typeof s.url !== 'string') return false;
    if (s.externalUrl && !s.url) return false;
    // Filter out PenguPlay auth/signin promos
    if (s.url.includes('signin.mp4')) return false;
    if (s.url.includes('/signin')) return false;
    // Filter out PenguPlay streams entirely
    if (s.url.includes('pengu.uk/direct/')) return false;
    // Filter out Castle HLS streams — their auth_key tokens expire within minutes,
    // causing "[mpv] unrecognized file format" errors when Stremio tries to play them
    if (s.url.includes('bxncw.com') || s.url.includes('fvncw.com') ||
        s.url.includes('flocw.com') || s.url.includes('klcxm.com') ||
        s.url.includes('hvncw.com') || s.url.includes('wnowe.com') ||
        s.url.includes('hvncw.com')) return false;
    // Filter out HubCloud CDN URLs that return HTML/400 (not video)
    if (s.url.includes('pixel.hubcloud.cx/?id=') || s.url.includes('gpdl.hubcloud.cx/?id=') ||
        s.url.includes('gpdl2.hubcloud.cx/?id=')) return false;
    // Filter out HubCloud drive page URLs (they return HTML, not video)
    if (s.url.includes('hubcloud.cx/') && !s.url.includes('/drive/')) return false;
    if (s.url.includes('hubcloud.ist/') && !s.url.includes('/drive/')) return false;
    // Filter out Cloudflare R2 URLs that return 403
    if (s.url.includes('.r2.cloudflarestorage.com/')) return false;
    // Filter out r2.dev URLs (rate-limited, often 403)
    if (s.url.includes('.r2.dev/')) return false;
    // Filter out donation/promo entries
    const name = (s.name || '').toLowerCase();
    const desc = (s.description || '').toLowerCase();
    if (name.includes('donation') || name.includes('donate') || name.includes('support')) return false;
    if (desc.includes('pengu.uk/donate') || desc.includes('pengu.uk/tg')) return false;
    if (desc.includes('authentication is missing') || desc.includes('sign in')) return false;
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

  // ---------------------------------------------------------------------------
  // Return ALL streams directly with proxyHeaders.
  // Stremio natively supports proxyHeaders — it sends the correct User-Agent
  // and Referer when fetching each stream. This is more reliable than proxying
  // through our server because:
  //   1. No Vercel timeout (streaming large files through proxy can timeout)
  //   2. No Vercel response size limits
  //   3. No double-hop latency (Stremio → Vercel → CDN → Vercel → Stremio)
  //   4. HLS segment URLs work correctly (proxy can't rewrite relative URLs)
  // ---------------------------------------------------------------------------
  const directStreams = sorted.map((s) => {
    if (!s.url) return s;
    const bh = { ...(s.behaviorHints || {}) };
    bh.notWebReady = true;
    // Ensure proxyHeaders are set with browser User-Agent
    if (!bh.proxyHeaders) bh.proxyHeaders = {};
    if (!bh.proxyHeaders.request) bh.proxyHeaders.request = {};
    if (!bh.proxyHeaders.request['User-Agent']) {
      bh.proxyHeaders.request['User-Agent'] = USER_AGENT;
    }
    return { ...s, behaviorHints: bh };
  });

  console.log(`[scraper] ${directStreams.length} streams (all direct with proxyHeaders)`);
  return directStreams;
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

// ---------------------------------------------------------------------------
// Template Engine — ported from AIOStreams (https://github.com/Viren070/AIOStreams)
// ----------------------------------------------------------------------------
// The full AIOStreams formatter engine is in ./formatter-engine.js
// It supports: istrue, isfalse, exists, replace, remove, join, truncate,
// translate, title, upper, lower, smallcaps, subscript, superscript, length,
// first, last, sort, lsort, reverse, string, bytes, sbytes, sbytes10, sbytes2,
// rbytes, bitrate, sbitrate, time, star, pstar, comma, hex, in, default, slice,
// date, {?...?} optional groups, {tools.newLine}, {tools.removeLine},
// 3-branch conditionals, escaped quotes, variable resolution, and more.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Stream info extraction → rich data object for the template engine
// ----------------------------------------------------------------------------
// The user's formatter templates reference many fields like
// {stream.resolution}, {stream.quality}, {stream.audioTags}, {stream.size},
// {stream.encode}, {stream.visualTags}, etc. We extract these from the
// stream's name + description + filename using regexes, and fill in
// sensible defaults when info isn't available.
// ---------------------------------------------------------------------------

function extractStreamData(s, title, addonName) {
  const name = s.name || '';
  const desc = s.description || '';
  const filename = s.behaviorHints?.filename || s.filename || '';
  const text = `${name} ${desc} ${filename}`;
  const textLower = text.toLowerCase();
  // The "source text" is the cleanest signal — usually the filename has the
  // richest technical metadata (release group, codec, audio tags, etc.).
  // We prefer the filename when it exists, falling back to name+desc.
  const sourceText = filename || text;
  // behaviorHints may carry numeric fields that aren't in the text:
  //   - videoSize: file size in bytes (from PenguPlay/HdHub)
  //   - size:      same, alternate key
  //   - duration:  duration in seconds
  //   - bingeGroup: contains hints about quality/source
  const bh = s.behaviorHints || {};
  const directVideoSize = bh.videoSize || bh.size || s.videoSize || 0;
  const directDuration = bh.duration || s.duration || 0;

  // ---------------------------------------------------------------------------
  // Resolution
  // ---------------------------------------------------------------------------
  let resolution = undefined;
  if (/2160p|4k|uhd/i.test(sourceText)) resolution = '2160p';
  else if (/1440p|\b2k\b/i.test(sourceText)) resolution = '1440p';
  else if (/1080p|fhd/i.test(sourceText)) resolution = '1080p';
  else if (/720p|\bhd\b/i.test(sourceText)) resolution = '720p';
  else if (/576p/i.test(sourceText)) resolution = '576p';
  else if (/480p|\bsd\b/i.test(sourceText)) resolution = '480p';
  else if (/360p/i.test(sourceText)) resolution = '360p';
  else if (/240p/i.test(sourceText)) resolution = '240p';
  else if (/144p/i.test(sourceText)) resolution = '144p';

  // ---------------------------------------------------------------------------
  // Quality (source type)
  // ---------------------------------------------------------------------------
  let quality = undefined;
  const qualityMap = [
    ['BluRay REMUX', /bluray.?remux|remux.?bluray/i],
    ['HC HD-Rip', /hc.?hd.?rip/i],
    ['BluRay', /bluray|blu.?ray/i],
    ['WEB-DL', /web.?dl/i],
    ['WEBRip', /webrip|web.?rip/i],
    ['DVDRip', /dvdrip|dvd.?rip/i],
    ['HDRip', /hdrip|hd.?rip/i],
    ['HDTV', /hdtv/i],
    ['SCR', /\bscr\b|screener/i],
    ['CAM', /\bcam\b/i],
    ['TC', /\btc\b|telecine/i],
    ['TS', /\bts\b|telesync/i],
  ];
  for (const [q, re] of qualityMap) {
    if (re.test(sourceText)) { quality = q; break; }
  }

  // ---------------------------------------------------------------------------
  // Encode (codec)
  // ---------------------------------------------------------------------------
  let encode = undefined;
  if (/hevc|x265|h\.?265/i.test(sourceText)) encode = 'HEVC';
  else if (/av1/i.test(sourceText)) encode = 'AV1';
  else if (/avc|x264|h\.?264/i.test(sourceText)) encode = 'AVC';
  else if (/xvid/i.test(sourceText)) encode = 'XviD';
  else if (/divx/i.test(sourceText)) encode = 'DivX';
  else if (/vc-?1/i.test(sourceText)) encode = 'VC-1';

  // ---------------------------------------------------------------------------
  // Audio tags — extract all detected audio formats in canonical order
  // ---------------------------------------------------------------------------
  const audioTags = [];
  if (/atmos/i.test(sourceText)) audioTags.push('Atmos');
  if (/truehd/i.test(sourceText)) audioTags.push('TrueHD');
  if (/dts-?hd.?ma/i.test(sourceText)) audioTags.push('DTS-HD MA');
  else if (/dts-?hd/i.test(sourceText)) audioTags.push('DTS-HD');
  if (/dts-?es/i.test(sourceText)) audioTags.push('DTS-ES');
  if (/dts[:x]/i.test(sourceText)) audioTags.push('DTS:X');
  if (/ddp|dd\+|e-?ac-?3/i.test(sourceText)) audioTags.push('DD+');
  if (/flac/i.test(sourceText)) audioTags.push('FLAC');
  if (/opus/i.test(sourceText)) audioTags.push('OPUS');
  if (/\bdts\b/i.test(sourceText)) audioTags.push('DTS');
  if (/\baac\b/i.test(sourceText)) audioTags.push('AAC');
  if (/\bdd\b|ac-?3/i.test(sourceText)) audioTags.push('DD');

  // ---------------------------------------------------------------------------
  // Audio channels — extract ALL distinct channel configs (e.g., 2.0 + 7.1)
  // Use negative lookbehind/lookahead to avoid matching parts of larger numbers
  // (e.g., "2023.2160p" should NOT match "3.2" as a channel config).
  // ---------------------------------------------------------------------------
  const audioChannels = [];
  // Match X.Y only when NOT preceded or followed by another digit.
  // Valid channel configs: 1.0, 2.0, 2.1, 4.0, 4.1, 5.0, 5.1, 6.0, 6.1, 7.0, 7.1, 8.0, 8.1
  const channelRegex = /(?<!\d)([1-8]\.\d)(?!\d)/g;
  const channelMatches = sourceText.matchAll(channelRegex);
  const seenChannels = new Set();
  // Sort by "specificity" — 7.1 > 5.1 > 2.0 (prefer more channels first)
  const validChannels = ['7.1', '6.1', '5.1', '4.1', '2.1', '7.0', '6.0', '5.0', '4.0', '2.0', '8.1', '8.0'];
  for (const m of channelMatches) {
    const ch = m[1];
    if (validChannels.includes(ch) && !seenChannels.has(ch)) {
      seenChannels.add(ch);
      audioChannels.push(ch);
    }
  }
  // Sort to ensure consistent ordering (higher channel count first)
  audioChannels.sort((a, b) => parseFloat(b) - parseFloat(a));

  // ---------------------------------------------------------------------------
  // Visual tags
  // ---------------------------------------------------------------------------
  const visualTags = [];
  if (/hdr10\+/i.test(sourceText)) visualTags.push('HDR10+');
  else if (/hdr10/i.test(sourceText)) visualTags.push('HDR10');
  if (/dolby.?vision|\bdv\b/i.test(sourceText)) visualTags.push('DV');
  if (/hdr/i.test(sourceText) && !visualTags.some(v => v.startsWith('HDR'))) visualTags.push('HDR');
  if (/10.?bit|10bit/i.test(sourceText)) visualTags.push('10bit');
  if (/hlg/i.test(sourceText)) visualTags.push('HLG');
  if (/sdr/i.test(sourceText)) visualTags.push('SDR');
  if (/imax/i.test(sourceText)) visualTags.push('IMAX');
  if (/\b3d\b/i.test(sourceText)) visualTags.push('3D');
  if (/ai[- ]?upscale/i.test(sourceText)) visualTags.push('AI');

  // ---------------------------------------------------------------------------
  // Size (bytes) — prefer behaviorHints.videoSize (from PenguPlay/HdHub),
  // then fall back to parsing from text.
  // ---------------------------------------------------------------------------
  let size = directVideoSize;
  if (!size) {
    // Try patterns like "62.5 GB", "Size: 2.5GB", "💾 1.4 GB"
    const sizePatterns = [
      /size[:\s]*([\d.]+)\s*(TB|GB|MB|KB)/i,
      /💾\s*([\d.]+)\s*(TB|GB|MB|KB)/i,
      /([\d.]+)\s*(TB|GB|MB|KB)/i,
    ];
    for (const re of sizePatterns) {
      const m = text.match(re);
      if (m) {
        const num = parseFloat(m[1]);
        const unit = m[2].toUpperCase();
        if (unit === 'TB') size = num * 1024 * 1024 * 1024 * 1024;
        else if (unit === 'GB') size = num * 1024 * 1024 * 1024;
        else if (unit === 'MB') size = num * 1024 * 1024;
        else if (unit === 'KB') size = num * 1024;
        break;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Folder size (bytes) — for season packs: "[125 GB]" or "/ 125 GB"
  // ---------------------------------------------------------------------------
  let folderSize = 0;
  const folderPatterns = [
    /\[([\d.]+)\s*(TB|GB|MB|KB)\]/i,
    /\/\s*([\d.]+)\s*(TB|GB|MB|KB)/i,
    /folder[:\s]*([\d.]+)\s*(TB|GB|MB|KB)/i,
  ];
  for (const re of folderPatterns) {
    const m = text.match(re);
    if (m) {
      const num = parseFloat(m[1]);
      const unit = m[2].toUpperCase();
      if (unit === 'TB') folderSize = num * 1024 * 1024 * 1024 * 1024;
      else if (unit === 'GB') folderSize = num * 1024 * 1024 * 1024;
      else if (unit === 'MB') folderSize = num * 1024 * 1024;
      else if (unit === 'KB') folderSize = num * 1024;
      break;
    }
  }

  // ---------------------------------------------------------------------------
  // Bitrate (bps) — from "X Mbps" / "X Kbps" or computed from size+duration
  // ---------------------------------------------------------------------------
  let bitrate = 0;
  const brMatch = text.match(/([\d.]+)\s*(mbps|kbps|mb\/s|kb\/s)/i);
  if (brMatch) {
    const num = parseFloat(brMatch[1]);
    const unit = brMatch[2].toLowerCase();
    if (unit.startsWith('mb')) bitrate = num * 1000000;
    else if (unit.startsWith('kb')) bitrate = num * 1000;
  }

  // ---------------------------------------------------------------------------
  // Duration (seconds) — prefer behaviorHints.duration, then parse from text
  // ---------------------------------------------------------------------------
  let duration = directDuration;
  let episodeRuntime = 0;
  let runtime = 0;
  if (!duration) {
    // "1h 32m" or "1h32m" or "1h:32m:0s"
    const durMatch = text.match(/(\d+)\s*h[\s:]*\d*\s*(\d+)\s*m/i) ||
                     text.match(/(\d+)\s*h\s*(\d+)\s*m/i);
    if (durMatch) {
      duration = parseInt(durMatch[1]) * 3600 + parseInt(durMatch[2]) * 60;
    } else {
      // "62 min" or "62m"
      const durMin = text.match(/(\d+)\s*(?:min|m\b)/i);
      if (durMin) duration = parseInt(durMin[1]) * 60;
    }
  }
  if (duration > 0) {
    // If duration is over 4 hours, it's likely a season pack — treat as runtime
    if (duration > 14400) {
      runtime = duration;
    } else {
      episodeRuntime = duration;
      runtime = duration;
    }
  }

  // If we have size and duration but no bitrate, compute it
  if (!bitrate && size > 0 && duration > 0) {
    bitrate = Math.round((size * 8) / duration);
  }

  // ---------------------------------------------------------------------------
  // Seeders (for p2p streams)
  // ---------------------------------------------------------------------------
  let seeders = 0;
  const seedMatch = text.match(/(\d+)\s*seeders?|seeders?:\s*(\d+)|👥\s*(\d+)|🌱\s*(\d+)/i);
  if (seedMatch) {
    seeders = parseInt(seedMatch[1] || seedMatch[2] || seedMatch[3] || seedMatch[4]);
  }

  // ---------------------------------------------------------------------------
  // Type (debrid / p2p / http / usenet / etc.)
  // ---------------------------------------------------------------------------
  let type = 'http';
  if (/debrid|real-?debrid|premiumize|alldebrid|torbox/i.test(text)) type = 'debrid';
  else if (/usenet|nzb/i.test(text)) type = 'usenet';
  else if (/\bp2p\b|torrent|magnet/i.test(text)) type = 'p2p';
  else if (s.sourceSlug && /p2p|torrent|nyaa|eztv|rarbg|1337x|tpb/i.test(s.sourceSlug)) type = 'p2p';

  // ---------------------------------------------------------------------------
  // Release group (from filename pattern "-GROUP.mkv")
  // ---------------------------------------------------------------------------
  let releaseGroup = '';
  const rgMatch = filename.match(/-([a-z0-9]+)\.(?:mkv|mp4|avi|m4v|mov|wmv|flac|mp3)$/i);
  if (rgMatch) releaseGroup = rgMatch[1];
  else {
    const rgMatch2 = name.match(/-([a-z0-9]+)$/i);
    if (rgMatch2) releaseGroup = rgMatch2[1];
  }

  // ---------------------------------------------------------------------------
  // Network (streaming service) — from filename keywords like AMZN, NF, etc.
  // ---------------------------------------------------------------------------
  let network = undefined;
  const netMap = [
    [/amzn|amazon/i, 'Amazon Prime'],
    [/netflix|\bnf\b/i, 'Netflix'],
    [/hulu/i, 'Hulu'],
    [/hbo/i, 'HBO'],
    [/paramount|pmtp/i, 'Paramount'],
    [/peacock|pcok/i, 'Peacock'],
    [/disney|dsnp/i, 'Disney'],
    [/apple.?tv|atvp/i, 'Apple TV'],
    [/crunchyroll|\bcr\b/i, 'Crunchyroll'],
    [/\bmax\b/i, 'Max'],
    [/youtube|yt\b/i, 'YouTube'],
    [/hbomax|hbo.?max/i, 'Max'],
  ];
  for (const [re, label] of netMap) {
    if (re.test(sourceText)) { network = label; break; }
  }

  // ---------------------------------------------------------------------------
  // Edition (Director's Cut, Extended, Uncut, IMAX, etc.)
  // ---------------------------------------------------------------------------
  let edition = undefined;
  const editionsList = [
    'Director\'s Cut', 'Extended Cut', 'Extended', 'Theatrical',
    'Criterion', 'Remastered', 'Uncut', 'IMAX', 'Special Edition',
    'Unrated',
  ];
  for (const e of editionsList) {
    if (new RegExp(e, 'i').test(sourceText)) { edition = e; break; }
  }
  const editions = edition ? [edition] : [];

  // ---------------------------------------------------------------------------
  // Year — parse 4-digit year from filename/name (1900-2099)
  // ---------------------------------------------------------------------------
  let year = undefined;
  const yearMatch = sourceText.match(/\b(19\d{2}|20\d{2})\b/);
  if (yearMatch) year = yearMatch[1];

  // ---------------------------------------------------------------------------
  // Season + Episode — parse S01E01 / S04E01 / 1x01 patterns
  // ---------------------------------------------------------------------------
  const seasonEpisode = [];
  const seMatch = sourceText.match(/s(\d{1,2})e(\d{1,3})/i);
  if (seMatch) {
    const sNum = parseInt(seMatch[1]);
    const eNum = parseInt(seMatch[2]);
    seasonEpisode.push(`S${String(sNum).padStart(2, '0')}`, `E${String(eNum).padStart(2, '0')}`);
  } else {
    // Try 1x01 pattern
    const xMatch = sourceText.match(/(\d{1,2})x(\d{1,3})/);
    if (xMatch) {
      const sNum = parseInt(xMatch[1]);
      const eNum = parseInt(xMatch[2]);
      seasonEpisode.push(`S${String(sNum).padStart(2, '0')}`, `E${String(eNum).padStart(2, '0')}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Languages — detect from filename (EN, HI, JA, etc.) and Dual-Audio keyword
  // ---------------------------------------------------------------------------
  const languages = [];
  const languageEmojis = [];
  const langMap = [
    [/\beng\b|\ben\b|\benglish\b/i, 'EN', '🇬🇧'],
    [/\bhin\b|\bhi\b|\bhindi\b/i, 'HI', '🇮🇳'],
    [/\bjpn\b|\bja\b|\bjapanese\b/i, 'JA', '🇯🇵'],
    [/\bkor\b|\bko\b|\bkorean\b/i, 'KO', '🇰🇷'],
    [/\bchi\b|\bzh\b|\bchinese\b|\bmandarin\b|\bcantonese\b/i, 'ZH', '🇨🇳'],
    [/\bspa\b|\bes\b|\bspanish\b/i, 'ES', '🇪🇸'],
    [/\bfra\b|\bfr\b|\bfrench\b/i, 'FR', '🇫🇷'],
    [/\bdeu\b|\bde\b|\bgerman\b/i, 'DE', '🇩🇪'],
    [/\bita\b|\bit\b|\bitalian\b/i, 'IT', '🇮🇹'],
    [/\bpor\b|\bpt\b|\bportuguese\b/i, 'PT', '🇵🇹'],
    [/\brus\b|\bru\b|\brussian\b/i, 'RU', '🇷🇺'],
    [/\btam\b|\bta\b|\btamil\b/i, 'TA', '🇮🇳'],
    [/\btel\b|\bte\b|\btelugu\b/i, 'TE', '🇮🇳'],
    [/\bkan\b|\bkn\b|\bkannada\b/i, 'KN', '🇮🇳'],
    [/\bmal\b|\bml\b|\bmalayalam\b/i, 'ML', '🇮🇳'],
    [/\bben\b|\bbn\b|\bbengali\b/i, 'BN', '🇧🇩'],
    [/\bpol\b|\bpl\b|\bpolish\b/i, 'PL', '🇵🇷'],
    [/\bnld\b|\bnl\b|\bdutch\b/i, 'NL', '🇳🇱'],
    [/\btha\b|\bth\b|\bthai\b/i, 'TH', '🇹🇭'],
    [/\bind\b|\bid\b|\bindonesian\b/i, 'ID', '🇮🇩'],
    [/\btur\b|\btr\b|\bturkish\b/i, 'TR', '🇹🇷'],
    [/\bara\b|\bar\b|\barabic\b/i, 'AR', '🇸🇦'],
    [/\bheb\b|\bhe\b|\bhebrew\b/i, 'HE', '🇮🇱'],
    [/\bukr\b|\buk\b|\bukrainian\b/i, 'UK', '🇺🇦'],
  ];
  for (const [re, code, emoji] of langMap) {
    if (re.test(sourceText)) {
      languages.push(code);
      languageEmojis.push(emoji);
    }
  }
  // Detect "Dual Audio" / "Multi Audio"
  const isDualAudio = /dual[\s.-]*audio|multi[\s.-]*audio/i.test(sourceText);

  // ---------------------------------------------------------------------------
  // Subtitles — detect from filename
  // ---------------------------------------------------------------------------
  const subtitles = [];
  const subtitleEmojis = [];
  const subMatch = sourceText.match(/subs?\s*:?\s*([a-z]{2,3}(?:\s*,\s*[a-z]{2,3})*)/i);
  if (subMatch) {
    const codes = subMatch[1].split(/[, ]+/).filter(Boolean);
    for (const c of codes) {
      const upper = c.toUpperCase();
      // Find matching emoji from langMap
      const found = langMap.find(([re]) => re.test(upper));
      if (found) {
        subtitles.push(upper);
        subtitleEmojis.push(found[2]);
      }
    }
  }
  // Subbed keyword
  const isSubbed = /\bsubbed\b|\bsubs?\b/i.test(sourceText) || subtitles.length > 0;

  // ---------------------------------------------------------------------------
  // nSeScore (0-100) — parse "X%" or "score: X" from description
  // ---------------------------------------------------------------------------
  let nSeScore = 0;
  const scoreMatch = text.match(/(\d{1,3})\s*%/);
  if (scoreMatch) {
    nSeScore = parseInt(scoreMatch[1]);
  }

  // ---------------------------------------------------------------------------
  // Age (how old the release is) — "1d", "10d", "2w", "3 months"
  // ---------------------------------------------------------------------------
  let age = undefined;
  const ageMatch = text.match(/\b(\d+)\s*(s|min|h|d|w|mo|y)\b/i);
  if (ageMatch) {
    age = ageMatch[0];
  } else {
    const ageMatch2 = text.match(/age[:\s]*([\d.\w]+)/i);
    if (ageMatch2) age = ageMatch2[1];
  }

  // ---------------------------------------------------------------------------
  // Indexer — for torrents/usenet (rarbg, eztv, nyaa, etc.)
  // ---------------------------------------------------------------------------
  let indexer = undefined;
  const indexerMap = [
    [/rarbg/i, 'RARBG'],
    [/\beztv\b/i, 'EZTV'],
    [/\bnyaa\b/i, 'Nyaa'],
    [/\b1337x\b/i, '1337x'],
    [/\btpb\b|pirate.?bay/i, 'TPB'],
    [/yts/i, 'YTS'],
    [/torrentio/i, 'Torrentio'],
    [/pengu/i, 'PenguPlay'],
    [/hdhub/i, 'HDHub'],
  ];
  for (const [re, label] of indexerMap) {
    if (re.test(text)) { indexer = label; break; }
  }

  // ---------------------------------------------------------------------------
  // Message — any extra info in description (e.g., "NZB Health: ✅")
  // ---------------------------------------------------------------------------
  let message = undefined;
  const msgMatch = desc.match(/(?:message|info|note)[:\s]+([^\n|]+)/i);
  if (msgMatch) {
    message = msgMatch[1].trim().substring(0, 100);
  } else if (/NZB Health:/i.test(desc)) {
    const nzbMatch = desc.match(/NZB Health:\s*[^\n|]+/i);
    if (nzbMatch) message = nzbMatch[0];
  }

  // ---------------------------------------------------------------------------
  // Service info — derive from source slug / stream type
  // ---------------------------------------------------------------------------
  const sourceSlug = s.sourceSlug || s.source || 'HerumHai';
  // Map common source slugs to short display names
  const shortNameMap = {
    'universal': 'Universal',
    'streamex': 'StreameX',
    'nebula': 'Nebula',
    '4khdhub': '4KHDHub',
    '4khdhub_one': '4KHDHub.one',
    'animesky': 'AnimeSky',
    'movieseq': 'MoviesEQ',
    'cinewave': 'CineWave',
    'tatvamovies': 'TatvaMovies',
    'cinefreak': 'CineFreak',
    'moviebox': 'MovieBox',
    'mkvbase': 'MKVBase',
    'moviesdrives': 'MoviesDrives',
    'vaplayer': 'VAPlayer',
    'videasy': 'Videasy',
    'aether': 'Aether',
    'hdghartv': 'HDGharTV',
    '111477': '111477',
    'filmhds': 'FilmHDS',
    'hdhub4u': 'HDHub4u',
    'uhdmovies': 'UHDMovies',
    'moviescounter': 'MoviesCounter',
    'vidsrc': 'VidSrc',
    '2embed': '2Embed',
  };
  const serviceShortName = shortNameMap[sourceSlug] || sourceSlug;
  // Service is "cached" if it's a debrid/cached source
  const isCached = type === 'debrid' || /cached|instant/i.test(text);

  // ---------------------------------------------------------------------------
  // Title (from meta or fallback to stream name)
  // ---------------------------------------------------------------------------
  const streamTitle = title || name.replace(/\[.*?\]|\(.*?\)/g, '').trim() || '';

  // Provider (uppercase source name)
  const provider = sourceSlug.toUpperCase();

  // ---------------------------------------------------------------------------
  // Misc boolean flags — use `undefined` when not detected so ::exists returns
  // false correctly. (Setting `false` makes ::exists return TRUE because
  // false is not undefined/null/"".)
  // ---------------------------------------------------------------------------
  const isRepack = /repack/i.test(sourceText) ? true : undefined;
  const isUncensored = /uncensored/i.test(sourceText) ? true : undefined;
  const isRegraded = /regraded/i.test(sourceText) ? true : undefined;
  const isUnrated = /\bunrated\b/i.test(sourceText) ? true : undefined;
  const isUpscaled = /upscale/i.test(sourceText) ? true : undefined;
  const isPrivate = /\bprivate\b/i.test(sourceText) ? true : undefined;
  const isFreeleech = /freeleech/i.test(sourceText) ? true : undefined;

  // ---------------------------------------------------------------------------
  // Build the data object expected by the template engine.
  // Mirrors the MOCK_DATA shape in index.html so the same template produces
  // consistent output in the WebUI preview and in real streams.
  // ---------------------------------------------------------------------------
  return {
    stream: {
      library: false,
      resolution: resolution || null,
      quality: quality || null,
      type: type || null,
      nSeScore: nSeScore || null,
      seadexBest: null,
      seadex: null,
      seeders: seeders || null,
      audioTags: audioTags.length > 0 ? audioTags : null,
      visualTags: visualTags.length > 0 ? visualTags : null,
      filename: filename || null,
      encode: encode || null,
      audioChannels: audioChannels.length > 0 ? audioChannels : null,
      title: streamTitle || null,
      year: year || null,
      source: sourceSlug || null,
      seasonEpisode: seasonEpisode.length > 0 ? seasonEpisode : null,
      duration: duration || null,
      uLanguageEmojis: languageEmojis.length > 0 ? languageEmojis : null,
      uSubtitleEmojis: subtitleEmojis.length > 0 ? subtitleEmojis : null,
      dubbed: isDualAudio ? true : null,
      subbed: isSubbed ? true : null,
      uLanguages: languages.length > 0 ? languages : null,
      uSubtitles: subtitles.length > 0 ? subtitles : null,
      uSmallLanguageCodes: languages.length > 0 ? languages : null,
      uSmallSubtitleCodes: subtitles.length > 0 ? subtitles : null,
      languages: languages.length > 0 ? languages : null,
      subtitles: subtitles.length > 0 ? subtitles : null,
      languageEmojis: languageEmojis.length > 0 ? languageEmojis : null,
      subtitleEmojis: subtitleEmojis.length > 0 ? subtitleEmojis : null,
      size: size || null,
      folderSize: folderSize || null,
      bitrate: bitrate || null,
      message: message || null,
      age: age || null,
      releaseGroup: releaseGroup || null,
      indexer: indexer || null,
      provider: provider || null,
      rankedRegexMatched: null,
      rseMatched: null,
      regexMatched: null,
      network: network || null,
      editions: editions.length > 0 ? editions : null,
      edition: edition || null,
      uncensored: isUncensored || null,
      repack: isRepack || null,
      regraded: isRegraded || null,
      unrated: isUnrated || null,
      upscaled: isUpscaled || null,
      private: isPrivate || null,
      freeleech: isFreeleech || null,
      proxied: true,
    },
    service: {
      cached: isCached || null,
      shortName: serviceShortName || null,
      id: sourceSlug || null,
    },
    metadata: {
      episodeRuntime: episodeRuntime || null,
      runtime: runtime || null,
    },
    addon: {
      name: addonName || 'HerumHai',
    },
    config: {
      addonName: addonName || 'HerumHai',
    },
  };
}

// Fill in ALL fields from the AIOStreams FIELD_REGISTRY with null if absent.
// The engine requires every registered field to be present (even as null),
// otherwise it outputs {unknown_propertyName(...)} for missing fields.
function fillMissingFields(data) {
  const ALL_STREAM_FIELDS = [
    'filename', 'folderName', 'size', 'bitrate', 'folderSize', 'library',
    'quality', 'resolution', 'subbed', 'dubbed', 'languages', 'uLanguages',
    'subtitles', 'uSubtitles', 'languageEmojis', 'uLanguageEmojis',
    'subtitleEmojis', 'uSubtitleEmojis', 'languageCodes', 'uLanguageCodes',
    'subtitleCodes', 'uSubtitleCodes', 'smallLanguageCodes', 'uSmallLanguageCodes',
    'smallSubtitleCodes', 'uSmallSubtitleCodes', 'wedontknowwhatakilometeris',
    'uWedontknowwhatakilometeris', 'visualTags', 'audioTags', 'releaseGroup',
    'regexMatched', 'rankedRegexMatched', 'regexScore', 'nRegexScore', 'encode',
    'audioChannels', 'edition', 'editions', 'remastered', 'regraded', 'repack',
    'proper', 'uncensored', 'unrated', 'upscaled', 'hasChapters', 'network',
    'container', 'extension', 'indexer', 'year', 'title', 'date', 'folderSeasons',
    'formattedFolderSeasons', 'seasons', 'season', 'formattedSeasons', 'episodes',
    'episode', 'formattedEpisodes', 'folderEpisodes', 'formattedFolderEpisodes',
    'seasonEpisode', 'seasonPack', 'seeders', 'private', 'freeleech', 'age',
    'ageHours', 'duration', 'infoHash', 'type', 'message', 'proxied', 'seadex',
    'seadexBest', 'seScore', 'nSeScore', 'seMatched', 'rseMatched', 'preloading'
  ];
  if (!data.stream) data.stream = {};
  for (const f of ALL_STREAM_FIELDS) {
    if (data.stream[f] === undefined) data.stream[f] = null;
  }
  // Also fill service fields
  const SERVICE_FIELDS = ['id', 'cached', 'shortName'];
  if (!data.service) data.service = {};
  for (const f of SERVICE_FIELDS) {
    if (data.service[f] === undefined) data.service[f] = null;
  }
  // Also fill metadata fields
  const META_FIELDS = ['episodeRuntime', 'runtime'];
  if (!data.metadata) data.metadata = {};
  for (const f of META_FIELDS) {
    if (data.metadata[f] === undefined) data.metadata[f] = null;
  }
  // Also fill addon fields
  if (!data.addon) data.addon = {};
  if (data.addon.name === undefined) data.addon.name = null;
  // Also fill config fields
  if (!data.config) data.config = {};
  if (data.config.addonName === undefined) data.config.addonName = null;
  return data;
}

// ---------------------------------------------------------------------------
// Default Tamtaro formatter (from AIOStreams BUILTIN_FORMATTER_DEFINITIONS)
let DEFAULT_NAME_TEMPLATE = null;
let DEFAULT_DESC_TEMPLATE = null;

async function loadDefaultFormatter() {
  if (DEFAULT_NAME_TEMPLATE) return;
  try {
    // Use BUILTIN_FORMATTER_DEFINITIONS from the static import (already loaded)
    if (BUILTIN_FORMATTER_DEFINITIONS?.tamtaro) {
      DEFAULT_NAME_TEMPLATE = BUILTIN_FORMATTER_DEFINITIONS.tamtaro.name;
      DEFAULT_DESC_TEMPLATE = BUILTIN_FORMATTER_DEFINITIONS.tamtaro.description;
      console.log(`[formatter] loaded Tamtaro default from AIOStreams engine (name=${DEFAULT_NAME_TEMPLATE?.length||0} chars)`);
    }
  } catch (e) {
    console.log('[formatter] could not load default Tamtaro formatter:', e.message);
  }
}

function formatStreams(streams, userConfig, title) {
  // Use user-configured templates from /api/config if available,
  // otherwise use the default Tamtaro formatter
  const nameTpl = userConfig.nameTemplate || DEFAULT_NAME_TEMPLATE;
  const descTpl = userConfig.descriptionTemplate || DEFAULT_DESC_TEMPLATE;
  const addonName = 'HerumHai';

  if (!nameTpl && !descTpl) {
    console.log('[formatter] no templates configured and no default loaded — skipping');
    return streams;
  }
  console.log(`[formatter] using ${userConfig.nameTemplate ? 'user' : 'default'} templates (name=${nameTpl?.length||0} chars, desc=${descTpl?.length||0} chars)`);

  return streams.map(s => {
    const data = fillMissingFields(extractStreamData(s, title, addonName));
    let newName = s.name;
    let newDesc = s.description;

    // Mark download streams with "Download" message
    const isDownload = s.name && s.name.includes('⬇️');
    if (isDownload) {
      data.stream.message = 'Download';
    }

    try {
      const result = evaluateTemplate(nameTpl, data);
      if (result) newName = result;
    } catch (e) {
      console.error('[formatter] nameTemplate error:', e.message);
    }
    try {
      const result = evaluateTemplate(descTpl, data);
      if (result) newDesc = result;
    } catch (e) {
      console.error('[formatter] descriptionTemplate error:', e.message);
    }

    // Add "Download" text at the end for download streams
    if (isDownload && !newDesc.includes('Download')) {
      newDesc = newDesc + '\n⬇️ Download';
    }

    return { ...s, name: newName, description: newDesc };
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

  // --- Resolve formatter from config=<id> if present ---
  // This solves the URL-length-limit problem: the user's full formatter is
  // ~24KB but Vercel truncates query strings at ~8KB. By storing it server-side
  // (via /api/config) and only passing the short hash ID in the URL, we get
  // the full formatter back intact.
  if (req.query?.config) {
    try {
      const cfgRes = await fetch(`${baseUrl}/api/config?id=${encodeURIComponent(req.query.config)}`, {
        signal: AbortSignal.timeout(3000),
      });
      if (cfgRes.ok) {
        const cfg = await cfgRes.json();
        if (cfg.nameTemplate) userConfig.nameTemplate = cfg.nameTemplate;
        if (cfg.descriptionTemplate) userConfig.descriptionTemplate = cfg.descriptionTemplate;
        console.log(`[formatter] loaded from config id=${req.query.config} (name=${cfg.nameTemplate?.length||0} chars, desc=${cfg.descriptionTemplate?.length||0} chars)`);
      }
    } catch (e) {
      console.error('[formatter] failed to load config:', e.message);
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
    // Rewrite cached URLs to use current baseUrl
    // (in case the deployment URL changed since the cache was populated)
    const rewrittenCached = cached.map((s) => {
      if (!s.url) return s;
      // Filter out pengu signin promos from cache
      if (s.url.includes('signin.mp4') || s.url.includes('/signin')) return null;
      if (s.url.includes('pengu.uk/direct/')) return null;
      // Update our own /api/direct/proxy URLs to use current host
      try {
        if (s.url.includes('/api/direct/proxy')) {
          const url = new URL(s.url);
          return { ...s, url: `${baseUrl}${url.pathname}${url.search}` };
        }
      } catch {}
      return s;
    }).filter(Boolean);
    if (rewrittenCached.length > 0) {
      return res.status(200).json({ streams: rewrittenCached });
    }
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
    // Load default Tamtaro formatter if user hasn't configured one
    if (!userConfig.nameTemplate && !userConfig.descriptionTemplate) {
      await loadDefaultFormatter();
    }
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
