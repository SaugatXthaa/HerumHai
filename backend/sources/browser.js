// ============================================================================
// sources/browser.js — Browser-based scraper for JS-heavy sites
// ----------------------------------------------------------------------------
// This is the MISSING PIECE that makes our cloned sources work independently.
// PenguPlay uses server-side puppeteer to render JS-heavy source websites.
// Now we do the same.
//
// Flow:
//   1. Launch headless Chromium
//   2. Navigate to source's search page (?s=Inception)
//   3. Wait for JavaScript to load search results
//   4. Extract HubCloud links from the RENDERED DOM (not raw HTML)
//   5. Also extract a.111477.xyz direct file URLs
//   6. Return all found URLs for HubCloud resolution
// ============================================================================

import puppeteer from 'puppeteer';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

let _browser = null;
let _browserLaunchPromise = null;

async function getBrowser() {
  if (_browser && _browser.connected) return _browser;
  if (_browserLaunchPromise) return _browserLaunchPromise;

  _browserLaunchPromise = (async () => {
    _browser = await puppeteer.launch({
      headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-sync',
        '--disable-translate',
        '--mute-audio',
        '--no-first-run',
          '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
      ],
      defaultViewport: { width: 1366, height: 768 },
    });
    console.log('[browser] Chromium launched (stealth mode)');
    _browserLaunchPromise = null;
    return _browser;
  })();
  return _browserLaunchPromise;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Scrape a source website using a real browser.
 * Renders JavaScript, waits for content to load, extracts HubCloud links.
 */
