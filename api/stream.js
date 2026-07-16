// ============================================================================
// api/stream.js — HerumHai Serverless Stream Scraper (PenguPlay Architecture)
// ----------------------------------------------------------------------------
// Professional implementation of all PenguPlay techniques:
//
//   ✓ Stream URL Pattern:  /direct/{source}/{base64_token}/{filename}?psig={ts}.{hmac}
//   ✓ Token Format:        base64url(JSON {kind, landingUrl, ...})
//   ✓ Signature Scheme:    HMAC-SHA256 with 12h expiry
//   ✓ HubCloud Domain Rotation: .cx / .ist / .club / .fans
//   ✓ gamerxyt.com:        HubCloud → GDrive resolver
//   ✓ CDN Targets:         files.jiomovies.workers.dev / lh3.googleusercontent.com
//                          / video-downloads.googleusercontent.com
//   ✓ Anti-Bot:            6s CF Turnstile pause, navigator.webdriver spoof,
//                          Referer chain, @sparticuz/chromium fallback
//   ✓ Quality Detection:   4K/1080p/720p/480p/360p from filename
//   ✓ Audio Detection:     Hindi/Tamil/Telugu/English/etc. from filename
//   ✓ File Size Extraction: from URL path + Content-Length
//   ✓ bingeGroup Naming:   herumhai-{source}-{kind}-{quality}-{n}
//   ✓ PenguPlay-style Description: 🎬 🎥 ⚡ 💾 🔊 emojis
//   ✓ Donation Banner:     First stream entry with externalUrl
//
// Sources (16 from PenguPlay, exact slugs/names/URLs):
//   111477, 4khdhub, cinefreak, aniwaves, moviebox, mkvbase, moviesdrives,
//   vaplayer, videasy, zxcstream, animesuge, aether, artemis, vidlink,
//   vidfast, hdghartv
//
// Plus embed-based sources (same signed-URL architecture):
//   vidsrc, 2embed, multiembed, vidsrcme, gomo, databasegdriveco
// ============================================================================

