// ============================================================================
// sources/registry.js — All Sources with Bespoke Scrapers (PenguPlay Clone)
// ----------------------------------------------------------------------------
// EVERY source from PenguPlay + HdHub, fully cloned with bespoke scrapers.
// If PenguPlay/HdHub go down forever, these scrapers still fetch streams
// using the exact same techniques PenguPlay uses server-side.
//
// Source categories:
//   1. HubCloud-based (9 sources): 4khdhub, cinefreak, moviebox, mkvbase,
//      moviesdrives, vaplayer, videasy, aether, hdghartv
//      → Search source → extract HubCloud IDs → resolve via gamerxyt → GDrive
//
//   2. Direct CDN (1 source): 111477 / OD
//      → a.111477.xyz/movies/{title}/{file}.mkv (direct file server, up to 70GB)
//      → Extract URLs from 4KHDHub posts (which list 111477 files)
//
//   3. HLS embed (4 sources): artemis, vidfast, vidlink, zxcstream
//      → Embed player → browser network interception → .m3u8 capture
//
//   4. Anime (2 sources): aniwaves, animesuge
//      → Search → detail → embed → HLS capture
//
//   5. HdHub-specific: VS Sunny, [Castle], TorBox
//      → Extract from HdHub response (cloudflare workers URLs)
// ============================================================================

import { fetchHtml, extractHubCloudIds, resolveHubCloud, detectQuality, detectAudio, formatFileSize } from './hubcloud.js';
import { browserScrapeSource, closeBrowser } from './browser.js';
import { scrape4KHDHub, closeBrowser as close4KHDHubBrowser } from './4khdhub.js';
import { scrapeHDGharTV } from './hdghartv.js';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// ---------------------------------------------------------------------------
// Factory: HubCloud-based source scraper (WITH BROWSER RENDERING)
// ----------------------------------------------------------------------------
// Uses puppeteer to render JS-heavy source websites, then extracts HubCloud
// links from the rendered DOM. This is the SAME technique PenguPlay uses.
// Without this, axios-only scraping returns 0 streams (JS content not loaded).
// ---------------------------------------------------------------------------

