// ============================================================================
// sources/cf_sources.js — CF-Aggressively-Blocked Source Scrapers
// ----------------------------------------------------------------------------
// Refactored versions of:
//   - zxcstream   (HLS embed player — network intercept for .m3u8)
//   - filmxy      (WordPress movie site — GDrive links behind CF)
//   - cinemacity  (WordPress movie site — HubCloud/GDrive behind CF)
//   - ddlbase     (DDL index/forum — direct DDL links behind CF)
//
// All four use the stealth_browser factory (puppeteer-extra + StealthPlugin +
// authenticated residential proxy + aligned UA).
//
// Pattern for HLS embed sources (zxcstream):
//   1. Build embed URL: https://embed.zxcstream.xyz/movie/{imdbId}
//   2. newStealthPage() → navigateWithCFWait()
//   3. Listen for 'response' events, capture any URL ending in .m3u8
//   4. Return HLS stream objects
//
// Pattern for WordPress movie sites (filmxy, cinemacity, ddlbase):
//   1. Build search URL: https://domain/?s={title}
//   2. newStealthPage() → navigateWithCFWait()
//   3. Extract first detail-page link from rendered DOM
//   4. Navigate to detail → extract GDrive / HubCloud / direct DDL URLs
//   5. Resolve via hubcloud.js if HubCloud IDs found
// ============================================================================

import { newStealthPage, navigateWithCFWait, closeBrowser } from './stealth_browser.js';
import { extractHubCloudIds, resolveHubCloud, detectQuality, detectAudio, formatFileSize } from './hubcloud.js';

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// HLS EMBED SOURCE SCRAPER (zxcstream, vidfast, vidlink)
// ---------------------------------------------------------------------------
/**
 * Generic HLS embed scraper — captures .m3u8 URLs from network traffic.
 * @param {object} opts
 * @param {string} opts.slug        source slug (for logging)
 * @param {string} opts.name        display name
 * @param {string} opts.embedBase   e.g. https://embed.zxcstream.xyz
 * @param {string} opts.embedPath   function (target) => path like /movie/tt123
 * @returns {object} source object
 */