import { createHmac, randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SCRAPER_TIMEOUT_MS = 120_000;
const PER_INDEXER_TIMEOUT_MS = 25_000;
const CLOUDFLARE_PAUSE_MS = 6_000;
const POST_CLICK_CAPTURE_MS = 15_000;
const MIN_MP4_SIZE_BYTES = 50 * 1024 * 1024;

// Signed-URL secret (env var on Vercel, dev fallback otherwise)
const DIRECT_URL_SECRET =
  process.env.DIRECT_URL_SECRET || 'herumhai-dev-secret-change-me-' + randomBytes(16).toString('hex');

// Public base URL (set via VERCEL_URL env var on Vercel)
const PUBLIC_BASE_URL = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : process.env.HERUMHAI_BASE_URL || 'https://herum-hai.vercel.app';

// HubCloud domain rotation — Cloudflare blocks .ist periodically,
// pengu.uk rotates through .cx / .club / .fans / .ist
const HUBCLOUD_DOMAINS = ['hubcloud.cx', 'hubcloud.ist', 'hubcloud.club', 'hubcloud.fans'];

// gamerxyt.com is pengu.uk's HubCloud→GDrive resolver proxy
const GAMERXYT_BASE = 'https://gamerxyt.com/hubcloud.php';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// ---------------------------------------------------------------------------
// Source Registry — EXACT 16 PenguPlay sources + 6 embed sources
// ----------------------------------------------------------------------------

const PENGUPLAY_SOURCES = [
  {
    slug: '111477',
    name: '111477',
    type: 'movie_series',
    homepage: 'https://111477.to',
    searchPath: '/?s={query}',
    tags: ['Very Fast', '4K', '1080p', 'Huge Library'],
    enabled: true,
  },
  {
    slug: '4khdhub',
    name: '4KHDHub',
    type: 'movie_series',
    homepage: 'https://4khdhub.store',
    searchPath: '/?s={query}',
    tags: ['4K', 'Mainstream', 'Classics', 'Series', 'Anime', 'Indie'],
    enabled: true,
  },
  {
    slug: 'cinefreak',
    name: 'CineFreak',
    type: 'movie_series',
    homepage: 'https://cinefreak.net',
    searchPath: '/?s={query}',
    tags: ['4K', '1080p', '720p', 'Regional', 'Classics', 'Indie'],
    enabled: true,
  },
  {
    slug: 'aniwaves',
    name: 'Aniwaves',
    type: 'anime',
    homepage: 'https://aniwaves.ru',
    searchPath: '/search?keyword={query}',
    tags: ['Anime', 'Fast'],
    enabled: true,
  },
  {
    slug: 'moviebox',
    name: 'MovieBox',
    type: 'movie_series',
    homepage: 'https://moviebox.online',
    searchPath: '/?s={query}',
    tags: ['Fast', '1080p', 'Regional', 'Classics', 'Anime', 'Indie'],
    enabled: true,
  },
  {
    slug: 'mkvbase',
    name: 'MKVBase',
    type: 'movie_series',
    homepage: 'https://mkvbase.com',
    searchPath: '/?s={query}',
    tags: ['Fast', '4K', '1080p', 'Regional', 'Mainstream', 'Series'],
    enabled: true,
  },
  {
    slug: 'moviesdrives',
    name: 'MoviesDrives',
    type: 'movie_series',
    homepage: 'https://moviesdrives.cv',
    searchPath: '/?s={query}',
    tags: ['4K', '1080p', 'Mainstream', 'Indie', 'Movies Only'],
    enabled: true,
  },
  {
    slug: 'vaplayer',
    name: 'VAPlayer',
    type: 'movie_series',
    homepage: 'https://vaplayer.com',
    searchPath: '/?s={query}',
    tags: ['Very Fast', '1080p', 'Regional', 'Classics', 'Anime', 'Indie', 'Series'],
    enabled: true,
  },
  {
    slug: 'videasy',
    name: 'Videasy',
    type: 'movie_series',
    homepage: 'https://www.videasy.to',
    searchPath: '/?s={query}',
    tags: ['Fast', '4K', '1080p', 'Regional', 'Classics', 'Anime', 'Indie', 'Series'],
    enabled: true,
  },
  {
    slug: 'zxcstream',
    name: 'ZXCStream',
    type: 'movie_series',
    homepage: 'https://embed.zxcstream.xyz',
    searchPath: '/?s={query}',
    tags: ['Fast', '4K', '1080p', 'Multi-Audio', 'Subtitles', 'Mainstream', 'Series'],
    enabled: true,
  },
  {
    slug: 'animesuge',
    name: 'AnimeSuge',
    type: 'anime',
    homepage: 'https://animesuge.cz',
    searchPath: '/search?keyword={query}',
    tags: ['Anime', 'Fast'],
    enabled: true,
  },
  {
    slug: 'aether',
    name: 'Aether',
    type: 'movie_series',
    homepage: 'https://aether.cx',
    searchPath: '/?s={query}',
    tags: ['4K', '1080p', '720p', 'Regional', 'Mainstream', 'Anime'],
    enabled: true,
  },
  {
    slug: 'artemis',
    name: 'Artemis',
    type: 'movie_series',
    homepage: 'https://artemis.to',
    searchPath: '/?s={query}',
    tags: ['HLS', '4K', '1080p', 'Mainstream', 'Series'],
    enabled: true,
  },
  {
    slug: 'vidlink',
    name: 'VidLink',
    type: 'movie_series',
    homepage: 'https://vidlink.pro',
    searchPath: '/?s={query}',
    tags: ['1080p', 'Classics', 'Mainstream', 'Classic TV', 'Very Fast'],
    enabled: true,
  },
  {
    slug: 'vidfast',
    name: 'VidFast',
    type: 'movie_series',
    homepage: 'https://vidfast.to',
    searchPath: '/?s={query}',
    tags: ['HLS', '4K', '1080p', 'Mainstream', 'Series'],
    enabled: true,
  },
  {
    slug: 'hdghartv',
    name: 'HDGharTV',
    type: 'movie_series',
    homepage: 'https://hdghartv.cc',
    searchPath: '/?s={query}',
    tags: ['Fast', '1080p', '720p', '480p', 'Regional', 'Mainstream', 'Series'],
    enabled: true,
  },
];

// Embed-based sources (apply same signed-URL architecture)
const EMBED_SOURCES = [
  {
    slug: 'vidsrc',
    name: 'VidSrc',
    type: 'embed',
    homepage: 'https://vidsrc.win',
    buildEmbedUrl: (t) =>
      t.type === 'series'
        ? `https://vidsrc.win/embed/tv/${t.imdbId}/${t.season}/${t.episode}`
        : `https://vidsrc.win/embed/movie/${t.imdbId}`,
    tags: ['Fast', '1080p'],
    enabled: true,
  },
  {
    slug: '2embed',
    name: '2Embed',
    type: 'embed',
    homepage: 'https://www.2embed.to',
    buildEmbedUrl: (t) =>
      t.type === 'series'
        ? `https://www.2embed.to/embed/tv/${t.imdbId}/${t.season}/${t.episode}`
        : `https://www.2embed.to/embed/${t.imdbId}`,
    tags: ['1080p', 'Mainstream'],
    enabled: true,
  },
  {
    slug: 'multiembed',
    name: 'MultiEmbed',
    type: 'embed',
    homepage: 'https://multiembed.mov',
    buildEmbedUrl: (t) => `https://multiembed.mov/?video_id=${t.imdbId || t.kitsuId}`,
    tags: ['1080p', 'Mainstream'],
    enabled: false,
  },
  {
    slug: 'vidsrcme',
    name: 'VidSrc.me',
    type: 'embed',
    homepage: 'https://vidsrc.me',
    buildEmbedUrl: (t) => `https://vidsrc.me/embed/${t.imdbId}/`,
    tags: ['1080p'],
    enabled: false,
  },
  {
    slug: 'gomo',
    name: 'Gomo',
    type: 'embed',
    homepage: 'https://gomo.to',
    buildEmbedUrl: (t) => `https://gomo.to/embed/movie/${t.imdbId}`,
    tags: ['1080p'],
    enabled: false,
  },
  {
    slug: 'databasegdriveco',
    name: 'DatabaseGDriveCo',
    type: 'embed',
    homepage: 'https://databasegdrive.co',
    buildEmbedUrl: (t) => `https://databasegdrive.co/player.php?id=${t.imdbId}`,
    tags: ['4K', 'GDrive'],
    enabled: false,
  },
];

const ALL_SOURCES = [...PENGUPLAY_SOURCES, ...EMBED_SOURCES];

// ---------------------------------------------------------------------------
// Anti-Decoy Filters
// ---------------------------------------------------------------------------

const HONEYPOT_REGEX = new RegExp(
  ['tutorial','how-to','howto','download-guide','guide','sample','trailer','demo',
   'placeholder','loading','spinner','promo','/ads/','advert','banner','logo',
   'favicon','beacon','pixel','sharethis','googleusercontent','/analytics/'].join('|'),
  'i'
);

const STREAM_REGEX = new RegExp(
  ['\\.m3u8(?:\\?|$|/)','\\.mpd(?:\\?|$|/)','\\.mp4(?:\\?|$|/)','\\.ts(?:\\?|$|/)',
   '\\.mkv(?:\\?|$|/)','/hls/','/dash/','/seg-','/playlist','/manifest',
   'hubcloud\\.\\w+/drive/','gamerxyt\\.com/hubcloud\\.php',
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
  'cloudflareinsights.com','cloudflare.com/cdn-cgi','winexch.com','a-ads.com',
  'adsboosters.xyz','bonuscaf.com',
];

// ---------------------------------------------------------------------------
// HTTP Fetcher (Node built-in fetch + CF pause + retry)
// ---------------------------------------------------------------------------

async function fetchHtml(url, { headers = {}, timeout = 20_000, retries = 2 } = {}) {
  const finalHeaders = {
    'User-Agent': USER_AGENT,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    ...headers,
  };

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, {
        headers: finalHeaders,
        signal: controller.signal,
        redirect: 'follow',
      });
      const text = await res.text();
      return { status: res.status, headers: res.headers, body: text, finalUrl: res.url };
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

async function fetchJson(url, { headers = {}, timeout = 10_000 } = {}) {
  const res = await fetchHtml(url, {
    headers: { Accept: 'application/json', ...headers },
    timeout,
  });
  try {
    return JSON.parse(res.body);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Browser Launcher (@sparticuz/chromium + puppeteer-core)
// Used as fallback when fetch hits Cloudflare
// ---------------------------------------------------------------------------

let _browser = null;

async function getBrowser() {
  if (_browser) return _browser;
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
      defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1, hasTouch: false, isLandscape: true },
      executablePath,
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });
    console.log('[browser] launched stealth chromium');
    return _browser;
  } catch (e) {
    console.log(`[browser] launch failed: ${e.message}`);
    return null;
  }
}

