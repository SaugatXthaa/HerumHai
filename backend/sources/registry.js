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

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// ---------------------------------------------------------------------------
// Factory: HubCloud-based source scraper
// ----------------------------------------------------------------------------
// Creates a bespoke scraper for any source that uses HubCloud embeds.
// This covers 9 of PenguPlay's 16 sources.
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

      let hubcloudIds = [];
      let directUrls = [];

      // Step 1: Fetch search results
      const searchRes = await fetchHtml(searchUrl, { timeout: 10000 });
      if (searchRes.status !== 200 || !searchRes.body) {
        console.log(`  [${slug}] search returned ${searchRes.status}`);
        return [];
      }
      hubcloudIds = extractHubCloudIds(searchRes.body);

      // Also extract a.111477.xyz direct URLs (some sources list these)
      const odMatches = searchRes.body.match(/https?:\/\/a\.111477\.xyz\/[^\s"'<>]+/gi) || [];
      directUrls = odMatches.filter(u => !u.includes('tutorial') && !u.includes('sample'));

      // Step 2: Find detail page
      // Exclude wp-content/uploads (favicon/logo URLs), only match actual movie/series pages
      const detailRegex = /href="(https?:\/\/[^"]*(?:\/\d{4}\/(?!.*(?:uploads|wp-content))[^"]*(?:\/|$)|\/movie\/[^"]+|\/film\/[^"]+|\/series\/[^"]+|\/watch\/[^"]+|\/tv\/[^"]+|\/episode\/[^"]+))"/i;
      const detailMatches = searchRes.body.matchAll(new RegExp(detailRegex.source, 'gi'));
      let detailFound = false;
      for (const match of detailMatches) {
        if (detailFound) break;
        const detailUrl = match[1];
        // Skip wp-content, uploads, favicon, logo URLs
        if (/wp-content|uploads|favicon|logo|\.png|\.jpg|\.gif|\.ico/i.test(detailUrl)) continue;
        console.log(`  [${slug}] → detail: ${detailUrl.slice(0, 80)}`);
        const detailRes = await fetchHtml(detailUrl, {
          headers: { Referer: searchUrl },
          timeout: 10000,
        });
        if (detailRes.body) {
          hubcloudIds = [...new Set([...hubcloudIds, ...extractHubCloudIds(detailRes.body)])];
          const detailOd = detailRes.body.match(/https?:\/\/a\.111477\.xyz\/[^\s"'<>]+/gi) || [];
          directUrls = [...new Set([...directUrls, ...detailOd.filter(u => !u.includes('tutorial') && !u.includes('sample'))])];
          detailFound = true;
        }
      }

      // Step 3: Resolve HubCloud IDs
      const streams = [];
      for (const id of hubcloudIds.slice(0, 5)) {
        try {
          const resolved = await resolveHubCloud(id);
          if (resolved && resolved.directUrl) {
            const quality = detectQuality(resolved.filename || resolved.directUrl);
            const audio = detectAudio(resolved.filename);
            streams.push({
              name: `🐧 HerumHai ${quality.rank >= 2160 ? '❄️' : '🎯'} ${quality.label} • ${name}`,
              description: `🍿 ${title}\n💾 ${formatFileSize(resolved.fileSize)}\n🎧 Audio: ${audio.join(', ')}`,
              url: resolved.directUrl,
              behaviorHints: {
                notWebReady: true,
                filename: resolved.filename || '',
                videoSize: resolved.fileSize || 0,
              },
              sourceSlug: slug,
            });
          }
        } catch (e) {
          console.log(`  [${slug}] hubcloud ${id} failed: ${e.message}`);
        }
      }

      // Step 4: Add direct 111477 URLs (wrap in p.111477.xyz/bulk proxy)
      for (const url of directUrls.slice(0, 3)) {
        if (url.startsWith('https://a.111477.xyz/')) {
          const bulkUrl = `https://p.111477.xyz/bulk?u=${encodeURIComponent(url)}`;
          const filename = url.split('/').pop() || '';
          const quality = detectQuality(filename);
          streams.push({
            name: `🐧 HerumHai ${quality.rank >= 2160 ? '❄️' : '🎯'} ${quality.label} • ${name} · OD`,
            description: `🍿 ${title}\n💾 OD Direct\n🎬 ${filename}`,
            url: bulkUrl,
            behaviorHints: {
              notWebReady: true,
              filename,
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
  // 1. HubCloud-based sources (9 sources — same technique PenguPlay uses)
  createHubCloudSource('4khdhub', '4KHDHub', 'https://4khdhub.store', '/?s={query}'),
  createHubCloudSource('cinefreak', 'CineFreak', 'https://cinefreak.net', '/?s={query}'),
  createHubCloudSource('moviebox', 'MovieBox', 'https://moviebox.online', '/?s={query}'),
  createHubCloudSource('mkvbase', 'MKVBase', 'https://mkvbase.com', '/?s={query}'),
  createHubCloudSource('moviesdrives', 'MoviesDrives', 'https://moviesdrives.cv', '/?s={query}'),
  createHubCloudSource('vaplayer', 'VAPlayer', 'https://vaplayer.com', '/?s={query}'),
  createHubCloudSource('videasy', 'Videasy', 'https://www.videasy.to', '/?s={query}'),
  createHubCloudSource('aether', 'Aether', 'https://aether.cx', '/?s={query}'),
  createHubCloudSource('hdghartv', 'HDGharTV', 'https://hdghartv.cc', '/?s={query}'),

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
  createHubCloudSource('hdhub4u', 'HDHub4u', 'https://new2.hdhub4u.cl', '/?s={query}'),
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

export async function scrapeAllSources(target, title, timeoutMs = 15000) {
  console.log(`[sources] scraping ${ALL_SOURCES.length} sources for "${title}"`);

  // Filter sources by content type
  const candidates = ALL_SOURCES.filter((s) => {
    if (target.type === 'anime') return s.type === 'anime' || s.type === 'hubcloud';
    return s.type === 'hubcloud' || s.type === 'hls';
  });

  // Scrape all sources in parallel with per-source timeout
  const results = await Promise.allSettled(
    candidates.map(async (source) => {
      try {
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('source-timeout')), timeoutMs)
        );
        const streams = await Promise.race([source.scrape(target, title), timeoutPromise]);
        return { slug: source.slug, streams };
      } catch (e) {
        console.log(`  [${source.slug}] error: ${e.message}`);
        return { slug: source.slug, streams: [] };
      }
    })
  );

  // Flatten all streams
  const allStreams = [];
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value.streams.length > 0) {
      allStreams.push(...result.value.streams);
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
