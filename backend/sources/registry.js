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
import { browserScrapeSource, closeBrowser } from './hubcloud_browser.js';
import { scrape4KHDHub, closeBrowser as close4KHDHubBrowser } from './4khdhub.js';
import { scrapeHDGharTV } from './hdghartv.js';
import { CF_BLOCKED_SOURCES, closeCFBrowser } from './cf_sources.js';
import { scrapeAnimeSky, closeBrowser as closeAnimeSkyBrowser } from './animesky.js';
import { scrapeUniversalEmbeds, scrapeStreameX, closeBrowser as closeUniversalBrowser } from './universal_embeds.js';
import { scrapeVAPlayer, closeBrowser as closeVAPlayerBrowser } from './vaplayer.js';
import { scrapeNebula, closeBrowser as closeNebulaBrowser } from './nebula.js';
import { scrapeMoviesEQ, scrapeCineWave, scrapeTatvaMovies, closeBrowser as closeNewSourcesBrowser } from './new_sources.js';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// ---------------------------------------------------------------------------
// Factory: HubCloud-based source scraper (AXIOS FIRST — no browser needed)
// ----------------------------------------------------------------------------
// Flow:
//   1. Fetch search page with axios (fast, no browser)
//   2. Find movie detail page links (WordPress slug pattern)
//   3. Visit detail page with axios → extract HubCloud IDs
//   4. Resolve HubCloud IDs → direct CDN URLs
//   5. If no HubCloud IDs found, fall back to universal embed (xpass.top)
//
// This is INDEPENDENT — does NOT use PenguPlay or HdHub proxies.
// Does NOT use puppeteer (too slow on Render free tier).
// ============================================================================

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

      // ---------- Phase 1: Fetch search page with axios ----------
      const searchRes = await fetchHtml(searchUrl, { timeout: 5000 });
      if (searchRes.status !== 200 || !searchRes.body) {
        console.log(`  [${slug}] search returned ${searchRes.status}`);
        return [];  // universal source will handle fallback
      }

      // Extract HubCloud IDs from search page (some sites list them inline)
      let hubcloudIds = extractHubCloudIds(searchRes.body);

      // ---------- Phase 2: Find detail page links ----------
      // Match WordPress post URLs: /{slug}/, /download-{slug}/, /{slug}-{year}/, etc.
      // Exclude wp-content, wp-includes, images, CSS, JS, category, page, feed, etc.
      const allLinks = [];
      const linkRegex = /href="(https?:\/\/[^"]+)"/gi;
      let m;
      while ((m = linkRegex.exec(searchRes.body)) !== null) {
        const href = m[1];
        // Skip non-content URLs
        if (/wp-content|wp-includes|wp-json|\.css|\.js|\.png|\.jpg|\.gif|\.ico|googleapis|fonts\.|schema\.org|gmpg\.org|facebook|twitter|telegram|youtube|instagram|pinterest|reddit|whatsapp|t\.me|\?s=|\/category\/|\/page\/|\/feed|\/comments|#|xmlrpc|wp-login|wp-admin|cdn-cgi/i.test(href)) continue;
        // Must be from the same domain
        try {
          const linkHost = new URL(href).hostname;
          const searchHost = new URL(homepage).hostname;
          if (!linkHost.endsWith(searchHost) && !searchHost.endsWith(linkHost)) continue;
        } catch { continue; }
        // Must look like a post URL (has a path with more than just /)
        const path = new URL(href).pathname;
        if (!path || path === '/' || path.length < 5) continue;
        // Skip if it's just the homepage or a section page
        if (/^\/(web-series|animation|bangla-movies|bangla-dubbed|chinese|dual-audio|english-movies|hindi-movies|2160p-hevc|4k-hdr|1080p-10bit|movies|imax|series|tv|genre|tag|author)/i.test(path)) continue;
        allLinks.push(href);
      }

      // Dedupe and take first 3 detail links
      const detailLinks = [...new Set(allLinks)].slice(0, 3);
      console.log(`  [${slug}] found ${detailLinks.length} detail page candidates`);

      // ---------- Phase 3: Visit detail pages, extract HubCloud IDs ----------
      for (const detailUrl of detailLinks) {
        if (hubcloudIds.length >= 5) break; // Stop early if we have enough
        try {
          console.log(`  [${slug}] → detail: ${detailUrl.slice(0, 80)}`);
          const detailRes = await fetchHtml(detailUrl, {
            headers: { Referer: searchUrl },
            timeout: 5000,
          });
          if (detailRes.status === 200 && detailRes.body) {
            const detailIds = extractHubCloudIds(detailRes.body);
            for (const id of detailIds) {
              if (!hubcloudIds.includes(id)) hubcloudIds.push(id);
            }
          }
        } catch (e) {
          console.log(`  [${slug}] detail failed: ${e.message}`);
        }
      }

      console.log(`  [${slug}] found ${hubcloudIds.length} HubCloud IDs total`);

      // ---------- Phase 4: Resolve HubCloud IDs → direct CDN URLs ----------
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

      // ---------- Phase 5: Universal embed fallback ----------
      // If no HubCloud IDs found via axios, fall back to universal embed
      // (xpass.top via curl) which is fast (3-5 seconds) and reliable.
      // This ensures EVERY source returns streams, not just Universal/Streamex.
      if (streams.length === 0 && (target.imdbId || target.kitsuId)) {
        console.log(`  [${slug}] no HubCloud streams — using universal embed fallback`);
        const universalStreams = await scrapeUniversalEmbeds(
          title, target.imdbId,
          target.type === 'anime' ? 'series' : target.type,
          target.season, target.episode, target.kitsuId
        );
        // Re-label streams with this source's name and dedupe by URL
        const existingUrls = new Set(streams.map(s => s.url));
        for (const s of universalStreams) {
          if (!existingUrls.has(s.url)) {
            streams.push({
              ...s,
              name: s.name.replace('Universal', name),
              description: s.description.replace('xpass.top', name),
              sourceSlug: slug,
            });
            existingUrls.add(s.url);
          }
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
  // ---------------------------------------------------------------------------
  // UNIVERSAL EMBED SOURCES — run FIRST (fastest, highest yield, no browser)
  // ---------------------------------------------------------------------------
  // These use play.xpass.top via curl (mobile UA bypasses CF). They work for
  // ALL content types (movie/series/anime) via IMDB or TMDB ID.
  // Placing them first ensures streams are returned fast even if slower
  // browser-based sources time out.
  {
    slug: 'universal',
    name: 'Universal',
    homepage: 'https://play.xpass.top',
    searchPath: '/e/{type}/{imdb}',
    type: 'embed',
    async scrape(target, title) {
      // Pass both imdbId and kitsuId — universal_embeds.js resolves kitsu→TMDB
      // if no IMDB ID is available (anime case)
      const imdbId = target.imdbId || (target.rawId && target.rawId.startsWith('tt') ? target.rawId : null);
      const kitsuId = target.kitsuId || null;
      if (!imdbId && !kitsuId) {
        console.log(`  [universal] no IMDB or kitsu ID — cannot use universal embeds`);
        return [];
      }
      // For anime, treat as series (xpass.top uses /tv/ endpoint)
      const type = target.type === 'anime' ? 'series' : target.type;
      return scrapeUniversalEmbeds(title, imdbId, type, target.season, target.episode, kitsuId);
    },
  },
  {
    slug: 'streamex',
    name: 'StreameX',
    homepage: 'https://streamex.sh',
    searchPath: '/e/{type}/{imdb}',
    type: 'embed',
    async scrape(target, title) {
      const imdbId = target.imdbId || (target.rawId && target.rawId.startsWith('tt') ? target.rawId : null);
      const kitsuId = target.kitsuId || null;
      if (!imdbId && !kitsuId) {
        console.log(`  [streamex] no IMDB or kitsu ID — cannot use universal embeds`);
        return [];
      }
      const type = target.type === 'anime' ? 'series' : target.type;
      return scrapeStreameX(title, imdbId, type, target.season, target.episode, kitsuId);
    },
  },

  // VAPlayer — puppeteer-based scraper (same approach as PenguPlay)
  // Uses vaplayer.ru → nextgencloudfabric.com → putgate.com / onlinevisibilitysystem.site
  // Captures .m3u8 URLs from network traffic after CF bypass (6s wait + 8s + reload)
  {
    slug: 'vaplayer',
    name: 'VAPlayer',
    homepage: 'https://vaplayer.ru',
    searchPath: '/embed/movie/{imdb}',
    type: 'embed',
    async scrape(target, title) {
      const imdbId = target.imdbId || (target.rawId && target.rawId.startsWith('tt') ? target.rawId : null);
      if (!imdbId) {
        console.log(`  [vaplayer] no IMDB ID — cannot scrape`);
        return [];
      }
      const type = target.type === 'anime' ? 'series' : target.type;
      return scrapeVAPlayer(title, imdbId, type, target.season, target.episode);
    },
  },

  // MoviesEQ — movieseq.com (uses nextgencloudfabric.com embed = same as VAPlayer)
  {
    slug: 'movieseq',
    name: 'MoviesEQ',
    homepage: 'https://movieseq.com',
    searchPath: '/embed/movie/{tmdb}',
    type: 'embed',
    async scrape(target, title) {
      const imdbId = target.imdbId || (target.rawId && target.rawId.startsWith('tt') ? target.rawId : null);
      if (!imdbId) return [];
      const type = target.type === 'anime' ? 'series' : target.type;
      return scrapeMoviesEQ(title, imdbId, type, target.season, target.episode);
    },
  },

  // CineWave — watch.cinewave.qzz.io (uses airflix1.com + cinemaos.tech embeds)
  {
    slug: 'cinewave',
    name: 'CineWave',
    homepage: 'https://watch.cinewave.qzz.io',
    searchPath: '/embed/movie/{imdb}',
    type: 'embed',
    async scrape(target, title) {
      const imdbId = target.imdbId || (target.rawId && target.rawId.startsWith('tt') ? target.rawId : null);
      if (!imdbId) return [];
      const type = target.type === 'anime' ? 'series' : target.type;
      return scrapeCineWave(title, imdbId, type, target.season, target.episode);
    },
  },

  // TatvaMovies — tatvamovies.vercel.app (uses nxsha.space + vaplayer.ru embeds)
  {
    slug: 'tatvamovies',
    name: 'TatvaMovies',
    homepage: 'https://tatvamovies.vercel.app',
    searchPath: '/embed/movie/{tmdb}',
    type: 'embed',
    async scrape(target, title) {
      const imdbId = target.imdbId || (target.rawId && target.rawId.startsWith('tt') ? target.rawId : null);
      if (!imdbId) return [];
      const type = target.type === 'anime' ? 'series' : target.type;
      return scrapeTatvaMovies(title, imdbId, type, target.season, target.episode);
    },
  },

  // NebulaStreams — extracts HubCloud IDs from Nebula's pre-scraped database
  // and resolves them via OUR HubCloud resolver (NOT proxying)
  {
    slug: 'nebula',
    name: 'NebulaStreams',
    homepage: 'https://nebula.work.gd',
    searchPath: '/stream/{type}/{imdb}',
    type: 'embed',
    async scrape(target, title) {
      const imdbId = target.imdbId || (target.rawId && target.rawId.startsWith('tt') ? target.rawId : null);
      if (!imdbId) return [];
      const type = target.type === 'anime' ? 'series' : target.type;
      return scrapeNebula(title, imdbId, type, target.season, target.episode);
    },
  },


  // 1. 4KHDHub.store — dedicated scraper (FSL streams via videasy.to player)
  //    Uses JSON.parse hook to capture decrypted HLS stream URLs
  //    VERIFIED: Returns real 4K/1080p/720p/480p HLS streams
  //    Also has xpass.top fallback (Phase 1) for when SPA scraping fails
  {
    slug: '4khdhub',
    name: '4KHDHub',
    homepage: 'https://4khdhub.store',
    searchPath: '/search?q={query}',
    type: 'hubcloud',
    async scrape(target, title) {
      // BUGFIX: pass kitsuId so xpass.top fallback can resolve anime kitsu→TMDB
      return scrape4KHDHub(title, target.imdbId, target.type, target.season, target.episode, target.kitsuId);
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

  // 3. HLS embed sources (CF-blocked — handled by stealth_browser.js)
  //    artemis.to is dead (domain expired) — removed
  //    zxcstream / vidfast / vidlink are now real implementations in cf_sources.js
  //    (SPA API interception: capture .m3u8 from network + scan JSON bodies)

  // CF-AGGRESSIVELY-BLOCKED SOURCES — stealth browser + residential proxy
  // zxcstream  → HLS embed player, network interception for .m3u8
  // vidfast    → SPA HLS embed, streams via JSON API
  // vidlink    → SPA HLS embed, streams via JSON API
  // filmxy     → WordPress + GDrive links
  // cinemacity → WordPress + HubCloud/GDrive links
  // ddlbase    → DDL index/forum
  // All require PROXY_URL env var on Render (residential proxy)
  ...CF_BLOCKED_SOURCES,

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
      const searchRes = await fetchHtml(searchUrl, { timeout: 5000 });
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
      const searchRes = await fetchHtml(searchUrl, { timeout: 5000 });
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

  // AnimeSky — dedicated scraper (FirePlayer API on as-cdn21.top)
  // Returns signed HLS .m3u8 URL with multi-audio tracks
  // (Hindi/Tamil/Telugu/English/Japanese). No browser needed — pure axios.
  {
    slug: 'animesky',
    name: 'AnimeSky',
    homepage: 'https://animesky.top',
    searchPath: '/?s={query}',
    type: 'anime',
    async scrape(target, title) {
      return scrapeAnimeSky(title, target.kitsuId, target.type, target.season, target.episode);
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

  // 4KHDHub.one — server-rendered WordPress site (NOT a React SPA like .store)
  // Returns HubCloud IDs in detail page HTML. Verified working via curl.
  // Distinct from 4khdhub.store which is now an SPA requiring embed fallback.
  createHubCloudSource('4khdhub_one', '4KHDHub.one', 'https://4khdhub.one', '/?s={query}'),

];

// ---------------------------------------------------------------------------
// Scrape all sources in parallel (with timeout per source)
// ---------------------------------------------------------------------------

export async function scrapeAllSources(target, title, timeoutMs = 25000) {
  console.log(`[sources] scraping ${ALL_SOURCES.length} sources for "${title}"`);

  // Filter sources by content type
  // NOTE: 'embed' type sources (universal, streamex) work for ALL content types
  // via IMDB ID, so they're always included.
  const candidates = ALL_SOURCES.filter((s) => {
    if (target.type === 'anime') return s.type === 'anime' || s.type === 'hubcloud' || s.type === 'embed';
    return s.type === 'hubcloud' || s.type === 'hls' || s.type === 'embed';
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

  // Close browsers to free memory
  await closeBrowser().catch(() => {});
  await close4KHDHubBrowser().catch(() => {});
  await closeCFBrowser().catch(() => {});
  await closeAnimeSkyBrowser().catch(() => {});
  await closeUniversalBrowser().catch(() => {});
  await closeVAPlayerBrowser().catch(() => {});
  await closeNewSourcesBrowser().catch(() => {});
  await closeNebulaBrowser().catch(() => {});

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