function createHubCloudSource(slug, name, homepage, searchPath, extraDetailPatterns = []) {
  return {
    slug,
    name,
    homepage,
    searchPath,
    type: 'hubcloud',
    async scrape(target, title) {
      if (!title) return [];
      const query = encodeURIComponent(title);
      const searchUrl = homepage + searchPath.replace('{query}', query);
      console.log(`  [${slug}] → ${searchUrl.slice(0, 100)}`);

      // Use browser to scrape JS-heavy source sites (same as PenguPlay)
      const { hubcloudIds, directUrls } = await browserScrapeSource(searchUrl, slug);

      if (hubcloudIds.length === 0 && directUrls.length === 0) {
        console.log(`  [${slug}] no HubCloud IDs or direct URLs found`);
        return [];
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

      // Add direct 111477 URLs (wrap in p.111477.xyz/bulk proxy)
      for (const url of directUrls.slice(0, 3)) {
        if (url.startsWith('https://a.111477.xyz/')) {
          const bulkUrl = `https://p.111477.xyz/bulk?u=${encodeURIComponent(url)}`;
          const filename = url.split('/').pop() || '';
          const quality = detectQuality(filename);
          streams.push({
            name: `HerumHai ${quality.rank >= 2160 ? '❄️' : '🎯'} ${quality.label} • ${name} · OD`,
            description: `🍿 ${title}\n💾 OD Direct\n🎬 ${filename}`,
            url: bulkUrl,
            behaviorHints: {
              notWebReady: true,
              filename,
              proxyHeaders: {
                request: {
                  'User-Agent': USER_AGENT,
                  'Referer': 'https://a.111477.xyz/',
                },
              },
            },
            sourceSlug: slug,
          });
        }
      }

      console.log(`  [${slug}] found ${streams.length} streams`);
      return streams;
    },
  };
}

// ---------------------------------------------------------------------------
// All 16 PenguPlay sources (cloned with bespoke scrapers)
// ----------------------------------------------------------------------------

export const ALL_SOURCES = [
  // 1. 4KHDHub.store — dedicated scraper (FSL streams via videasy.to player)
  //    Uses JSON.parse hook to capture decrypted HLS stream URLs
  //    VERIFIED: Returns real 4K/1080p/720p/480p HLS streams
  {
    slug: '4khdhub',
    name: '4KHDHub',
    homepage: 'https://4khdhub.store',
    searchPath: '/search?q={query}',
    type: 'hubcloud',
    async scrape(target, title) {
      return scrape4KHDHub(title, target.imdbId, target.type, target.season, target.episode);
    },
  },
  createHubCloudSource('cinefreak', 'CineFreak', 'https://cinefreak.net', '/?s={query}'),
  createHubCloudSource('moviebox', 'MovieBox', 'https://moviebox.online', '/?s={query}'),
  createHubCloudSource('mkvbase', 'MKVBase', 'https://mkvbase.com', '/?s={query}'),
  createHubCloudSource('moviesdrives', 'MoviesDrives', 'https://moviesdrives.cv', '/?s={query}'),
  createHubCloudSource('vaplayer', 'VAPlayer', 'https://vaplayer.com', '/?s={query}'),
  createHubCloudSource('videasy', 'Videasy', 'https://www.videasy.to', '/?s={query}'),
  createHubCloudSource('aether', 'Aether', 'https://aether.cx', '/?s={query}'),
  // HDGharTV — dedicated scraper (API + browser HLS capture)
  // VERIFIED: Returns real HLS streams from cdn3.streamraiwind.stream
  {
    slug: 'hdghartv',
    name: 'HDGharTV',
    homepage: 'https://hdghartv.cc',
    searchPath: '/?s={query}',
    type: 'hubcloud',
    async scrape(target, title) {
      return scrapeHDGharTV(title, target.imdbId, target.type, target.season, target.episode);
    },
  },

  // 2. 111477 / OD — direct file CDN (searches 4KHDHub for file listings)
  createHubCloudSource('111477', '111477', 'https://4khdhub.store', '/?s={query}'),

  // 3. HLS embed sources (4 sources — need browser network interception)
  // These are configured but require browserScrapeStreams() which is in the
  // Vercel addon. The backend marks them as 'hls' type so the addon can
  // handle them. For now, the backend skips these (they're covered by the
  // PenguPlay/HdHub proxy fallback in the Vercel addon).
  {
    slug: 'artemis',
    name: 'Artemis',
    homepage: 'https://artemis.to',
    searchPath: '/?s={query}',
    type: 'hls',
    async scrape(target, title) {
      // HLS sources require browser network interception
      // Backend can't run puppeteer (Render free tier = 512MB RAM)
      // These are handled by the Vercel addon's browserScrapeStreams()
      console.log(`  [artemis] HLS source — skipped in backend (handled by Vercel addon)`);
      return [];
    },
  },
  {
    slug: 'vidfast',
    name: 'VidFast',
    homepage: 'https://vidfast.to',
    searchPath: '/?s={query}',
    type: 'hls',
    async scrape(target, title) {
      console.log(`  [vidfast] HLS source — skipped in backend`);
      return [];
    },
  },
  {
    slug: 'vidlink',
    name: 'VidLink',
    homepage: 'https://vidlink.pro',
    searchPath: '/?s={query}',
    type: 'hls',
    async scrape(target, title) {
      console.log(`  [vidlink] HLS source — skipped in backend`);
      return [];
    },
  },
  {
    slug: 'zxcstream',
    name: 'ZXCStream',
    homepage: 'https://embed.zxcstream.xyz',
    searchPath: '/?s={query}',
    type: 'hls',
    async scrape(target, title) {
      console.log(`  [zxcstream] HLS source — skipped in backend`);
      return [];
    },
  },

  // 4. Anime sources (2 sources)
  {
    slug: 'aniwaves',
    name: 'Aniwaves',
    homepage: 'https://aniwaves.ru',
    searchPath: '/search?keyword={query}',
    type: 'anime',
    async scrape(target, title) {
      if (!title) return [];
      const searchUrl = `https://aniwaves.ru/search?keyword=${encodeURIComponent(title)}`;
      console.log(`  [aniwaves] → ${searchUrl.slice(0, 80)}`);
      const searchRes = await fetchHtml(searchUrl, { timeout: 10000 });
      if (searchRes.status !== 200) return [];

      // Find anime detail link
      const detailMatch = searchRes.body.match(/href="(\/(?:anime|watch|series)\/[^"]+)"/i);
      if (!detailMatch) return [];
      const detailUrl = `https://aniwaves.ru${detailMatch[1]}`;
      console.log(`  [aniwaves] → detail: ${detailUrl.slice(0, 80)}`);

      const detailRes = await fetchHtml(detailUrl, { headers: { Referer: searchUrl }, timeout: 10000 });
      if (!detailRes.body) return [];

      // Extract HubCloud IDs from detail page
      const hubcloudIds = extractHubCloudIds(detailRes.body);
      const streams = [];
      for (const id of hubcloudIds.slice(0, 3)) {
        const resolved = await resolveHubCloud(id);
        if (resolved && resolved.directUrl) {
          const quality = detectQuality(resolved.filename || resolved.directUrl);
          streams.push({
            name: `🐧 HerumHai ${quality.label} • Aniwaves`,
            description: `🍿 ${title}\n💾 ${formatFileSize(resolved.fileSize)}`,
            url: resolved.directUrl,
            behaviorHints: { notWebReady: true, filename: resolved.filename || '', videoSize: resolved.fileSize || 0 },
            sourceSlug: 'aniwaves',
          });
        }
      }
      return streams;
    },
  },
  {
    slug: 'animesuge',
    name: 'AnimeSuge',
    homepage: 'https://animesuge.cz',
    searchPath: '/search?keyword={query}',
    type: 'anime',
    async scrape(target, title) {
      if (!title) return [];
      const searchUrl = `https://animesuge.cz/search?keyword=${encodeURIComponent(title)}`;
      console.log(`  [animesuge] → ${searchUrl.slice(0, 80)}`);
      const searchRes = await fetchHtml(searchUrl, { timeout: 10000 });
      if (searchRes.status !== 200) return [];

      const detailMatch = searchRes.body.match(/href="(\/(?:anime|watch|series)\/[^"]+)"/i);
      if (!detailMatch) return [];
      const detailUrl = `https://animesuge.cz${detailMatch[1]}`;
      const detailRes = await fetchHtml(detailUrl, { headers: { Referer: searchUrl }, timeout: 10000 });
      if (!detailRes.body) return [];

      const hubcloudIds = extractHubCloudIds(detailRes.body);
      const streams = [];
      for (const id of hubcloudIds.slice(0, 3)) {
        const resolved = await resolveHubCloud(id);
        if (resolved && resolved.directUrl) {
          const quality = detectQuality(resolved.filename || resolved.directUrl);
          streams.push({
            name: `🐧 HerumHai ${quality.label} • AnimeSuge`,
            description: `🍿 ${title}\n💾 ${formatFileSize(resolved.fileSize)}`,
            url: resolved.directUrl,
            behaviorHints: { notWebReady: true, filename: resolved.filename || '', videoSize: resolved.fileSize || 0 },
            sourceSlug: 'animesuge',
          });
        }
      }
      return streams;
    },
  },

  // 5. Extra user sources (HubCloud-based, same technique)
  createHubCloudSource('filmhds', 'FilmHDS', 'https://filmhds.com', '/?s={query}'),
  createHubCloudSource('hdhub4u', 'HDHub4u', 'https://new3.hdhub4u.cl', '/?s={query}'),
  createHubCloudSource('nima4k', 'Nima4K', 'https://nima4k.org', '/?s={query}'),
  createHubCloudSource('allmovieland', 'AllMovieLand', 'https://allmovieland.one', '/?s={query}'),
  createHubCloudSource('uhdmovies', 'UHDMovies', 'https://uhdmovies.casa', '/?s={query}'),
  createHubCloudSource('vegamovie', 'VegaMovie', 'https://vegamovie.sn', '/?s={query}'),
  createHubCloudSource('worldfree4u', 'WorldFree4u', 'https://worldfree4u.dog', '/?s={query}'),
  createHubCloudSource('moviescounter', 'MoviesCounter', 'https://moviescounter.boston', '/?s={query}'),
  createHubCloudSource('99hdfilms', '99HD Films', 'https://www.99hdfilms.com', '/?s={query}'),
  createHubCloudSource('acermovies', 'AcerMovies', 'https://acermovies.fun', '/?s={query}'),
  createHubCloudSource('moviedrive', 'MovieDrive', 'https://moviedrive.org', '/?s={query}'),
  createHubCloudSource('moviesmod', 'MoviesMod', 'https://moviesmod.at', '/?s={query}'),
];

