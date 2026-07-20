// ============================================================================
// sources/stealth_browser.js — Stealth Browser Factory (ESM)
// ----------------------------------------------------------------------------
// Production-grade CF bypass for aggressively-blocked sources:
//   zxcstream, filmxy, cinemacity, ddlbase, aether, vaplayer
//
// Strict compliance:
//   - puppeteer-extra + StealthPlugin (mandatory)
//   - Authenticated HTTP proxy via env vars (PROXY_URL or PROXY_HOST/PORT/USER/PASS)
//   - UA aligned with bundled Chromium major version (avoids JA3/JA4 mismatch)
//   - Realistic viewport (1920x1080), WebRTC leak patch, navigator overrides
//   - 30s+ timeouts (residential-proxy friendly)
//   - Reusable browser pool (avoid cold-start cost per request)
//
// Env vars (set on Render.com):
//   PROXY_URL=http://user:pass@host:port   (preferred)
//   OR
//   PROXY_HOST=us.smartproxy.com
//   PROXY_PORT=10000
//   PROXY_USERNAME=sp_user
//   PROXY_PASSWORD=sp_pass
// ============================================================================

import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import AnonymizeUA from 'puppeteer-extra-plugin-anonymize-ua';

// Register plugins ONCE — idempotent guard
let _pluginsRegistered = false;
function registerPlugins() {
  if (_pluginsRegistered) return;
  puppeteer.use(StealthPlugin());
  puppeteer.use(AnonymizeUA());
  _pluginsRegistered = true;
}

// ---------- Proxy config ----------
function buildProxyUrl() {
  if (process.env.PROXY_URL) return process.env.PROXY_URL;
  const host = process.env.PROXY_HOST;
  const port = process.env.PROXY_PORT;
  const user = encodeURIComponent(process.env.PROXY_USERNAME || '');
  const pass = encodeURIComponent(process.env.PROXY_PASSWORD || '');
  if (!host || !port) return null;
  return `http://${user}:${pass}@${host}:${port}`;
}

// ---------- Chromium UA alignment ----------
// puppeteer v25.x ships Chromium ~134. Keep this synced with
// `puppeteer.executablePath()` Chromium major after every puppeteer bump.
const BUNDLED_CHROMIUM_MAJOR = 134;
export const ALIGNED_UA =
  `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ` +
  `(KHTML, like Gecko) Chrome/${BUNDLED_CHROMIUM_MAJOR}.0.0.0 Safari/537.36`;

// ---------- Browser pool (singleton) ----------
let _browserPromise = null;

export async function getBrowser() {
  if (_browserPromise) return _browserPromise;
  registerPlugins();

  const proxyUrl = buildProxyUrl();
  const launchOpts = {
    headless: 'new',
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--no-first-run',
      '--no-zygote',
      '--disable-software-rasterizer',
      '--disable-features=IsolateOrigins,site-per-process',
      '--window-size=1920,1080',
      `--user-agent=${ALIGNED_UA}`,
      // WebRTC leak prevention — stops CF from detecting real IP via STUN
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--webrtc-ip-handling-policy=disable_non_proxied_udp',
    ],
    defaultViewport: { width: 1920, height: 1080 },
    timeout: 60000, // 60s for browser cold-start behind proxy
  };

  if (proxyUrl) {
    launchOpts.args.push(`--proxy-server=${proxyUrl}`);
    const masked = proxyUrl.replace(/:[^:@]+@/, ':***@');
    console.log(`[stealth] using authenticated proxy: ${masked}`);
  } else {
    console.warn('[stealth] no proxy configured — CF may detect datacenter IP.');
  }

  _browserPromise = puppeteer.launch(launchOpts);
  _browserPromise.catch(() => { _browserPromise = null; });
  return _browserPromise;
}

// ---------- Page factory ----------
/**
 * Create a stealth-hardened page.
 * @param {object}  opts
 * @param {number}  [opts.timeout=45000]  navigation timeout (ms)
 * @param {string}  [opts.referer]        explicit referer to spoof
 * @param {boolean} [opts.blockAds=true]  block ad/tracker domains
 * @returns {Promise<import('puppeteer').Page>}
 */
