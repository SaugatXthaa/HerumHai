// ============================================================================
// sources/animesky.js — AnimeSky.top Dedicated Scraper (FIXED)
// ----------------------------------------------------------------------------
// AnimeSky is a WordPress site that hosts anime with multi-language audio.
// Stream URLs are NOT in the HTML — they're fetched at runtime by FirePlayer
// from as-cdn21.top via a POST API.
//
// Flow (NO BROWSER NEEDED — pure axios):
//   1. Search https://animesky.top/?s={title} → find /series/{slug}/ link
//   2. Visit series page → extract /episode/{slug-SxEx}/ links
//   3. Match requested season/episode (or default to 1x1 for movies)
//   4. Visit episode page → extract as-cdn21.top/video/{id} from iframe data-src
//   5. POST to https://as-cdn21.top/player/index.php?data={id}&do=getVideo
//      with Referer + X-Requested-With headers
//   6. Parse JSON response → extract videoSource (.m3u8 URL)
//   7. Return as HLS stream
//
// Verified working: returns signed HLS .m3u8 URL with md5+expires token.
// Stream is multi-audio (Hindi/Tamil/Telugu/English/Japanese) — Stremio's
// player will let user switch audio tracks.
// ============================================================================

import axios from 'axios';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const ANIMESKY_BASE = 'https://animesky.top';
const FIREPLAYER_BASE = 'https://as-cdn21.top';

const http = axios.create({
  timeout: 15000,
  maxRedirects: 5,
  validateStatus: () => true,
  headers: {
    'User-Agent': USER_AGENT,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  },
});

/**
 * Scrape AnimeSky.top for an anime title.
 * @param {string} title     - Anime title (resolved from kitsu ID upstream)
 * @param {string} kitsuId   - Original kitsu ID (for logging only)
 * @param {string} type      - 'anime' (always)
 * @param {number|null} season
 * @param {number|null} episode
 * @returns {Promise<Array>} Array of stream objects
 */