export async function browserScrapeSource(searchUrl, sourceName) {
  let page = null;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();

    await page.setUserAgent(USER_AGENT);
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    // ANTI-BOT OVERRIDES — PenguPlay's exact technique:
    // Inject before every page navigation to spoof automation signatures
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      window.chrome = { runtime: {} };
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
    });

    // Block ads/trackers to speed up page load
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const url = req.url();
      const blocked = [
        'googlesyndication.com', 'googletagmanager.com', 'doubleclick.net',
        'google-analytics.com', 'facebook.com', 'coinhive.com', 'adsterra.com',
        'propellerads.com', 'popads.net', 'popcash.net', 'exoclick.com',
        'mgid.com', 'taboola.com', 'outbrain.com', 'cloudflareinsights.com',
        'push-sdk.com', 'adsboosters.xyz',
      ];
      if (blocked.some((d) => url.includes(d))) {
        req.abort();
      } else {
        req.continue();
      }
    });

    console.log(`  [browser:${sourceName}] navigating to ${searchUrl.slice(0, 80)}...`);

    await page.goto(searchUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    // CLOUDFLARE BYPASS — PenguPlay's exact technique:
    // 1. Wait 6 seconds for CF Turnstile to self-verify
    // 2. Check if "Just a moment..." title appears
    // 3. If yes, wait 8 more seconds for challenge to complete
    // 4. Also inject anti-bot overrides (webdriver, chrome, plugins)
    await sleep(6000);

    let pageTitle = await page.title().catch(() => '');
    if (/just a moment|cloudflare|attention required|checking your browser/i.test(pageTitle)) {
      console.log(`  [browser:${sourceName}] CF challenge detected — waiting 8 more seconds...`);
      await sleep(8000);
      pageTitle = await page.title().catch(() => '');
      if (/just a moment|cloudflare/i.test(pageTitle)) {
        console.log(`  [browser:${sourceName}] CF still blocking after 14s — trying page reload...`);
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await sleep(6000);
      }
    }

    // Additional 2s settle after CF check (PenguPlay pattern)
    await sleep(2000);

    // Extract ALL links and HTML from the rendered page
    const pageData = await page.evaluate(() => {
      const allLinks = Array.from(document.querySelectorAll('a[href]')).map((a) => ({
        href: a.href,
        text: (a.textContent || '').trim().slice(0, 100),
      }));
      const html = document.documentElement.outerHTML;
      return { allLinks, html };
    });

    // Extract HubCloud IDs from rendered HTML
    const hubcloudIds = [];
    const hcRegex = /hubcloud\.(?:ist|cx|club|fans)\/drive\/([A-Za-z0-9_-]+)/gi;
    let m;
    while ((m = hcRegex.exec(pageData.html)) !== null) {
      if (!hubcloudIds.includes(m[1])) hubcloudIds.push(m[1]);
    }

    // Extract a.111477.xyz direct URLs
    const directUrls = [];
    const odRegex = /https?:\/\/a\.111477\.xyz\/[^\s"'<>]+/gi;
    while ((m = odRegex.exec(pageData.html)) !== null) {
      if (!directUrls.includes(m[0]) && !m[0].includes('tutorial') && !m[0].includes('sample')) {
        directUrls.push(m[0]);
      }
    }

    // Extract hubdrive.tips/file/{id} URLs — these redirect to HubCloud!
    // PenguPlay's sources use hubdrive.tips as an intermediary to HubCloud
    const hubdriveUrls = [];
    const hdRegex = /https?:\/\/hubdrive\.tips\/file\/(\d+)/gi;
    while ((m = hdRegex.exec(pageData.html)) !== null) {
      if (!hubdriveUrls.includes(m[0])) hubdriveUrls.push(m[0]);
    }

    // Follow hubdrive.tips links to get HubCloud IDs (they redirect)
    for (const hdUrl of hubdriveUrls.slice(0, 5)) {
      try {
        console.log(`  [browser:${sourceName}] following hubdrive: ${hdUrl.slice(0, 60)}...`);
        await page.goto(hdUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await sleep(2000);
        const hdHtml = await page.evaluate(() => document.documentElement.outerHTML);
        // Extract HubCloud ID from the redirected page
        const hdRegex2 = /hubcloud\.(?:ist|cx|club|fans)\/drive\/([A-Za-z0-9_-]+)/gi;
        let m2;
        while ((m2 = hdRegex2.exec(hdHtml)) !== null) {
          if (!hubcloudIds.includes(m2[1])) {
            hubcloudIds.push(m2[1]);
            console.log(`  [browser:${sourceName}] ✓ HubCloud ID from hubdrive: ${m2[1]}`);
          }
        }
      } catch (e) {
        console.log(`  [browser:${sourceName}] hubdrive follow failed: ${e.message}`);
      }
    }

    // Find detail page link — look for ANY link that looks like a movie page
    // (not just /movie/ or /film/ — also /{slug}/ patterns on WordPress sites)
    let detailUrl = null;
    for (const link of pageData.allLinks) {
      const href = link.href;
      const text = link.text;
      // Skip wp-content, uploads, favicon, etc.
      if (/wp-content|uploads|favicon|logo|\.png|\.jpg|\.gif|\.ico|\.css|\.js/i.test(href)) continue;
      // Skip navigation/category links
      if (/\/category\/|\/genre\/|\/page\//i.test(href)) continue;
      // Look for detail pages: /{slug}/, /movie/{id}, /film/{slug}, /watch/{id}
      // Also match if the link text contains the movie title
      if (text && text.length > 10) {
        // Match any link that looks like a movie detail page
        if (/\/\d{4}\/|\/movie\/|\/film\/|\/series\/|\/watch\/|\/tv\/|\/episode\//i.test(href)) {
          detailUrl = href;
          break;
        }
        // WordPress-style: /{movie-slug}/
        const path = new URL(href).pathname;
        if (path && path.split('/').filter(Boolean).length === 1 && path.length > 10) {
          detailUrl = href;
          break;
        }
      }
    }

    // ALWAYS check detail page (even if we found HubCloud IDs — there might be more)
    if (detailUrl) {
      console.log(`  [browser:${sourceName}] checking detail: ${detailUrl.slice(0, 80)}...`);
      try {
        await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await sleep(3000);

        const detailHtml = await page.evaluate(() => document.documentElement.outerHTML);

        // Extract HubCloud IDs from detail page
        while ((m = hcRegex.exec(detailHtml)) !== null) {
          if (!hubcloudIds.includes(m[1])) hubcloudIds.push(m[1]);
        }

        // Extract a.111477.xyz URLs from detail page
        const detailOdRegex = /https?:\/\/a\.111477\.xyz\/[^\s"'<>]+/gi;
        while ((m = detailOdRegex.exec(detailHtml)) !== null) {
          if (!directUrls.includes(m[0]) && !m[0].includes('tutorial') && !m[0].includes('sample')) {
            directUrls.push(m[0]);
          }
        }

        // Extract hubdrive.tips links from detail page (KEY: this is how HDHub4u links to HubCloud)
        const detailHdRegex = /https?:\/\/hubdrive\.tips\/file\/(\d+)/gi;
        const detailHubdriveUrls = [];
        while ((m = detailHdRegex.exec(detailHtml)) !== null) {
          if (!detailHubdriveUrls.includes(m[0])) detailHubdriveUrls.push(m[0]);
        }

        // Follow hubdrive.tips links from detail page
        for (const hdUrl of detailHubdriveUrls.slice(0, 5)) {
          try {
            console.log(`  [browser:${sourceName}] following hubdrive: ${hdUrl.slice(0, 60)}...`);
            await page.goto(hdUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
            await sleep(2000);
            const hdHtml = await page.evaluate(() => document.documentElement.outerHTML);
            const hdRegex2 = /hubcloud\.(?:ist|cx|club|fans)\/drive\/([A-Za-z0-9_-]+)/gi;
            let m2;
            while ((m2 = hdRegex2.exec(hdHtml)) !== null) {
              if (!hubcloudIds.includes(m2[1])) {
                hubcloudIds.push(m2[1]);
                console.log(`  [browser:${sourceName}] ✓ HubCloud ID from hubdrive: ${m2[1]}`);
              }
            }
          } catch (e) {
            console.log(`  [browser:${sourceName}] hubdrive follow failed: ${e.message}`);
          }
        }

        // Also extract gadgetsweb.xyz links (they may redirect to HubCloud too)
        const gadgetsRegex = /https?:\/\/gadgetsweb\.xyz\/\?id=([A-Za-z0-9+/=]+)/gi;
        const gadgetsUrls = [];
        while ((m = gadgetsRegex.exec(detailHtml)) !== null) {
          if (!gadgetsUrls.includes(m[0])) gadgetsUrls.push(m[0]);
        }
        // Note: gadgetsweb.xyz redirects to ad pages, not HubCloud directly
        // Skip following these for now (they're ad gateways)

      } catch (e) {
        console.log(`  [browser:${sourceName}] detail failed: ${e.message}`);
      }
    }

    console.log(`  [browser:${sourceName}] found ${hubcloudIds.length} HubCloud IDs, ${directUrls.length} direct URLs`);
    return { hubcloudIds, directUrls, detailUrl };
  } catch (e) {
    console.log(`  [browser:${sourceName}] error: ${e.message}`);
    return { hubcloudIds: [], directUrls: [], detailUrl: null };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

export async function closeBrowser() {
  if (_browser) {
    await _browser.close().catch(() => {});
    _browser = null;
    console.log('[browser] closed');
  }
}