export async function newStealthPage({ timeout = 45000, referer, blockAds = true } = {}) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  // Reinforce UA + client hints at page level (must match bundled Chromium)
  await page.setUserAgent(ALIGNED_UA, {
    architecture: 'x86',
    bitness: '64',
    mobile: false,
    model: '',
    platform: 'Linux',
    platformVersion: '6.5.0',
    wow64: false,
    fullVersionList: [{
      brand: 'Chromium',
      version: `${BUNDLED_CHROMIUM_MAJOR}.0.0.0`,
    }],
  });

  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
  await page.setDefaultNavigationTimeout(timeout);
  await page.setDefaultTimeout(timeout);

  // Headers that scream "real browser"
  const headers = {
    'Accept-Language': 'en-US,en;q=0.9,hi;q=0.8',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Sec-Ch-Ua': `"Chromium";v="${BUNDLED_CHROMIUM_MAJOR}", "Not(A:Brand";v="24", "Google Chrome";v="${BUNDLED_CHROMIUM_MAJOR}"`,
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Linux"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': referer ? 'cross-site' : 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
  };
  if (referer) headers['Referer'] = referer;
  await page.setExtraHTTPHeaders(headers);

  // Block ad/tracker domains to reduce noise & speed up CF challenge
  if (blockAds) {
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const url = req.url();
      const blocked = [
        'googlesyndication.com', 'googletagmanager.com', 'doubleclick.net',
        'google-analytics.com', 'facebook.com', 'coinhive.com', 'adsterra.com',
        'propellerads.com', 'popads.net', 'popcash.net', 'exoclick.com',
        'mgid.com', 'taboola.com', 'outbrain.com', 'cloudflareinsights.com',
        'push-sdk.com', 'adsboosters.xyz', 'pubfuture.com', 'monetag.com',
      ];
      if (blocked.some((d) => url.includes(d))) {
        req.abort();
      } else {
        req.continue();
      }
    });
  }

  // Extra runtime hardening (stealth plugin covers most, but be explicit)
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en', 'hi'] });
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5].map((i) => ({
        name: `Plugin ${i}`,
        description: `Mock plugin ${i}`,
        filename: `plugin${i}.so`,
        length: 1,
      })),
    });
    window.chrome = window.chrome || {
      runtime: {}, app: {}, csi: () => {}, loadTimes: () => {},
    };
    const origQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (p) =>
      p.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : origQuery(p);
  });

  return page;
}

// ---------- CF challenge waiter ----------
/**
 * Navigate and wait for CF challenge to clear.
 * Handles "Just a moment..." interstitial AND Turnstile widget.
 * @param {import('puppeteer').Page} page
 * @param {string} url
 * @param {object}  [opts]
 * @param {number}  [opts.maxWait=20000]  max ms to wait for CF clearance
 * @param {string}  [opts.referer]
 */
export async function navigateWithCFWait(page, url, { maxWait = 20000, referer } = {}) {
  await page.goto(url, { waitUntil: 'domcontentloaded', referer });

  const start = Date.now();
  while (Date.now() - start < maxWait) {
    const title = await page.title().catch(() => '');
    const bodyText = await page.evaluate(() =>
      document.body ? document.body.innerText.slice(0, 500) : ''
    ).catch(() => '');

    const isCFChallenge =
      /just a moment|checking your browser|attention required|cf-turnstile|cloudflare/i.test(title) ||
      /just a moment|checking your browser|enable javascript|attention required/i.test(bodyText);

    if (!isCFChallenge) return true;

    // Try clicking the Turnstile checkbox if present (no-click challenge auto-resolves)
    try {
      const frame = page.frames().find((f) => /challenges\.cloudflare/.test(f.url()));
      if (frame) {
        await frame.click('input[type="checkbox"]').catch(() => {});
      }
    } catch {}

    await new Promise((r) => setTimeout(r, 1500));
  }

  throw new Error(`CF challenge not cleared within ${maxWait}ms for ${url}`);
}

// ---------- Public API ----------
export async function closeBrowser() {
  if (_browserPromise) {
    try {
      const b = await _browserPromise;
      await b.close();
    } catch {}
    _browserPromise = null;
    console.log('[stealth] browser closed');
  }
}
