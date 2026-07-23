// =============================================================================
// src/sources/direct-apis.js — Direct JSON API Sources (Pure HTTP)
// -----------------------------------------------------------------------------
// Sources that return JSON directly via API endpoints.
// These are the fastest sources — typically resolve in <500ms.
//
// Sources (8):
//   1. xpass.top (HLS playlists)
//   2. TMDB-based embed APIs
//   3. databasegda.com
//   4. mflix.com.de
//   5. gomo.to
//   6. vidsrc.win
//   7. smashystream (TMDB-based)
//   8. embed.smashystream (alternative)
// =============================================================================

import { fetchHtml, fetchJson, validateUrl } from '../utils/http.js';
import { buildStream, buildValidatedStream, extractMetadata } from '../utils/stream-builder.js';
import { getRandomUserAgent } from '../utils/headers.js';
import axios from 'axios';

// ---------------------------------------------------------------------------
// xpass.top — HLS playlist scraper
// ---------------------------------------------------------------------------
async function scrapeXpass(target, title) {
  const { type, imdbId, tmdbId, season, episode } = target;

  let embedUrl;
  if (type === 'movie' && imdbId) {
    embedUrl = `https://play.xpass.top/e/movie/${imdbId}`;
  } else if ((type === 'series' || type === 'anime') && tmdbId) {
    embedUrl = `https://play.xpass.top/e/tv/${tmdbId}/${season || 1}/${episode || 1}`;
  } else {
    return [];
  }

  const html = await fetchHtml(embedUrl, { timeout: 8000, referer: 'https://www.2embed.cc/' });
  if (!html) return [];

  if (html.includes('"playlist":"/vxr/tv/0/') || html.includes('"playlist":"/vrk/tv/0/')) return [];

  // Extract playlist URLs
  const playlistPaths = new Set();
  for (const m of html.matchAll(/"url":"([^"]*playlist\.json)"/g)) {
    if (m[1] && !m[1].includes('/video/error')) playlistPaths.add(m[1]);
  }
  if (playlistPaths.size === 0) return [];

  // Fetch playlists in parallel
  const playlistUrls = Array.from(playlistPaths).slice(0, 8).map((p) =>
    p.startsWith('http') ? p : `https://play.xpass.top${p}`
  );
  const playlistResults = await Promise.all(
    playlistUrls.map((url) => fetchJson(url, { timeout: 5000, referer: embedUrl }))
  );

  const allSources = [];
  for (const data of playlistResults) {
    if (!data?.playlist?.[0]?.sources) continue;
    for (const s of data.playlist[0].sources) {
      if (s.file && !s.file.includes('/video/error')) {
        allSources.push({ label: s.label || 'Unknown', file: s.file, id: s.id || '' });
      }
    }
  }

  // Validate each URL
  const streams = [];
  const seen = new Set();
  for (const src of allSources.slice(0, 6)) {
    if (seen.has(src.file)) continue;
    seen.add(src.file);

    const isValid = await validateUrl(src.file, { timeout: 4000, referer: 'https://play.xpass.top/' });
    if (!isValid) continue;

    let resolution = null;
    if (src.file.includes('.m3u8')) {
      try {
        const m3u8Body = await fetchHtml(src.file, { timeout: 4000, referer: 'https://play.xpass.top/' });
        if (m3u8Body && !m3u8Body.includes('404')) {
          const resMatch = m3u8Body.match(/RESOLUTION=(\d+)x(\d+)/);
          if (resMatch) {
            const height = parseInt(resMatch[2]);
            if (height >= 2000) resolution = '4K';
            else if (height >= 1000) resolution = '1080p';
            else if (height >= 700) resolution = '720p';
            else if (height >= 400) resolution = '480p';
            else resolution = height + 'p';
          }
        }
      } catch {}
    }

    const meta = extractMetadata(`${src.label} ${title}`);
    streams.push(buildStream({
      name: `HerumHai · xpass${resolution ? ` · ${resolution}` : ''}${meta.quality ? ` · ${meta.quality}` : ''}`,
      description: `Source: xpass.top\nTitle: ${title}\nResolution: ${resolution || 'auto'}`,
      url: src.file,
      filename: `${title}_${resolution || 'auto'}.m3u8`,
      referer: 'https://play.xpass.top/',
      bingeGroup: `herumhai-xpass-${src.id || src.label}`,
      source: 'xpass',
    }));
  }

  return streams;
}

// ---------------------------------------------------------------------------
// databasegda.com — direct API
// ---------------------------------------------------------------------------
async function scrapeDatabaseGDA(target, title) {
  const { type, imdbId, season, episode } = target;
  if (!imdbId) return [];

  const url = type === 'series'
    ? `https://databasegda.com/api/${imdbId}/${season || 1}/${episode || 1}`
    : `https://databasegda.com/api/${imdbId}`;

  const data = await fetchJson(url, { timeout: 6000 });
  if (!data) return [];

  const streams = [];
  const sources = data.sources || data.streams || data.playlist?.[0]?.sources || [];
  for (const src of sources.slice(0, 3)) {
    const streamUrl = src.file || src.url || src.src;
    if (!streamUrl) continue;
    const isValid = await validateUrl(streamUrl, { timeout: 4000 });
    if (isValid) {
      streams.push(buildStream({
        name: `HerumHai · DatabaseGDA`,
        description: `Source: databasegda.com\nTitle: ${title}`,
        url: streamUrl,
        filename: `${title}.m3u8`,
        referer: 'https://databasegda.com/',
        bingeGroup: `herumhai-databasegda-${Date.now().toString(36)}`,
        source: 'databasegda',
      }));
    }
  }

  return streams;
}