function createHlsEmbedSource({ slug, name, embedBase, embedPath }) {
  return {
    slug,
    name,
    homepage: embedBase,
    searchPath: '',
    type: 'hls',
    async scrape(target, title) {
      const path = embedPath(target);
      if (!path) return [];
      const url = embedBase + path;
      console.log(`  [${slug}] → ${url.slice(0, 90)}`);

      let page;
      try {
        page = await newStealthPage({
          timeout: 45000,
          referer: 'https://www.google.com/',
        });
      } catch (e) {
        console.log(`  [${slug}] browser launch failed: ${e.message}`);
        return [];
      }

      const m3u8Urls = new Set();
      const directUrls = new Set();
      const apiCalls = [];

      // Capture network responses — HLS playlists, direct video files, AND
      // SPA JSON API bodies (scan for embedded stream URLs inside JSON)
      page.on('response', async (resp) => {
        try {
          const u = resp.url();
          // 1. Direct HLS playlists in the URL itself
          if (/\.m3u8(\?|$)/i.test(u)) {
            if (!m3u8Urls.has(u)) {
              m3u8Urls.add(u);
              console.log(`  [${slug}] ✓ HLS captured: ${u.slice(0, 80)}`);
            }
            return;
          }
          // 2. Direct video files in the URL itself
          if (/\.(mp4|mkv|webm)(\?|$)/i.test(u)) {
            if (!directUrls.has(u)) {
              directUrls.add(u);
              console.log(`  [${slug}] ✓ DDL captured: ${u.slice(0, 80)}`);
            }
            return;
          }
          // 3. SPA JSON APIs — scan response body for embedded stream URLs
          //    (this is the SPA API interception technique: many embed players
          //     return stream URLs inside JSON, not as direct .m3u8 requests)
          if (/\/api\/|\/ajax\/|\/embed\/|\/sources?\b|\.json/i.test(u)) {
            const ct = resp.headers()['content-type'] || '';
            if (ct.includes('json') || ct.includes('text')) {
              try {
                const body = await resp.text();
                apiCalls.push({ url: u, status: resp.status() });
                // Scan JSON body for any stream URLs
                const streamRegex = /https?:\/\/[^\s"'<>\]\\\)]+\.(?:m3u8|mp4|mkv|webm)(?:\?[^\s"'<>\]\\\)]*)?/gi;
                let m;
                while ((m = streamRegex.exec(body)) !== null) {
                  const streamUrl = m[0];
                  if (/\.m3u8/i.test(streamUrl)) {
                    if (!m3u8Urls.has(streamUrl)) {
                      m3u8Urls.add(streamUrl);
                      console.log(`  [${slug}] ✓ HLS from JSON API: ${streamUrl.slice(0, 80)}`);
                    }
                  } else if (!directUrls.has(streamUrl)) {
                    directUrls.add(streamUrl);
                    console.log(`  [${slug}] ✓ DDL from JSON API: ${streamUrl.slice(0, 80)}`);
                  }
                }
              } catch {}
            }
          }
        } catch {}
      });

      try {
        await navigateWithCFWait(page, url, { maxWait: 25000 });
      } catch (e) {
        console.log(`  [${slug}] CF/navigation failed: ${e.message}`);
        await page.close().catch(() => {});
        return [];
      }

      // Click the play button if present (some players wait for user gesture)
      try {
        await page.waitForSelector('button, .play-btn, [class*="play"], video', { timeout: 8000 });
        await page.click('button, .play-btn, [class*="play"]').catch(() => {});
      } catch {}

      // Wait for stream URLs to appear in network traffic
      const start = Date.now();
      while (Date.now() - start < 15000 && m3u8Urls.size === 0 && directUrls.size === 0) {
        await sleep(1500);
      }
      // Extra 3s grace period to catch late API calls after play click
      if (m3u8Urls.size > 0 || directUrls.size > 0) {
        await sleep(3000);
      }

      // Log captured API calls for SPA reverse engineering visibility
      if (apiCalls.length > 0) {
        console.log(`  [${slug}] captured ${apiCalls.length} XHR endpoints (SPA API map):`);
        apiCalls.slice(0, 5).forEach((c) => console.log(`    → ${c.status} ${c.url.slice(0, 100)}`));
      }

      await page.close().catch(() => {});

      if (m3u8Urls.size === 0 && directUrls.size === 0) {
        console.log(`  [${slug}] no streams captured`);
        return [];
      }

      // Build HLS stream objects
      const streams = [...m3u8Urls].map((m3u8Url) => {
        const quality = detectQuality(m3u8Url);
        return {
          name: `HerumHai ${quality.rank >= 2160 ? '❄️' : '🎬'} ${quality.label} • ${name}`,
          description: `🍿 ${title}\n📡 HLS Stream\n🎯 Source: ${slug}`,
          url: m3u8Url,
          behaviorHints: {
            notWebReady: false,
            proxyHeaders: {
              request: {
                'User-Agent': USER_AGENT,
                'Referer': embedBase + '/',
              },
            },
          },
          sourceSlug: slug,
        };
      });

      // Build direct-file stream objects (mp4/mkv/webm found in JSON APIs)
      for (const directUrl of directUrls) {
        const filename = directUrl.split('/').pop().split('?')[0] || '';
        const quality = detectQuality(filename || directUrl);
        streams.push({
          name: `HerumHai ${quality.rank >= 2160 ? '❄️' : '🎯'} ${quality.label} • ${name} · DDL`,
          description: `🍿 ${title}\n💾 Direct File\n🎬 ${filename}`,
          url: directUrl,
          behaviorHints: {
            notWebReady: true,
            filename,
            proxyHeaders: {
              request: {
                'User-Agent': USER_AGENT,
                'Referer': embedBase + '/',
              },
            },
          },
          sourceSlug: slug,
        });
      }

      console.log(`  [${slug}] ✓ ${m3u8Urls.size} HLS + ${directUrls.size} DDL streams`);
      return streams;
    },
  };
}

// ---------------------------------------------------------------------------
// WORDPRESS MOVIE SOURCE SCRAPER (filmxy, cinemacity, ddlbase)
// ---------------------------------------------------------------------------
/**
 * CF-blocked WordPress source scraper. Searches → finds detail → extracts
 * GDrive / HubCloud / direct DDL links from rendered DOM.
 * @param {object} opts
 * @param {string} opts.slug
 * @param {string} opts.name
 * @param {string} opts.homepage
 * @param {string[]} [opts.altDomains]  fallback domains if primary is down
 * @param {string} [opts.searchPath='/?s={query}']
 */
function createCFWordPressSource({ slug, name, homepage, altDomains = [], searchPath = '/?s={query}' }) {
  const allDomains = [homepage, ...altDomains];

  return {
    slug,
    name,
    homepage,
    searchPath,
    type: 'hubcloud',
    async scrape(target, title) {
      if (!title) return [];
      const query = encodeURIComponent(title);

      let page;
      try {
        page = await newStealthPage({
          timeout: 45000,
          referer: 'https://www.google.com/',
        });
      } catch (e) {
        console.log(`  [${slug}] browser launch failed: ${e.message}`);
        return [];
      }

      try {
        // Try each domain until one works
        let searchSucceeded = false;
        let workingDomain = null;

        for (const domain of allDomains) {
          const searchUrl = domain + searchPath.replace('{query}', query);
          console.log(`  [${slug}] → ${searchUrl.slice(0, 90)}`);
          try {
            await navigateWithCFWait(page, searchUrl, { maxWait: 25000 });
            // Verify we got real content, not a CF error page
            const title2 = await page.title().catch(() => '');
            if (/just a moment|attention required|cloudflare/i.test(title2)) {
              console.log(`  [${slug}] CF still blocking on ${domain}, trying next domain...`);
              continue;
            }
            searchSucceeded = true;
            workingDomain = domain;
            break;
          } catch (e) {
            console.log(`  [${slug}] ${domain} failed: ${e.message}`);
          }
        }

        if (!searchSucceeded) {
          console.log(`  [${slug}] all domains failed CF check`);
          return [];
        }

        await sleep(2000);

        // Extract ALL links + HTML from rendered search results
        const pageData = await page.evaluate(() => {
          const allLinks = Array.from(document.querySelectorAll('a[href]')).map((a) => ({
            href: a.href,
            text: (a.textContent || '').trim().slice(0, 100),
          }));
          const html = document.documentElement.outerHTML;
          return { allLinks, html };
        });

        // Extract HubCloud IDs from search page (some sites list them inline)
        let hubcloudIds = extractHubCloudIds(pageData.html);

        // Extract direct GDrive / DDL links from search page
        const directUrls = [];
        const gdRegex = /https?:\/\/(?:drive\.google\.com|gdtot|gdflix|gbot|hubcdn|hubdrive)\.[a-z]+\/[^\s"'<>]+/gi;
        let m;
        while ((m = gdRegex.exec(pageData.html)) !== null) {
          if (!directUrls.includes(m[0])) directUrls.push(m[0]);
        }

        // Find detail page link (movie/tv/film slug)
        let detailUrl = null;
        for (const link of pageData.allLinks) {
          const href = link.href;
          const text = link.text;
          if (/wp-content|uploads|favicon|\.png|\.jpg|\.gif|\.ico|\.css|\.js/i.test(href)) continue;
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

        // Visit detail page to extract more links
        if (detailUrl) {
          console.log(`  [${slug}] → detail: ${detailUrl.slice(0, 90)}`);
          try {
            await navigateWithCFWait(page, detailUrl, { maxWait: 20000 });
            await sleep(2500);

            const detailHtml = await page.evaluate(() => document.documentElement.outerHTML);

            // Extract HubCloud IDs from detail
            const detailIds = extractHubCloudIds(detailHtml);
            for (const id of detailIds) {
              if (!hubcloudIds.includes(id)) hubcloudIds.push(id);
            }

            // Extract direct GDrive / DDL links from detail
            while ((m = gdRegex.exec(detailHtml)) !== null) {
              if (!directUrls.includes(m[0])) directUrls.push(m[0]);
            }
          } catch (e) {
            console.log(`  [${slug}] detail failed: ${e.message}`);
          }
        }

        console.log(`  [${slug}] found ${hubcloudIds.length} HubCloud IDs, ${directUrls.length} direct URLs`);

        // Resolve HubCloud IDs → direct CDN URLs
        const streams = [];
        for (const id of hubcloudIds.slice(0, 5)) {
          try {
            const resolved = await resolveHubCloud(id);
            if (resolved && resolved.directUrl) {
              const quality = detectQuality(resolved.filename || resolved.directUrl);
              const audio = detectAudio(resolved.filename);
              streams.push({
                name: `HerumHai ${quality.rank >= 2160 ? '❄️' : '🎯'} ${quality.label} • ${name}`,
                description: `🍿 ${title}\n💾 ${formatFileSize(resolved.fileSize)}\n🎧 Audio: ${audio.join(', ')}`,
                url: resolved.directUrl,
                behaviorHints: {
                  notWebReady: true,
                  filename: resolved.filename || '',
                  videoSize: resolved.fileSize || 0,
                  proxyHeaders: {
                    request: {
                      'User-Agent': USER_AGENT,
                      'Referer': resolved.referer || 'https://hubcloud.cx/',
                    },
                  },
                },
                sourceSlug: slug,
              });
            }
          } catch (e) {
            console.log(`  [${slug}] hubcloud ${id} failed: ${e.message}`);
          }
        }

        // Add direct GDrive / DDL URLs as streams
        for (const url of directUrls.slice(0, 3)) {
          const filename = url.split('/').pop() || '';
          const quality = detectQuality(filename);
          streams.push({
            name: `HerumHai ${quality.rank >= 2160 ? '❄️' : '🎯'} ${quality.label} • ${name} · DDL`,
            description: `🍿 ${title}\n💾 Direct DDL\n🎬 ${filename}`,
            url,
            behaviorHints: {
              notWebReady: true,
              filename,
              proxyHeaders: {
                request: {
                  'User-Agent': USER_AGENT,
                  'Referer': workingDomain + '/',
                },
              },
            },
            sourceSlug: slug,
          });
        }

        console.log(`  [${slug}] ✓ ${streams.length} streams`);
        return streams;
      } finally {
        await page.close().catch(() => {});
      }
    },
  };
}

// ---------------------------------------------------------------------------
// EXPORTED CF-BLOCKED SOURCES
// ---------------------------------------------------------------------------

// Standard embed path builder — works for zxcstream, vidfast, vidlink
// URL patterns: /movie/{imdbId} | /tv/{imdbId}/{SS}/{EE}
// BUGFIX: anime type must also use the TV path (anime is treated as series)
const standardEmbedPath = (target) => {
  if (target.type === 'movie') return `/movie/${target.imdbId}`;
  // series + anime both use the TV endpoint with season/episode
  if (target.type === 'series' || target.type === 'anime') {
    const s = String(target.season || 1).padStart(2, '0');
    const e = String(target.episode || 1).padStart(2, '0');
    return `/tv/${target.imdbId}/${s}/${e}`;
  }
  return null;
};

export const CF_BLOCKED_SOURCES = [
  // 1. ZXCStream — HLS embed player (network interception for .m3u8)
  createHlsEmbedSource({
    slug: 'zxcstream',
    name: 'ZXCStream',
    embedBase: 'https://embed.zxcstream.xyz',
    embedPath: standardEmbedPath,
  }),

  // 2. VidFast — SPA HLS embed player (streams returned via JSON API)
  createHlsEmbedSource({
    slug: 'vidfast',
    name: 'VidFast',
    embedBase: 'https://vidfast.to',
    embedPath: standardEmbedPath,
  }),

  // 3. VidLink — SPA HLS embed player (streams returned via JSON API)
  createHlsEmbedSource({
    slug: 'vidlink',
    name: 'VidLink',
    embedBase: 'https://vidlink.pro',
    embedPath: standardEmbedPath,
  }),

  // 4. Filmxy — WordPress movie site with GDrive links behind CF
  createCFWordPressSource({
    slug: 'filmxy',
    name: 'Filmxy',
    homepage: 'https://filmxy.one',
    altDomains: ['https://filmxy.tv', 'https://filmxy.vip'],
    searchPath: '/?s={query}',
  }),

  // 5. CinemaCity — WordPress movie site behind CF
  createCFWordPressSource({
    slug: 'cinemacity',
    name: 'CinemaCity',
    homepage: 'https://cinemacity.club',
    altDomains: ['https://cinemacity.ws', 'https://cinemacity.org'],
    searchPath: '/?s={query}',
  }),

  // 6. DDLBase — DDL index/forum behind CF
  createCFWordPressSource({
    slug: 'ddlbase',
    name: 'DDLBase',
    homepage: 'https://ddlbase.org',
    altDomains: ['https://ddlbase.to', 'https://ddlbase.net'],
    searchPath: '/?s={query}',
  }),
];

export { closeBrowser as closeCFBrowser };