export async function scrapeAnimeSky(title, kitsuId, type = 'anime', season = null, episode = null) {
  if (!title) {
    console.log(`  [animesky] no title provided (kitsu=${kitsuId}) — cannot search`);
    return [];
  }

  const targetSeason = season || 1;
  const targetEpisode = episode || 1;
  console.log(`  [animesky] searching for "${title}" (S${targetSeason}E${targetEpisode})`);

  // ---------- Step 1: Search ----------
  const searchUrl = `${ANIMESKY_BASE}/?s=${encodeURIComponent(title)}`;
  let searchHtml;
  try {
    const res = await http.get(searchUrl);
    if (res.status !== 200) {
      console.log(`  [animesky] search returned ${res.status}`);
      return [];
    }
    searchHtml = res.data;
  } catch (e) {
    console.log(`  [animesky] search error: ${e.message}`);
    return [];
  }

  // Find ALL /series/{slug}/ links — there might be multiple seasons
  // (e.g., "naruto" and "naruto-shippuden" both appear for "Naruto" search)
  const seriesLinkRegex = /href="(https?:\/\/animesky\.top\/series\/[^"]+|\/series\/[^"]+)"/gi;
  const allSeries = [];
  let m;
  while ((m = seriesLinkRegex.exec(searchHtml)) !== null) {
    const href = m[1].startsWith('http') ? m[1] : ANIMESKY_BASE + m[1];
    if (!allSeries.includes(href)) allSeries.push(href);
  }

  if (allSeries.length === 0) {
    console.log(`  [animesky] no series link found in search results`);
    return [];
  }
  console.log(`  [animesky] found ${allSeries.length} series — checking each for S${targetSeason}E${targetEpisode}`);

  // Try each series until we find the requested episode
  for (const seriesUrl of allSeries.slice(0, 3)) {
    console.log(`  [animesky] → series: ${seriesUrl.slice(0, 80)}`);

    // ---------- Step 2: Visit series page, find episode links ----------
    let seriesHtml;
    try {
      const res = await http.get(seriesUrl, { headers: { Referer: searchUrl } });
      if (res.status !== 200) {
        console.log(`  [animesky] series page returned ${res.status}`);
        continue;
      }
      seriesHtml = res.data;
    } catch (e) {
      console.log(`  [animesky] series page error: ${e.message}`);
      continue;
    }

    // Episode URL pattern: /episode/{slug}-{season}x{episode}/
    const episodeLinkRegex = /href="(https?:\/\/animesky\.top\/episode\/[^"]+|\/episode\/[^"]+)"/gi;
    const allEpisodes = [];
    while ((m = episodeLinkRegex.exec(seriesHtml)) !== null) {
      const href = m[1].startsWith('http') ? m[1] : ANIMESKY_BASE + m[1];
      if (!allEpisodes.includes(href)) allEpisodes.push(href);
    }

    if (allEpisodes.length === 0) {
      console.log(`  [animesky] no episode links found on series page`);
      continue;
    }
    console.log(`  [animesky] found ${allEpisodes.length} episodes`);

    // Match the requested SxxExx pattern
    // CRITICAL: use word boundary to avoid matching 1x1 when looking for 1x10
    // Pattern: -{season}x{episode}/  (must end with / to avoid partial matches)
    const targetPattern = new RegExp(`-${targetSeason}x${targetEpisode}/`, 'i');
    const altPattern = new RegExp(`-s${targetSeason}e${targetEpisode}/`, 'i');

    let episodeUrl = allEpisodes.find((u) => targetPattern.test(u) || altPattern.test(u));

    // Fallback: if no exact match, try first episode (useful for movies/OVAs)
    if (!episodeUrl) {
      console.log(`  [animesky] no exact match for S${targetSeason}E${targetEpisode} in this series — trying next series`);
      continue;
    }
    console.log(`  [animesky] → episode: ${episodeUrl.slice(0, 80)}`);

    // ---------- Step 3: Visit episode page, extract FirePlayer video ID ----------
    let episodeHtml;
    try {
      const res = await http.get(episodeUrl, { headers: { Referer: seriesUrl } });
      if (res.status !== 200) {
        console.log(`  [animesky] episode page returned ${res.status}`);
        continue;
      }
      episodeHtml = res.data;
    } catch (e) {
      console.log(`  [animesky] episode page error: ${e.message}`);
      continue;
    }

    // Extract as-cdn21.top/video/{id} from iframe data-src or src
    // Pattern: src="https://as-cdn21.top/video/{32-char-hex}" or data-src="..."
    // Also match as-cdn22.top, as-cdn23.top etc (they use multiple CDNs)
    const videoIdMatch = episodeHtml.match(
      /(?:src|data-src)="https?:\/\/as-cdn\d+\.top\/video\/([a-f0-9]{16,64})"/i
    );
    if (!videoIdMatch) {
      console.log(`  [animesky] no as-cdn video ID found in episode page`);
      continue;
    }
    const videoId = videoIdMatch[1];
    const videoPageUrl = `${FIREPLAYER_BASE}/video/${videoId}`;
    console.log(`  [animesky] → FirePlayer video ID: ${videoId}`);

    // ---------- Step 4: POST to FirePlayer getVideo API ----------
    // Returns JSON: { hls: true, videoSource: "https://as-cdn21.top/cdn/hls/{hash}/master.m3u8?md5=...&expires=..." }
    const apiUrl = `${FIREPLAYER_BASE}/player/index.php?data=${videoId}&do=getVideo`;
    let apiResponse;
    try {
      // BUGFIX: must URL-encode the form body — episodeUrl contains :// and / chars
      // that break form-urlencoded parsing if passed raw. Use URLSearchParams.
      const formData = new URLSearchParams();
      formData.append('hash', videoId);
      formData.append('r', episodeUrl);
      const res = await http.post(apiUrl, formData.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': videoPageUrl,
          'X-Requested-With': 'XMLHttpRequest',
          'Origin': FIREPLAYER_BASE,
        },
      });
      if (res.status !== 200) {
        console.log(`  [animesky] FirePlayer API returned ${res.status}`);
        continue;
      }
      apiResponse = res.data;
    } catch (e) {
      console.log(`  [animesky] FirePlayer API error: ${e.message}`);
      continue;
    }

    // axios may return parsed JSON (if Content-Type was json) or a string
    const data = typeof apiResponse === 'string' ? safeParseJson(apiResponse) : apiResponse;
    if (!data || !data.videoSource) {
      console.log(`  [animesky] FirePlayer response missing videoSource field`);
      continue;
    }

    const m3u8Url = data.videoSource;
    console.log(`  [animesky] ✓ HLS captured: ${m3u8Url.slice(0, 80)}`);

    // ---------- Step 5: Build stream object ----------
    // Quality detection from the .m3u8 URL is unreliable (URL is a hash, not filename).
    // Use "Auto" — the master.m3u8 contains all quality variants and Stremio's player
    // handles quality selection automatically.
    const streams = [{
      name: `HerumHai 🎬 Auto • AnimeSky · Multi-Audio`,
      description: `🍿 ${title}\n📡 HLS Stream (multi-audio, master playlist)\n🎧 Hindi/Tamil/Telugu/English/Japanese\n🎯 S${targetSeason}E${targetEpisode}`,
      url: m3u8Url,
      behaviorHints: {
        notWebReady: false,
        proxyHeaders: {
          request: {
            'User-Agent': USER_AGENT,
            'Referer': `${FIREPLAYER_BASE}/`,
          },
        },
      },
      sourceSlug: 'animesky',
    }];

    console.log(`  [animesky] ✓ ${streams.length} stream(s)`);
    return streams;
  }

  // If we tried all series and found nothing, return empty
  console.log(`  [animesky] no matching episode found in any series`);
  return [];
}

function safeParseJson(str) {
  try { return JSON.parse(str); } catch { return null; }
}

export async function closeBrowser() {
  // No browser used — pure axios. No-op for API compatibility with registry.js
}