async function browserFetchHtml(url, { referer, timeout = 40_000 } = {}) {
  const browser = await getBrowser();
  if (!browser) return null;

  const page = await browser.newPage();
  await page.setUserAgent(USER_AGENT);
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

  // Anti-bot: spoof navigator.webdriver + window.chrome
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  });

  // Block ad/tracker domains at network layer
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = req.url();
    if (BLOCK_DOMAINS.some((d) => u.includes(d))) req.abort();
    else req.continue();
  });

  try {
    if (referer) await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9', Referer: referer });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40_000 });

    // CRITICAL: 6-second Cloudflare Turnstile self-verification pause
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

// ---------------------------------------------------------------------------
// Stremio ID Parser + Cinemeta Title Resolver
// ---------------------------------------------------------------------------

function parseId(type, rawId) {
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
      const data = await fetchJson(`https://v3-cinemeta.strem.io/meta/anime/kitsu:${target.kitsuId}.json`, { timeout: 5000 });
      return data?.meta?.name || '';
    }
    if (target.imdbId) {
      const metaType = target.type === 'series' ? 'series' : 'movie';
      const data = await fetchJson(`https://v3-cinemeta.strem.io/meta/${metaType}/${target.imdbId}.json`, { timeout: 5000 });
      const name = data?.meta?.name || '';
      const year = data?.meta?.year || '';
      return year ? `${name} ${year}` : name;
    }
  } catch {}
  return '';
}

