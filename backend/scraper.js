// ============================================================================
// scraper.js — Background Scraping Engine (Full PenguPlay Clone)
// ----------------------------------------------------------------------------
// FULLY INDEPENDENT — does NOT depend on PenguPlay or HdHub being reachable.
//
// Architecture:
//   1. Cloned sources (28 sources) — bespoke scrapers with HubCloud resolver
//      → Works even if PenguPlay + HdHub both go down forever
//   2. PenguPlay proxy (bonus) — adds more streams when available
//   3. HdHub proxy (bonus) — adds OD direct CDN streams when available
//   4. All results merged + deduped + cached in PostgreSQL (24h TTL)
//   5. Background cron scrapes popular titles every 6 hours
// ============================================================================

import 'dotenv/config';
import { fetchHtml, extractHubCloudIds, resolveHubCloud, detectQuality, detectAudio, formatFileSize } from './sources/hubcloud.js';
import { scrapeAllSources } from './sources/registry.js';
import { setCachedStreams, getTitlesToScrape, markTitleScraped, addPopularTitle, logScraperResult } from './db.js';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const PENGU_UPSTREAM = 'https://pengu.uk';
const HDHUB_UPSTREAM = 'https://hdhub.thevolecitor.qzz.io';

// ---------------------------------------------------------------------------
// Fetch from PenguPlay (proxy)
// ---------------------------------------------------------------------------
async function fetchFromPenguPlay(type, id) {
  const start = Date.now();
  try {
    // Default config (all sources enabled)
    const config = {
      torbox: 'unset',
      qualities: '2160p,1080p,720p,480p,360p',
      sort: 'desc',
      source_4khdhub: 'checked', source_moviebox: 'checked', source_moviesdrives: 'checked',
      source_vaplayer: 'checked', source_hdghartv: 'checked',
      res_2160: 'checked', res_1080: 'checked', res_720: 'checked', res_480: 'checked', res_360: 'checked',
      audio_english: 'checked', audio_hindi: 'checked', audio_tamil: 'checked', audio_telugu: 'checked',
      subtitles_disabled: 'unchecked', emulate_vpn: 'unchecked', disable_direct: 'unchecked',
    };
    // Auto-discover new sources
    try {
      const manifestRes = await fetch(`${PENGU_UPSTREAM}/manifest.json`, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(5000),
      });
      if (manifestRes.ok) {
        const manifest = await manifestRes.json();
        for (const c of manifest.config || []) {
          if (c.key && c.key.startsWith('source_') && !(c.key in config)) {
            config[c.key] = c.default || 'unchecked';
          }
        }
      }
    } catch {}

    const configB64 = Buffer.from(JSON.stringify(config)).toString('base64url');
    const url = `${PENGU_UPSTREAM}/${configB64}/stream/${type}/${id}.json`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const streams = (data.streams || []).filter(s => s.url && s.url.includes('/direct/'));
    console.log(`  [pengu] ${streams.length} streams in ${Date.now() - start}ms`);
    return streams;
  } catch (e) {
    console.log(`  [pengu] failed: ${e.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Fetch from HdHub (proxy)
// ---------------------------------------------------------------------------
async function fetchFromHdHub(type, id) {
  const start = Date.now();
  try {
    const config = { torbox: 'unset', qualities: '2160p,1080p,720p', sort: 'desc' };
    const configB64 = Buffer.from(JSON.stringify(config)).toString('base64url');
    const url = `${HDHUB_UPSTREAM}/${configB64}/stream/${type}/${id}.json`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const streams = (data.streams || []).filter(s => s.url && s.url.startsWith('http'));
    console.log(`  [hdhub] ${streams.length} streams in ${Date.now() - start}ms`);
    return streams;
  } catch (e) {
    console.log(`  [hdhub] failed: ${e.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Independent HubCloud scraper (does NOT depend on PenguPlay/HdHub)
// Searches 4KHDHub + HDHub4u directly, extracts HubCloud IDs, resolves them
// ---------------------------------------------------------------------------
async function scrapeIndependent(type, id, title) {
  if (!title) return [];
  const start = Date.now();
  const streams = [];

  // Search 4KHDHub
  const sources = [
    { name: '4KHDHub', url: `https://4khdhub.store/?s=${encodeURIComponent(title)}` },
    { name: 'HDHub4u', url: `https://new2.hdhub4u.cl/?s=${encodeURIComponent(title)}` },
  ];

  for (const source of sources) {
    try {
      const searchRes = await fetchHtml(source.url, { timeout: 10000 });
      if (searchRes.status !== 200) continue;

      // Extract HubCloud IDs from search results
      let hubcloudIds = extractHubCloudIds(searchRes.body);

      // Find detail page
      const detailMatch = searchRes.body.match(/href="(https?:\/\/[^"]*(?:\/\d{4}\/|\/movie\/|\/film\/|\/series\/)[^"]+)"/i);
      if (detailMatch) {
        const detailRes = await fetchHtml(detailMatch[1], { headers: { Referer: source.url }, timeout: 10000 });
        if (detailRes.body) {
          hubcloudIds = [...new Set([...hubcloudIds, ...extractHubCloudIds(detailRes.body)])];
        }
      }

      // Resolve each HubCloud ID
      for (const hcId of hubcloudIds.slice(0, 3)) {
        const resolved = await resolveHubCloud(hcId);
        if (resolved && resolved.directUrl) {
          const quality = detectQuality(resolved.filename || resolved.directUrl);
          const audio = detectAudio(resolved.filename);
          streams.push({
            name: `🐧 HerumHai ${quality.rank >= 2160 ? '❄️' : '🎯'} ${quality.label} • ${source.name}`,
            description: `🍿 ${title}\n💾 ${formatFileSize(resolved.fileSize)}\n🎧 Audio: ${audio.join(', ')}`,
            url: resolved.directUrl,
            behaviorHints: {
              notWebReady: true,
              filename: resolved.filename || '',
              videoSize: resolved.fileSize || 0,
            },
          });
        }
      }
    } catch (e) {
      console.log(`  [independent:${source.name}] failed: ${e.message}`);
    }
  }

  console.log(`  [independent] ${streams.length} streams in ${Date.now() - start}ms`);
  return streams;
}

// ---------------------------------------------------------------------------
// Main scrape function — fetches from ALL sources, merges, caches
// ---------------------------------------------------------------------------
export async function scrapeTitle(type, ids, season, episode, title) {
  const start = Date.now();
  console.log(`\n[scraper] scraping ${type} ${ids.imdbId || ids.tmdbId || ids.kitsuId} (${title || 'unknown'})`);

  // Build the ID string for PenguPlay/HdHub (bonus sources)
  let idStr;
  if (type === 'series') {
    idStr = `${ids.imdbId}:${season}:${episode}`;
  } else if (type === 'anime') {
    idStr = ids.kitsuId ? `kitsu:${ids.kitsuId}:${episode || 1}` : null;
  } else {
    idStr = ids.tmdbId || ids.imdbId;
  }

  // Fetch from ALL sources IN PARALLEL:
  // 1. CLONED SOURCES (34 sources — PRIMARY, independent of PenguPlay/HdHub)
  // 2. PenguPlay proxy (BONUS — adds streams when available)
  // 3. HdHub proxy (BONUS — adds OD direct CDN streams)
  // BUGFIX: pass kitsuId in the target so universal/animesky sources can use it
  const [clonedStreams, penguStreams, hdhubStreams] = await Promise.all([
    scrapeAllSources({ type, ...ids, season, episode }, title, 15000).catch((e) => {
      console.log(`[scraper] cloned sources error: ${e.message}`);
      return [];
    }),
    idStr ? fetchFromPenguPlay(type, idStr).catch(() => []) : Promise.resolve([]),
    idStr ? fetchFromHdHub(type, idStr).catch(() => []) : Promise.resolve([]),
  ]);

  // Merge all streams
  const allStreams = [...clonedStreams, ...penguStreams, ...hdhubStreams];

  // Dedupe by URL
  const seen = new Set();
  const unique = [];
  for (const s of allStreams) {
    if (s.url && !seen.has(s.url)) {
      seen.add(s.url);
      unique.push(s);
    }
  }

  const duration = Date.now() - start;
  console.log(`[scraper] done: ${unique.length} streams (${clonedStreams.length} cloned + ${penguStreams.length} pengu + ${hdhubStreams.length} hdhub) in ${duration}ms`);

  // Cache in database
  if (unique.length > 0) {
    await setCachedStreams(type, ids, season, episode, title, unique);
  }

  // Log result
  await logScraperResult('main', ids.imdbId || ids.tmdbId || ids.kitsuId, unique.length > 0 ? 'ok' : 'error', unique.length, duration, null);

  return unique;
}

// ---------------------------------------------------------------------------
// Background cron scraper — scrapes popular titles every 6 hours
// ---------------------------------------------------------------------------
async function runBackgroundScrape() {
  console.log(`\n[cron] starting background scrape at ${new Date().toISOString()}`);
  const titles = await getTitlesToScrape(50);
  console.log(`[cron] found ${titles.length} titles to scrape`);

  for (const title of titles) {
    try {
      const ids = {
        imdbId: title.imdb_id,
        tmdbId: title.tmdb_id,
        kitsuId: null,
      };
      await scrapeTitle(title.type, ids, null, null, title.title);
      await markTitleScraped(title.id);
      // Small delay between titles to avoid rate limiting
      await new Promise(r => setTimeout(r, 2000));
    } catch (e) {
      console.error(`[cron] error scraping ${title.title}: ${e.message}`);
    }
  }

  console.log(`[cron] background scrape complete`);
}

// Seed popular titles from TMDB trending
async function seedPopularTitles() {
  console.log('[seed] fetching trending titles from TMDB...');
  const TMDB_KEY = process.env.TMDB_API_KEY;
  if (!TMDB_KEY) {
    console.log('[seed] TMDB_API_KEY not set — skipping');
    return;
  }

  try {
    // Fetch trending movies
    const moviesRes = await fetch(`https://api.themoviedb.org/3/trending/movie/week?api_key=${TMDB_KEY}`);
    if (moviesRes.ok) {
      const movies = await moviesRes.json();
      for (const m of (movies.results || []).slice(0, 50)) {
        await addPopularTitle('movie', m.imdb_id || null, `tmdb:${m.id}`, m.title, m.popularity || 0);
      }
      console.log(`[seed] added ${Math.min(50, (movies.results || []).length)} trending movies`);
    }

    // Fetch trending TV
    const tvRes = await fetch(`https://api.themoviedb.org/3/trending/tv/week?api_key=${TMDB_KEY}`);
    if (tvRes.ok) {
      const tv = await tvRes.json();
      for (const t of (tv.results || []).slice(0, 30)) {
        await addPopularTitle('series', null, `tmdb:${t.id}`, t.name, t.popularity || 0);
      }
      console.log(`[seed] added ${Math.min(30, (tv.results || []).length)} trending TV shows`);
    }
  } catch (e) {
    console.error('[seed] error:', e.message);
  }
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------
const mode = process.argv[2];

if (mode === '--cron') {
  // Run background scrape + seed, then exit (for Render Cron Job)
  await seedPopularTitles();
  await runBackgroundScrape();
  process.exit(0);
} else if (mode === '--seed') {
  await seedPopularTitles();
  process.exit(0);
} else if (mode === '--test') {
  // Test scrape a single title
  const title = process.argv[3] || 'Inception';
  const imdbId = process.argv[4] || 'tt1375666';
  const streams = await scrapeTitle('movie', { imdbId, tmdbId: null, kitsuId: null }, null, null, title);
  console.log(`\nResult: ${streams.length} streams`);
  process.exit(0);
}

export { runBackgroundScrape, seedPopularTitles };
