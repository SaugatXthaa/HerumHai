// ============================================================================
// sources/hubcloud_browser.js — HubCloud Source Scraper (Puppeteer-based)
// ----------------------------------------------------------------------------
// Uses puppeteer to render JS-heavy source websites (same as PenguPlay),
// then extracts HubCloud links from the rendered DOM.
//
// This is used as a FALLBACK when axios-based scraping returns 0 streams
// (because the site is JS-rendered or CF-protected).
//
// Flow:
//   1. Launch puppeteer with stealth (navigator.webdriver=undefined, etc.)
//   2. Navigate to source's search page (?s=Inception)
//   3. Wait 6 seconds for Cloudflare auto-approval
//   4. If CF challenge, wait 8 more seconds + reload
//   5. Extract HubCloud links from the RENDERED DOM (not raw HTML)
//   6. Also extract a.111477.xyz direct file URLs
//   7. Follow hubdrive.tips links to get HubCloud IDs
//   8. Visit detail page → extract more HubCloud IDs
//   9. Resolve HubCloud IDs → direct CDN URLs
// ============================================================================

import puppeteer from 'puppeteer';
import { extractHubCloudIds, resolveHubCloud, detectQuality, detectAudio, formatFileSize } from './hubcloud.js';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

let _browser = null;

async function getBrowser() {
  if (_browser && _browser.connected) return _browser;
  _browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
    defaultViewport: { width: 1366, height: 768 },
  });
  return _browser;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Scrape a source website using a real browser.
 * Renders JavaScript, waits for content to load, extracts HubCloud links.
 * Same as PenguPlay's approach.
 *
 * @param {string} searchUrl  - Full search URL (e.g., https://cinefreak.net/?s=Inception)
 * @param {string} sourceName - Source name for logging
 * @returns {Promise<{hubcloudIds: string[], directUrls: string[]}>}
 */
export async function browserScrapeSource(searchUrl, sourceName) {
  let page = null;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    // ANTI-BOT OVERRIDES — PenguPlay's exact technique
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

    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });

    // CLOUDFLARE BYPASS — PenguPlay's exact technique:
    // 1. Wait 6 seconds for CF Turnstile to self-verify
    await sleep(6000);

    let pageTitle = await page.title().catch(() => '');
    if (/just a moment|cloudflare|attention required|checking your browser/i.test(pageTitle)) {
      console.log(`  [browser:${sourceName}] CF challenge detected — waiting 8 more seconds...`);
      await sleep(8000);
      pageTitle = await page.title().catch(() => '');
      if (/just a moment|cloudflare/i.test(pageTitle)) {
        console.log(`  [browser:${sourceName}] CF still blocking — trying page reload...`);
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
        await sleep(6000);
      }
    }

    // Additional 2s settle after CF check
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
    const hcRegex = /hubcloud\.(?:ist|cx|club|fans|foo)\/drive\/([A-Za-z0-9_-]+)/gi;
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

    // Extract hubdrive.tips/file/{id} URLs — these redirect to HubCloud
    const hubdriveUrls = [];
    const hdRegex = /https?:\/\/hubdrive\.tips\/file\/(\d+)/gi;
    while ((m = hdRegex.exec(pageData.html)) !== null) {
      if (!hubdriveUrls.includes(m[0])) hubdriveUrls.push(m[0]);
    }

    // Follow hubdrive.tips links to get HubCloud IDs
    for (const hdUrl of hubdriveUrls.slice(0, 5)) {
      try {
        console.log(`  [browser:${sourceName}] following hubdrive: ${hdUrl.slice(0, 60)}...`);
        await page.goto(hdUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await sleep(2000);
        const hdHtml = await page.evaluate(() => document.documentElement.outerHTML);
        const hdRegex2 = /hubcloud\.(?:ist|cx|club|fans|foo)\/drive\/([A-Za-z0-9_-]+)/gi;
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

    // Find detail page link
    let detailUrl = null;
    for (const link of pageData.allLinks) {
      const href = link.href;
      const text = link.text;
      if (/wp-content|uploads|favicon|logo|\.png|\.jpg|\.gif|\.ico|\.css|\.js/i.test(href)) continue;
      if (/\/category\/|\/genre\/|\/page\//i.test(href)) continue;
      if (text && text.length > 10) {
        if (/\/\d{4}\/|\/movie\/|\/film\/|\/series\/|\/watch\/|\/tv\/|\/episode\//i.test(href)) {
          detailUrl = href;
          break;
        }
        const path = new URL(href).pathname;
        if (path && path.split('/').filter(Boolean).length === 1 && path.length > 10) {
          detailUrl = href;
          break;
        }
      }
    }

    // Visit detail page
    if (detailUrl) {
      console.log(`  [browser:${sourceName}] checking detail: ${detailUrl.slice(0, 80)}...`);
      try {
        await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
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

        // Extract hubdrive.tips links from detail page
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
            const hdRegex2 = /hubcloud\.(?:ist|cx|club|fans|foo)\/drive\/([A-Za-z0-9_-]+)/gi;
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