// ---------------------------------------------------------------------------
// HubCloud Resolver (PenguPlay's core technique)
// Flow: hubcloud.cx/drive/{id} → extract gamerxyt URL → fetch → extract CDN URL
// ----------------------------------------------------------------------------

/**
 * Resolve a HubCloud landing URL → direct stream URL.
 *
 * Tries 4 HubCloud TLDs (.cx/.ist/.club/.fans) for Cloudflare block evasion.
 * Extracts the hidden gamerxyt.com proxy URL from the landing page,
 * then fetches it and extracts one of 3 CDN URL patterns:
 *
 *   1. files.jiomovies.workers.dev/{hash}::{hash}/{size}/{filename}
 *      (Cloudflare Workers direct download proxy)
 *
 *   2. lh3.googleusercontent.com/pw/AP1Gcz...=m18
 *      (GDrive direct stream URL — used in <source> video tag)
 *
 *   3. video-downloads.googleusercontent.com/{token}
 *      (GDrive download redirect — usually a 302)
 */
async function resolveHubCloud(hubcloudId) {
  console.log(`    [hubcloud] resolving id=${hubcloudId}`);

  for (const domain of HUBCLOUD_DOMAINS) {
    const landingUrl = `https://${domain}/drive/${hubcloudId}`;
    try {
      const landing = await fetchHtml(landingUrl, {
        headers: { Referer: `https://${domain}/` },
        timeout: 15_000,
      });
      if (landing.status !== 200 || !landing.body) continue;

      // Extract gamerxyt.com proxy URL from page
      const gamerxytMatch = landing.body.match(
        /https?:\/\/gamerxyt\.com\/hubcloud\.php\?host=[^"&\s]+&id=[^"&\s]+&token=[A-Za-z0-9+/=]+/i
      );
      if (!gamerxytMatch) continue;

      const gamerxytUrl = gamerxytMatch[0];
      console.log(`    [hubcloud] found gamerxyt proxy via ${domain}`);

      // Fetch the gamerxyt proxy → returns HTML with direct CDN URLs
      const proxy = await fetchHtml(gamerxytUrl, {
        headers: {
          Referer: landingUrl,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        timeout: 15_000,
      });
      const body = proxy.body || '';

      // Pattern 1: Cloudflare Workers direct download (primary — has filename + size)
      const workersMatch = body.match(
        /https:\/\/files\.jiomovies\.workers\.dev\/[A-Za-z0-9]+::[A-Za-z0-9]+\/\d+\/[^"'\s<>]+/i
      );
      if (workersMatch) {
        const directUrl = workersMatch[0];
        const fnMatch = directUrl.match(/\/\d+\/(.+)$/);
        const sizeMatch = directUrl.match(/\/(\d+)\//);
        const filename = fnMatch ? decodeURIComponent(fnMatch[1]) : '';
        const fileSize = sizeMatch ? parseInt(sizeMatch[1], 10) : 0;
        console.log(`    [hubcloud] ✓ Workers CDN: ${fileSize ? (fileSize/1024/1024/1024).toFixed(2) + ' GB' : 'unknown size'}`);
        return {
          directUrl,
          filename,
          fileSize,
          cookie: proxy.headers.get('set-cookie') || '',
          cdn: 'workers',
          referer: landingUrl,
        };
      }

      // Pattern 2: GDrive direct stream (lh3.googleusercontent.com)
      const gdriveSrcMatch = body.match(
        /https:\/\/lh3\.googleusercontent\.com\/pw\/[A-Za-z0-9_\-+=]+/i
      );
      if (gdriveSrcMatch) {
        console.log(`    [hubcloud] ✓ GDrive lh3 CDN`);
        return {
          directUrl: gdriveSrcMatch[0],
          filename: '',
          fileSize: 0,
          cookie: proxy.headers.get('set-cookie') || '',
          cdn: 'gdrive-lh3',
          referer: landingUrl,
        };
      }

      // Pattern 3: video-downloads.googleusercontent.com
      const gdriveDlMatch = body.match(
        /https:\/\/video-downloads\.googleusercontent\.com\/[A-Za-z0-9_\-]+/i
      );
      if (gdriveDlMatch) {
        console.log(`    [hubcloud] ✓ GDrive DL CDN`);
        return {
          directUrl: gdriveDlMatch[0],
          filename: '',
          fileSize: 0,
          cookie: proxy.headers.get('set-cookie') || '',
          cdn: 'gdrive-dl',
          referer: landingUrl,
        };
      }

      // Check 302 redirect
      const redirectUrl = proxy.headers.get('location');
      if (redirectUrl && redirectUrl.includes('googleusercontent.com')) {
        return {
          directUrl: redirectUrl,
          filename: '',
          fileSize: 0,
          cookie: '',
          cdn: 'gdrive-302',
          referer: landingUrl,
        };
      }
    } catch (e) {
      console.log(`    [hubcloud] ${domain} failed: ${e.message}`);
      continue;
    }
  }
  return null;
}

/**
 * Extract all HubCloud IDs from any HTML page.
 * Matches: hubcloud.{cx|ist|club|fans}/drive/{id}
 */
function extractHubCloudIds(html) {
  const ids = new Set();
  const re = /hubcloud\.(?:ist|cx|club|fans)\/drive\/([A-Za-z0-9_-]+)/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    ids.add(m[1]);
  }
  return Array.from(ids);
}

// ---------------------------------------------------------------------------
// Filename Parsers (PenguPlay-style quality/audio/size detection)
// ----------------------------------------------------------------------------

function detectQuality(filenameOrUrl) {
  const t = (filenameOrUrl || '').toLowerCase();
  if (/2160p|4k|uhd|remux/.test(t)) return { label: '4K', rank: 2160 };
  if (/1080p|fhd|1080/.test(t)) return { label: '1080p', rank: 1080 };
  if (/720p|hd|720/.test(t)) return { label: '720p', rank: 720 };
  if (/480p|sd|480/.test(t)) return { label: '480p', rank: 480 };
  if (/360p|360/.test(t)) return { label: '360p', rank: 360 };
  return { label: '1080p', rank: 1080 };
}

function detectAudioLanguages(filename) {
  const t = (filename || '').toLowerCase();
  const langs = [];
  if (/hindi/i.test(t)) langs.push('Hindi');
  if (/tamil/i.test(t)) langs.push('Tamil');
  if (/telugu/i.test(t)) langs.push('Telugu');
  if (/kannada/i.test(t)) langs.push('Kannada');
  if (/malayalam/i.test(t)) langs.push('Malayalam');
  if (/bengali/i.test(t)) langs.push('Bengali');
  if (/punjabi/i.test(t)) langs.push('Punjabi');
  if (/marathi/i.test(t)) langs.push('Marathi');
  if (/english/i.test(t)) langs.push('English');
  if (/korean/i.test(t)) langs.push('Korean');
  if (/japanese/i.test(t)) langs.push('Japanese');
  if (/chinese|mandarin|cantonese/i.test(t)) langs.push('Chinese');
  if (/spanish/i.test(t)) langs.push('Spanish');
  if (/french/i.test(t)) langs.push('French');
  if (/german/i.test(t)) langs.push('German');
  if (/italian/i.test(t)) langs.push('Italian');
  if (/portuguese/i.test(t)) langs.push('Portuguese');
  if (/russian/i.test(t)) langs.push('Russian');
  if (/arabic/i.test(t)) langs.push('Arabic');
  if (/thai/i.test(t)) langs.push('Thai');
  if (/vietnamese/i.test(t)) langs.push('Vietnamese');
  if (/malay/i.test(t)) langs.push('Malay');
  if (/indonesian/i.test(t)) langs.push('Indonesian');
  return langs.length > 0 ? langs : ['English'];
}

function detectSource(filename) {
  const t = (filename || '').toLowerCase();
  // Common release groups: FSL, FraMeSToR, TnP, HHWEB, MainFrame, SWTYBLZ, PiR8, ThePunisheR
  const m = t.match(/(?:fsl|framestor|tnp|hhweb|mainframe|swtyblz|pir8|thepunisher|zkhd|web-dl|blueray|bluray)/i);
  return m ? m[0].toUpperCase() : 'FSL';
}

function detectCodec(filename) {
  const t = (filename || '').toLowerCase();
  if (/hevc|x265|h265/.test(t)) return 'HEVC x265';
  if (/x264|h264|avc/.test(t)) return 'x264';
  if (/av1/.test(t)) return 'AV1';
  if (/vp9/.test(t)) return 'VP9';
  return '';
}

function detectContainer(filename) {
  const t = (filename || '').toLowerCase();
  if (/\.mkv/.test(t)) return 'MKV';
  if (/\.mp4/.test(t)) return 'MP4';
  if (/\.webm/.test(t)) return 'WEBM';
  if (/\.mov/.test(t)) return 'MOV';
  return 'MKV';
}

function detectHdr(filename) {
  const t = (filename || '').toLowerCase();
  const hdrs = [];
  if (/hdr/.test(t)) hdrs.push('HDR');
  if (/dv|dolby.?vision/.test(t)) hdrs.push('DV');
  if (/hdr10\+/.test(t)) hdrs.push('HDR10+');
  if (/sdr/.test(t)) hdrs.push('SDR');
  return hdrs;
}

function detectBitrate(fileSize, duration = 7200) {
  if (!fileSize || !duration) return null;
  const bitrate = (fileSize * 8) / duration;  // bits per second
  const mbps = bitrate / 1_000_000;
  return `~${mbps.toFixed(1)} Mbps`;
}

function formatFileSize(bytes) {
  if (!bytes) return '';
  const gb = bytes / 1024 / 1024 / 1024;
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = bytes / 1024 / 1024;
  return `${mb.toFixed(0)} MB`;
}

// ---------------------------------------------------------------------------
// Signed URL Generator (PenguPlay-style psig)
// ----------------------------------------------------------------------------

function signPsig(token, filename) {
  const ts = Math.floor(Date.now() / 1000);
  const payload = `${ts}.${token}.${filename}`;
  const sig = createHmac('sha256', DIRECT_URL_SECRET).update(payload).digest('base64url');
  return `${ts}.${sig}`;
}

function buildSignedDirectUrl(sourceSlug, tokenData, filename) {
  const token = Buffer.from(JSON.stringify(tokenData)).toString('base64url');
  const safeFilename = encodeURIComponent(filename || 'stream.mkv');
  const psig = signPsig(token, filename || 'stream.mkv');
  return `${PUBLIC_BASE_URL}/direct/${sourceSlug}/${token}/${safeFilename}?psig=${encodeURIComponent(psig)}`;
}

// ---------------------------------------------------------------------------
// Stream Builder (PenguPlay-style with emojis + bingeGroup)
// ----------------------------------------------------------------------------

function buildStreamPayload({
  sourceSlug,
  sourceName,
  title,
  filename,
  fileSize,
  directUrl,
  cdn,
  referer,
  cookie,
  kind,
  index,
}) {
  const quality = detectQuality(filename || directUrl);
  const audio = detectAudioLanguages(filename);
  const releaseGroup = detectSource(filename);
  const codec = detectCodec(filename);
  const container = detectContainer(filename);
  const hdr = detectHdr(filename);
  const bitrate = detectBitrate(fileSize);

  // Build PenguPlay-style description
  const descLines = [];
  if (title) descLines.push(`🎬 ${title}`);
  const techParts = [quality.label];
  if (/bluray|blueray/i.test(filename)) techParts.push('BluRay');
  if (/web-dl|webdl/i.test(filename)) techParts.push('WEB-DL');
  if (hdr.length > 0) techParts.push(...hdr);
  if (codec) techParts.push(codec);
  if (container) techParts.push(container);
  if (bitrate) techParts.push(bitrate);
  if (techParts.length > 1) descLines.push(`🎥 ${techParts.join(' • ')}`);
  descLines.push(`⚡ Source: ${sourceName} · ${releaseGroup}`);
  if (fileSize) descLines.push(`💾 ${formatFileSize(fileSize)}`);
  if (audio.length > 0) descLines.push(`🔊 Audio: ${audio.join(', ')}`);

  // Build stream name (PenguPlay style: "🐧 PenguPlay ❄️ 4K • 4KHDHub · FSL")
  // We use: "🐧 HerumHai ❄️ {quality} • {source} · {releaseGroup}"
  const snowflake = quality.rank >= 2160 ? '❄️' : quality.rank >= 1080 ? '🎯' : '📺';
  const name = `🐧 HerumHai ${snowflake} ${quality.label} • ${sourceName} · ${releaseGroup}`;

  // bingeGroup: herumhai-{source}-{cdn}-{quality}-{n}
  const bingeGroup = `herumhai-${sourceSlug}-${cdn}-${quality.label}-${index}`;

  // Build token for signed URL
  const tokenData = {
    kind,
    landingUrl: referer,
    url: directUrl,
    referer,
    cookie,
    filename,
  };

  const signedUrl = buildSignedDirectUrl(sourceSlug, tokenData, filename || `${sourceSlug}-${index}.${container.toLowerCase()}`);

  return {
    name,
    description: descLines.join('\n'),
    url: signedUrl,
    behaviorHints: {
      notWebReady: true,
      filename: filename || `${title || sourceSlug}.${container.toLowerCase()}`,
      proxyHeaders: {
        request: {
          'User-Agent': USER_AGENT,
          ...(referer ? { Referer: referer } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
      },
      bingeGroup,
    },
  };
}

// ---------------------------------------------------------------------------
// Per-Source Scraper (PenguPlay flow)
// ----------------------------------------------------------------------------

async function scrapePenguSource(source, target, title) {
  const query = title || target.imdbId || target.kitsuId;
  if (!query) return [];

  const searchUrl = source.homepage + source.searchPath.replace('{query}', encodeURIComponent(query));
  console.log(`  [${source.slug}] → ${searchUrl.slice(0, 120)}`);

  // Fetch search results (with browser fallback for CF)
  let searchHtml = '';
  try {
    const res = await fetchHtml(searchUrl, { timeout: 20_000 });
    if (res.status === 403 || res.status === 503) {
      console.log(`  [${source.slug}] CF blocked (${res.status}) — using browser`);
      searchHtml = (await browserFetchHtml(searchUrl, { referer: source.homepage })) || '';
    } else {
      searchHtml = res.body;
    }
  } catch (e) {
    console.log(`  [${source.slug}] search failed, trying browser: ${e.message}`);
    searchHtml = (await browserFetchHtml(searchUrl, { referer: source.homepage })) || '';
  }

  if (!searchHtml) return [];

  // 6-second CF pause (PenguPlay pattern)
  await new Promise((r) => setTimeout(r, CLOUDFLARE_PAUSE_MS));

  // Extract HubCloud IDs from search results
  let hubcloudIds = extractHubCloudIds(searchHtml);

  // Find detail page link and fetch it for more HubCloud IDs
  const detailLinkMatch = searchHtml.match(
    /href="(https?:\/\/[^"]*(?:\/\d{4}\/|\/movie\/|\/film\/|\/series\/|\/watch\/|\/tv\/|\/episode\/)[^"]+)"/i
  );
  if (detailLinkMatch) {
    const detailUrl = detailLinkMatch[1];
    console.log(`  [${source.slug}] → detail: ${detailUrl.slice(0, 100)}`);
    try {
      const detailRes = await fetchHtml(detailUrl, {
        headers: { Referer: searchUrl },
        timeout: 15_000,
      });
      if (detailRes.body) {
        hubcloudIds = [...new Set([...hubcloudIds, ...extractHubCloudIds(detailRes.body)])];
      }
    } catch (e) {
      console.log(`  [${source.slug}] detail fetch failed: ${e.message}`);
    }
  }

  if (hubcloudIds.length === 0) {
    console.log(`  [${source.slug}] no HubCloud IDs found`);
    return [];
  }

  console.log(`  [${source.slug}] found ${hubcloudIds.length} HubCloud IDs`);

  // Resolve each HubCloud ID with limited concurrency
  const streams = [];
  const queue = [...hubcloudIds];

  async function worker() {
    while (queue.length > 0 && streams.length < 8) {
      const id = queue.shift();
      try {
        const resolved = await resolveHubCloud(id);
        if (resolved && resolved.directUrl) {
          streams.push(
            buildStreamPayload({
              sourceSlug: source.slug,
              sourceName: source.name,
              title,
              filename: resolved.filename || '',
              fileSize: resolved.fileSize || 0,
              directUrl: resolved.directUrl,
              cdn: resolved.cdn,
              referer: resolved.referer,
              cookie: resolved.cookie,
              kind: 'hubcloud',
              index: streams.length + 1,
            })
          );
          console.log(`  [${source.slug}] ✓ resolved ${id} → ${resolved.cdn}`);
        }
      } catch (e) {
        console.log(`  [${source.slug}] resolve ${id} failed: ${e.message}`);
      }
    }
  }

  await Promise.all([worker(), worker(), worker()]);
  return streams;
}

// ---------------------------------------------------------------------------
// Embed Source Scraper (vidsrc, 2embed, etc. — uses puppeteer for HLS capture)
// ----------------------------------------------------------------------------

async function scrapeEmbedSource(source, target) {
  const embedUrl = source.buildEmbedUrl(target);
  console.log(`  [${source.slug}] → ${embedUrl.slice(0, 120)}`);

  const browser = await getBrowser();
  if (!browser) return [];

  const page = await browser.newPage();
  await page.setUserAgent(USER_AGENT);
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
  });

  const captured = [];

  page.on('response', async (response) => {
    try {
      const url = response.url();
      if (HONEYPOT_REGEX.test(url)) return;
      if (/\/cdn-cgi\//.test(url)) return;
      if (/\/embed\/(?:movie|tv|anime)\//.test(url)) return;

      const headers = response.headers();
      const ct = (headers['content-type'] || '').toLowerCase();
      const rtype = response.request().resourceType();
      if (['script', 'stylesheet', 'image', 'font'].includes(rtype)) return;

      const isMediaCT = /mpegurl|dash\+xml|mp2t|video\/mp4|video\/webm/.test(ct);
      const isMediaURL = STREAM_REGEX.test(url);
      const isHost = HOST_DOMAINS.some((d) => url.toLowerCase().includes(d));

      if (!isMediaCT && !isMediaURL && !isHost) return;

      // Size gate for MP4s
      if (url.toLowerCase().includes('.mp4') || ct === 'video/mp4') {
        const cl = parseInt(headers['content-length'] || '0', 10);
        if (cl && cl < MIN_MP4_SIZE_BYTES) return;
      }

      const reqHeaders = response.request().headers();
      captured.push({
        url,
        headers: reqHeaders,
        contentType: ct,
        size: parseInt(headers['content-length'] || '0', 10),
      });
    } catch {}
  });

  try {
    await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: 40_000 });
    await new Promise((r) => setTimeout(r, CLOUDFLARE_PAUSE_MS));

    // Try clicking play
    for (const sel of ['button.vjs-big-play-button', '.vjs-big-play-button', '.jw-icon-display', '.play-button', 'video']) {
      try {
        const el = await page.$(sel);
        if (el) { await el.click({ delay: 50 }); break; }
      } catch {}
    }

    // Wait for HLS to initialize
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      if (captured.length > 0) break;
    }
  } catch (e) {
    console.log(`  [${source.slug}] browser error: ${e.message}`);
  } finally {
    await page.close().catch(() => {});
  }

  // Convert to Stremio streams (using signed URL architecture)
  return captured.slice(0, 5).map((c, i) =>
    buildStreamPayload({
      sourceSlug: source.slug,
      sourceName: source.name,
      title: target.imdbId || target.kitsuId,
      filename: '',
      fileSize: c.size,
      directUrl: c.url,
      cdn: 'embed',
      referer: c.headers.referer || embedUrl,
      cookie: c.headers.cookie || '',
      kind: 'direct',
      index: i + 1,
    })
  );
}

// ---------------------------------------------------------------------------
// Main Resolver
// ----------------------------------------------------------------------------

async function resolveStreams(target, config = {}) {
  const deadline = Date.now() + SCRAPER_TIMEOUT_MS;
  const allStreams = [];

  const title = await resolveTitle(target);
  console.log(`  resolved title: '${title}'`);

  // Pick sources based on content type + config
  const enabledPengu = PENGUPLAY_SOURCES.filter((s) => {
    if (config[`source_${s.slug}`] === false) return false;
    if (target.type === 'anime') return s.type === 'anime';
    return s.type === 'movie_series';
  });

  const enabledEmbed = EMBED_SOURCES.filter((s) => {
    if (config[`source_${s.slug}`] === false) return false;
    return s.enabled;
  });

  // Run PenguPlay sources first (higher quality)
  for (const source of enabledPengu) {
    if (Date.now() > deadline) break;
    if (allStreams.length >= 10) break;
    try {
      const streams = await Promise.race([
        scrapePenguSource(source, target, title),
        new Promise((_, rej) => setTimeout(() => rej(new Error('indexer-timeout')), PER_INDEXER_TIMEOUT_MS)),
      ]);
      if (streams.length > 0) {
        console.log(`[scraper] ${source.slug}: captured ${streams.length} streams`);
        allStreams.push(...streams);
      }
    } catch (e) {
      console.log(`[scraper] ${source.slug}: ${e.message}`);
    }
  }

  // Run embed sources as fallback
  if (allStreams.length < 3) {
    for (const source of enabledEmbed) {
      if (Date.now() > deadline) break;
      if (allStreams.length >= 10) break;
      try {
        const streams = await Promise.race([
          scrapeEmbedSource(source, target),
          new Promise((_, rej) => setTimeout(() => rej(new Error('embed-timeout')), PER_INDEXER_TIMEOUT_MS)),
        ]);
        if (streams.length > 0) {
          console.log(`[scraper] ${source.slug}: captured ${streams.length} streams`);
          allStreams.push(...streams);
        }
      } catch (e) {
        console.log(`[scraper] ${source.slug}: ${e.message}`);
      }
    }
  }

  // Close browser if we opened one
  if (_browser) {
    try { await _browser.close(); } catch {}
    _browser = null;
  }

  // Dedupe by URL
  const seen = new Set();
  const unique = [];
  for (const s of allStreams) {
    if (!seen.has(s.url)) {
      seen.add(s.url);
      unique.push(s);
    }
  }

  console.log(`[scraper] total unique streams: ${unique.length}`);

  // Prepend donation banner (PenguPlay-style)
  const donationBanner = {
    name: '✨ HerumHai',
    description: 'Free real-time stream addon. Star us on GitHub!',
    externalUrl: PUBLIC_BASE_URL,
  };

  return [donationBanner, ...unique];
}

// ---------------------------------------------------------------------------
// Vercel Serverless Function Entry
// ----------------------------------------------------------------------------

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();

  const { type, id } = req.query;
  let parsedType = type;
  let parsedId = id;
  let config = {};

  if (!parsedType || !parsedId) {
    const parts = (req.url || '').split('?')[0].split('/').filter(Boolean);
    if (parts.length >= 4 && parts[0] === 'api' && parts[1] === 'stream') {
      parsedType = parts[2];
      parsedId = parts[3];
    }
  }

  if (!parsedType || !parsedId) {
    return res.status(400).json({
      error: 'Missing type or id',
      usage: '/api/stream?type=movie&id=tt1375666',
    });
  }

  // Parse optional config from query string (?source_4khdhub=false&res_720=false)
  for (const [k, v] of Object.entries(req.query)) {
    if (k.startsWith('source_') || k.startsWith('res_') || k.startsWith('audio_')) {
      config[k] = v !== 'false' && v !== '0';
    }
  }

  const target = parseId(parsedType, parsedId);
  console.log(`\n[/api/stream] ${parsedType}/${parsedId} →`, JSON.stringify(target));

  try {
    const streams = await resolveStreams(target, config);
    return res.status(200).json({ streams });
  } catch (e) {
    console.error(`[/api/stream] fatal: ${e.message}`);
    return res.status(200).json({ streams: [] });
  }
}