// ---------------------------------------------------------------------------
// mflix.com.de — direct API
// ---------------------------------------------------------------------------
async function scrapeMflix(target, title) {
  const { type, imdbId, season, episode } = target;
  if (!imdbId) return [];

  const url = type === 'series'
    ? `https://mflix.com.de/api/tv/${imdbId}/${season || 1}/${episode || 1}`
    : `https://mflix.com.de/api/movie/${imdbId}`;

  const data = await fetchJson(url, { timeout: 6000 });
  if (!data) return [];

  const streams = [];
  const sources = data.sources || data.streams || [];
  for (const src of sources.slice(0, 3)) {
    const streamUrl = src.file || src.url;
    if (!streamUrl) continue;
    const isValid = await validateUrl(streamUrl, { timeout: 4000 });
    if (isValid) {
      streams.push(buildStream({
        name: `HerumHai · MFlix`,
        description: `Source: mflix.com.de\nTitle: ${title}`,
        url: streamUrl,
        filename: `${title}.m3u8`,
        referer: 'https://mflix.com.de/',
        bingeGroup: `herumhai-mflix-${Date.now().toString(36)}`,
        source: 'mflix',
      }));
    }
  }

  return streams;
}

// ---------------------------------------------------------------------------
// gomo.to — embed provider
// ---------------------------------------------------------------------------
async function scrapeGomo(target, title) {
  const { type, imdbId, season, episode } = target;
  if (!imdbId) return [];

  const url = type === 'series'
    ? `https://gomo.to/embed/tv/${imdbId}/${season || 1}/${episode || 1}`
    : `https://gomo.to/embed/movie/${imdbId}`;

  const html = await fetchHtml(url, { timeout: 8000 });
  if (!html) return [];

  const streamUrls = new Set();
  for (const m of html.matchAll(/(https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*)/gi)) {
    streamUrls.add(m[1]);
  }

  const streams = [];
  for (const streamUrl of Array.from(streamUrls).slice(0, 2)) {
    const isValid = await validateUrl(streamUrl, { timeout: 4000 });
    if (isValid) {
      streams.push(buildStream({
        name: `HerumHai · Gomo`,
        description: `Source: gomo.to\nTitle: ${title}`,
        url: streamUrl,
        filename: `${title}.m3u8`,
        referer: url,
        bingeGroup: `herumhai-gomo-${Date.now().toString(36)}`,
        source: 'gomo',
      }));
    }
  }

  return streams;
}

// ---------------------------------------------------------------------------
// vidsrc.win — embed provider
// ---------------------------------------------------------------------------
async function scrapeVidSrcWin(target, title) {
  const { type, imdbId, season, episode } = target;
  if (!imdbId) return [];

  const url = type === 'series'
    ? `https://vidsrc.win/embed/tv/${imdbId}/${season || 1}/${episode || 1}`
    : `https://vidsrc.win/embed/movie/${imdbId}`;

  const html = await fetchHtml(url, { timeout: 8000 });
  if (!html) return [];

  const streamUrls = new Set();
  for (const m of html.matchAll(/(https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*)/gi)) {
    streamUrls.add(m[1]);
  }
  for (const m of html.matchAll(/"file"\s*:\s*"(https?:\/\/[^"]+)"/gi)) {
    if (m[1].includes('.m3u8') || m[1].includes('.mp4')) streamUrls.add(m[1]);
  }

  const streams = [];
  for (const streamUrl of Array.from(streamUrls).slice(0, 2)) {
    const isValid = await validateUrl(streamUrl, { timeout: 4000 });
    if (isValid) {
      streams.push(buildStream({
        name: `HerumHai · VidSrc.win`,
        description: `Source: vidsrc.win\nTitle: ${title}`,
        url: streamUrl,
        filename: `${title}.m3u8`,
        referer: url,
        bingeGroup: `herumhai-vidsrcwin-${Date.now().toString(36)}`,
        source: 'vidsrcwin',
      }));
    }
  }

  return streams;
}

// ---------------------------------------------------------------------------
// Export all direct API sources
// ---------------------------------------------------------------------------
export const xpass = { id: 'xpass', name: 'xpass', types: 'all', scrape: scrapeXpass };
export const databasegda = { id: 'databasegda', name: 'DatabaseGDA', types: 'all', scrape: scrapeDatabaseGDA };
export const mflix = { id: 'mflix', name: 'MFlix', types: 'all', scrape: scrapeMflix };
export const gomo = { id: 'gomo', name: 'Gomo', types: 'all', scrape: scrapeGomo };
export const vidsrcwin = { id: 'vidsrcwin', name: 'VidSrc.win', types: 'all', scrape: scrapeVidSrcWin };

export default { xpass, databasegda, mflix, gomo, vidsrcwin };