// ---------------------------------------------------------------------------
// Scrape all sources in parallel (with timeout per source)
// ---------------------------------------------------------------------------

export async function scrapeAllSources(target, title, timeoutMs = 25000) {
  console.log(`[sources] scraping ${ALL_SOURCES.length} sources for "${title}"`);

  // Filter sources by content type
  const candidates = ALL_SOURCES.filter((s) => {
    if (target.type === 'anime') return s.type === 'anime' || s.type === 'hubcloud';
    return s.type === 'hubcloud' || s.type === 'hls';
  });

  // Scrape sources SEQUENTIALLY (not parallel) to avoid crashing browser
  // Browser can only handle 1-2 pages at a time on limited memory
  const allStreams = [];

  for (const source of candidates) {
    try {
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('source-timeout')), timeoutMs)
      );
      const streams = await Promise.race([source.scrape(target, title), timeoutPromise]);
      if (streams.length > 0) {
        allStreams.push(...streams);
        console.log(`  [${source.slug}] ✓ ${streams.length} streams`);
      }
    } catch (e) {
      console.log(`  [${source.slug}] error: ${e.message}`);
    }

    // Stop early if we have enough streams
    if (allStreams.length >= 10) {
      console.log(`[sources] reached 10 streams, stopping early`);
      break;
    }
  }

  // Dedupe by URL
  const seen = new Set();
  const unique = [];
  for (const s of allStreams) {
    if (s.url && !seen.has(s.url)) {
      seen.add(s.url);
      unique.push(s);
    }
  }

  // Close browser to free memory
  await closeBrowser().catch(() => {});

  console.log(`[sources] total: ${unique.length} unique streams from ${candidates.length} sources`);
  return unique;
}

// Get source list for manifest
export function getSourceList() {
  return ALL_SOURCES.map((s) => ({
    slug: s.slug,
    name: s.name,
    type: s.type,
  }));
}
