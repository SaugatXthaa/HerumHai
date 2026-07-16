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
  if (!penguUrl || !penguUrl.includes('/direct/')) return penguUrl;
  try {
    const url = new URL(penguUrl);
    const parts = url.pathname.split('/').filter(Boolean);
    const directIdx = parts.findIndex((p) => p === 'direct');
    if (directIdx === -1 || directIdx + 2 >= parts.length) return penguUrl;
    const source = parts[directIdx + 1];
    const penguToken = parts[directIdx + 2];
    const filename = parts.slice(directIdx + 3).join('/');
    const tokenData = decodePenguToken(penguToken);
    if (!tokenData) return penguUrl;
    const ourToken = encodeOurToken(tokenData);
    const safeFilename = encodeURIComponent(filename || 'stream.mkv');
    const psig = signOurPsig(ourToken, filename || 'stream.mkv');
    return `${ourBaseUrl}/direct/${source}/${ourToken}/${safeFilename}?psig=${encodeURIComponent(psig)}`;
  } catch (e) {
    return penguUrl;
  }
}

function rewritePenguStream(stream, ourBaseUrl) {
  if (!stream) return stream;
  if (!stream.url) return stream;
  const newName = (stream.name || '').replace(/PenguPlay/g, 'HerumHai');
  const newDescription = (stream.description || '').replace(/PenguPlay/g, 'HerumHai');
  return {
    ...stream,
    name: newName,
    description: newDescription,
    url: rewriteStreamUrl(stream.url, ourBaseUrl),
  };
}

// ---------------------------------------------------------------------------
// PenguPlay Upstream Fetcher
// ---------------------------------------------------------------------------

async function fetchPenguStreams(target, userConfig) {
  const config = buildPenguConfig(userConfig);
  const configB64 = encodeConfig(config);

  let penguId;
  if (target.type === 'series') {
    penguId = `${target.imdbId}:${target.season}:${target.episode}`;
  } else if (target.type === 'anime') {
    return [];
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
  const name = `🐧 HerumHai ${snowflake} ${quality.label} • ${source.name}`;

  const tokenData = {
    kind: 'direct',
    url: directUrl,
    referer,
    cookie,
    filename,
  };
  const ourToken = encodeOurToken(tokenData);
  const safeFilename = encodeURIComponent(filename || `${source.slug}-${index}.mp4`);
  const psig = signOurPsig(ourToken, filename || `${source.slug}-${index}.mp4`);
  const signedUrl = `${getBaseUrlRef()}/direct/${source.slug}/${ourToken}/${safeFilename}?psig=${encodeURIComponent(psig)}`;

  return {
    name,
    description: descLines.join('\n'),
    url: signedUrl,
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
// Per-Source Scraper (HubCloud + direct stream extraction)
// ---------------------------------------------------------------------------

async function scrapeExtraSource(source, target, title) {
  const query = title || target.imdbId || target.kitsuId;
  if (!query) return [];

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

  console.log(`  [extra:${source.slug}] found ${streams.length} streams`);
  return streams;
}

// ---------------------------------------------------------------------------
// ID Parser + Title Resolver
// ---------------------------------------------------------------------------

function parseStremioId(type, rawId) {
  const clean = (rawId || '').replace(/\.json$/i, '').trim();
  const result = { type: type || 'movie', imdbId: null, kitsuId: null, season: null, episode: null };
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
      const res = await fetch(`https://v3-cinemeta.strem.io/meta/anime/kitsu:${target.kitsuId}.json`, {
        signal: AbortSignal.timeout(5000),
      });
      const data = await res.json();
      return data?.meta?.name || '';
    }
    if (target.imdbId) {
      const metaType = target.type === 'series' ? 'series' : 'movie';
      const res = await fetch(`https://v3-cinemeta.strem.io/meta/${metaType}/${target.imdbId}.json`, {
        signal: AbortSignal.timeout(5000),
      });
      const data = await res.json();
      return data?.meta?.name || '';
    }
  } catch {}
  return '';
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

  // Filter extra sources by content type
  const extraCandidates = EXTRA_SOURCES.filter((s) => {
    if (target.type === 'anime') return s.type === 'anime' || s.type === 'embed';
    return s.type === 'movie_series' || s.type === 'embed';
  });

  // Start PenguPlay fetch + all extra scrapers IN PARALLEL
  console.log(`[scraper] starting PenguPlay + ${extraCandidates.length} extra sources in parallel`);

  const penguPromise = fetchPenguStreams(target, userConfig).then((streams) => {
    console.log(`[pengu] returned ${streams.length} streams in ${Date.now() - startTime}ms`);
    return streams;
  });

  // Wrap each extra source with a hard timeout
  const extraPromises = extraCandidates.map((source) =>
    Promise.race([
      scrapeExtraSource(source, target, title),
      new Promise((resolve) => setTimeout(() => {
        console.log(`  [extra:${source.slug}] timeout — skipping`);
        resolve([]);
      }, EXTRA_SOURCE_TIMEOUT_MS)),
    ])
  );

  // Wait for PenguPlay + give extra sources up to EXTRA_TOTAL_BUDGET_MS
  const penguStreams = await penguPromise;

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

  // Merge: PenguPlay (rewritten) + extra streams
  const rewrittenPengu = penguStreams.map((s) => rewritePenguStream(s, baseUrl));
  const allStreams = [...rewrittenPengu, ...extraStreams];

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

  // Dedupe by URL
  const seen = new Set();
  const unique = [];
  for (const s of playableStreams) {
    if (!seen.has(s.url)) {
      seen.add(s.url);
      unique.push(s);
    }
  }

  console.log(`[scraper] total unique playable streams: ${unique.length} (in ${Date.now() - startTime}ms)`);
  return unique;
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
        k === 'subtitles_disabled' || k === 'emulate_vpn' || k === 'disable_direct') {
      userConfig[k] = v !== 'false' && v !== '0' && v !== 'unchecked';
    }
  }

  const target = parseStremioId(parsedType, parsedId);
  console.log(`\n[/api/stream] ${parsedType}/${parsedId} →`, JSON.stringify(target));

  try {
    const streams = await resolveStreams(target, userConfig, baseUrl);
    return res.status(200).json({ streams });
  } catch (e) {
    console.error(`[/api/stream] fatal: ${e.message}`);
    return res.status(200).json({ streams: [] });
  }
}
