// =============================================================================
// src/sources/embed-apis.js — Pure HTTP Embed API Sources (Batch)
// -----------------------------------------------------------------------------
// These are the PenguPlay bread-and-butter sources: pure HTTP API endpoints
// that return JSON or HTML with embedded stream URLs. No browser needed.
//
// Sources (18):
//   1. vidsrc.to       2. vidsrc.xyz      3. vidsrc.me        4. vidsrc.cc
//   5. vidsrc.net      6. vidsrc.vip      7. vidsrc.pro       8. vidsrc.stream
//   9. 2embed.cc       10. 2embed.to      11. 2embed.pro      12. 2embed.rs
//   13. vidlink.pro    14. vidfast.pro    15. embed.su        16. multiembed.mov
//   17. autoembed.cc   18. smashystream
// =============================================================================

import { fetchHtml, fetchJson, validateUrl } from '../utils/http.js';
import { buildStream, buildValidatedStream, extractMetadata } from '../utils/stream-builder.js';
import { getRandomUserAgent } from '../utils/headers.js';
import axios from 'axios';

// ---------------------------------------------------------------------------
// Build embed URL based on provider + type
// ---------------------------------------------------------------------------
function buildEmbedUrl(provider, target) {
  const { type, imdbId, season, episode } = target;
  if (!imdbId) return null;

  const isSeries = type === 'series';
  const s = season || 1;
  const e = episode || 1;

  switch (provider) {
    case 'vidsrc.to':
      return isSeries
        ? `https://vidsrc.to/embed/tv/${imdbId}/${s}/${e}`
        : `https://vidsrc.to/embed/movie/${imdbId}`;
    case 'vidsrc.xyz':
      // vidsrc.xyz has a JSON API
      return null; // handled separately
    case 'vidsrc.me':
      return isSeries
        ? `https://vidsrc.me/embed/tv/${imdbId}/${s}/${e}/`
        : `https://vidsrc.me/embed/movie/${imdbId}/`;
    case 'vidsrc.cc':
      return isSeries
        ? `https://vidsrc.cc/v2/embed/tv/${imdbId}/${s}/${e}`
        : `https://vidsrc.cc/v2/embed/movie/${imdbId}`;
    case 'vidsrc.net':
      return `https://vidsrc.net/embed/movie?imdb=${imdbId}`;
    case 'vidsrc.vip':
      return isSeries
        ? `https://vidsrc.vip/embed/tv/${imdbId}/${s}/${e}`
        : `https://vidsrc.vip/embed/movie/${imdbId}`;
    case 'vidsrc.pro':
      return isSeries
        ? `https://vidsrc.pro/embed/tv/${imdbId}/${s}/${e}`
        : `https://vidsrc.pro/embed/movie/${imdbId}`;
    case 'vidsrc.stream':
      return `https://vidsrc.stream/movie?imdb=${imdbId}`;
    case '2embed.cc':
      return isSeries
        ? `https://www.2embed.cc/embed/tv/${imdbId}&s=${s}&e=${e}`
        : `https://www.2embed.cc/embed/${imdbId}`;
    case '2embed.to':
      return `https://www.2embed.to/embed/${imdbId}`;
    case '2embed.pro':
      return isSeries
        ? `https://2embed.pro/tv/${imdbId}&s=${s}&e=${e}`
        : `https://2embed.pro/imdb/${imdbId}`;
    case '2embed.rs':
      return `https://www.2embed.rs/embed/${imdbId}`;
    case 'vidlink.pro':
      return isSeries
        ? `https://vidlink.pro/tv/${imdbId}/${s}/${e}`
        : `https://vidlink.pro/movie/${imdbId}`;
    case 'vidfast.pro':
      return isSeries
        ? `https://vidfast.pro/tv/${imdbId}/${s}/${e}`
        : `https://vidfast.pro/movie/${imdbId}`;
    case 'embed.su':
      return isSeries
        ? `https://embed.su/embed/tv/${imdbId}/${s}/${e}`
        : `https://embed.su/embed/movie/${imdbId}`;
    case 'multiembed':
      return isSeries
        ? `https://multiembed.mov/?video_id=${imdbId}&s=${s}&e=${e}`
        : `https://multiembed.mov/?video_id=${imdbId}`;
    case 'autoembed':
      return isSeries
        ? `https://autoembed.cc/embed/tv/${imdbId}/${s}/${e}`
        : `https://autoembed.cc/embed/movie/${imdbId}`;
    case 'smashystream':
      return `https://embed.smashystream.com/playere.php?tmdb=${target.tmdbId || ''}`;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Scrape an embed provider (fetch HTML → extract m3u8/mp4 URLs)
// ---------------------------------------------------------------------------
async function scrapeEmbedProvider(providerId, providerName, target, title) {
  const embedUrl = buildEmbedUrl(providerId, target);
  if (!embedUrl) return [];

  const html = await fetchHtml(embedUrl, { timeout: 8000, referer: 'https://google.com' });
  if (!html) return [];

  // Extract m3u8/mp4 URLs from HTML
  const streamUrls = new Set();
  for (const m of html.matchAll(/(https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*)/gi)) {
    streamUrls.add(m[1]);
  }
  for (const m of html.matchAll(/(https?:\/\/[^"'\s<>]+\.mp4[^"'\s<>]*)/gi)) {
    streamUrls.add(m[1]);
  }
  // Also check for JSON-encoded stream URLs
  for (const m of html.matchAll(/"file"\s*:\s*"(https?:\/\/[^"]+)"/gi)) {
    streamUrls.add(m[1]);
  }
  for (const m of html.matchAll(/"src"\s*:\s*"(https?:\/\/[^"]+)"/gi)) {
    if (m[1].includes('.m3u8') || m[1].includes('.mp4')) streamUrls.add(m[1]);
  }

  if (streamUrls.size === 0) return [];

  // Validate and build streams (max 3 per provider)
  const streams = [];
  for (const url of Array.from(streamUrls).slice(0, 3)) {
    const isValid = await validateUrl(url, { timeout: 4000, referer: embedUrl });
    if (isValid) {
      const meta = extractMetadata(`${url} ${title}`);
      streams.push(buildStream({
        name: `HerumHai · ${providerName}${meta.resolution ? ` · ${meta.resolution}` : ''}`,
        description: `Source: ${providerName}\nTitle: ${title}`,
        url,
        filename: `${title}.m3u8`,
        referer: embedUrl,
        bingeGroup: `herumhai-${providerId}-${Date.now().toString(36)}`,
        source: providerId,
      }));
    }
  }

  return streams;
}

// ---------------------------------------------------------------------------
// vidsrc.xyz — special case (has JSON API)
// ---------------------------------------------------------------------------
async function scrapeVidSrcXyz(target, title) {
  const { type, imdbId, season, episode } = target;
  if (!imdbId) return [];

  // vidsrc.xyz API endpoints
  const apiUrl = type === 'series'
    ? `https://vidsrc.xyz/api/episode/${imdbId}/${season || 1}/${episode || 1}`
    : `https://vidsrc.xyz/api/movies/${imdbId}`;
  const data = await fetchJson(apiUrl, { timeout: 6000, referer: 'https://vidsrc.xyz/' });
  if (!data) return [];

  const streams = [];
  const sources = data.sources || data.playlist?.[0]?.sources || [];
  for (const src of sources.slice(0, 3)) {
    const url = src.file || src.url;
    if (!url) continue;
    const isValid = await validateUrl(url, { timeout: 4000 });
    if (isValid) {
      streams.push(buildStream({
        name: `HerumHai · VidSrc.xyz`,
        description: `Source: vidsrc.xyz API\nTitle: ${title}`,
        url,
        filename: `${title}.m3u8`,
        referer: 'https://vidsrc.xyz/',
        bingeGroup: `herumhai-vidsrcxyz-${Date.now().toString(36)}`,
        source: 'vidsrcxyz',
      }));
    }
  }

  return streams;
}

// ---------------------------------------------------------------------------
// Export all 18 embed providers
// ---------------------------------------------------------------------------
export const vidsrc_to = { id: 'vidsrc_to', name: 'VidSrc', types: 'all', scrape: (t, title) => scrapeEmbedProvider('vidsrc.to', 'VidSrc', t, title) };
export const vidsrcxyz = { id: 'vidsrcxyz', name: 'VidSrc.xyz', types: 'all', scrape: scrapeVidSrcXyz };
export const vidsrc_me = { id: 'vidsrc_me', name: 'VidSrc.me', types: 'all', scrape: (t, title) => scrapeEmbedProvider('vidsrc.me', 'VidSrc.me', t, title) };
export const vidsrc_cc = { id: 'vidsrc_cc', name: 'VidSrc.cc', types: 'all', scrape: (t, title) => scrapeEmbedProvider('vidsrc.cc', 'VidSrc.cc', t, title) };
export const vidsrc_net = { id: 'vidsrc_net', name: 'VidSrc.net', types: 'all', scrape: (t, title) => scrapeEmbedProvider('vidsrc.net', 'VidSrc.net', t, title) };
export const vidsrc_vip = { id: 'vidsrc_vip', name: 'VidSrc.vip', types: 'all', scrape: (t, title) => scrapeEmbedProvider('vidsrc.vip', 'VidSrc.vip', t, title) };
export const vidsrc_pro = { id: 'vidsrc_pro', name: 'VidSrc.pro', types: 'all', scrape: (t, title) => scrapeEmbedProvider('vidsrc.pro', 'VidSrc.pro', t, title) };
export const vidsrc_stream = { id: 'vidsrc_stream', name: 'VidSrc.stream', types: 'all', scrape: (t, title) => scrapeEmbedProvider('vidsrc.stream', 'VidSrc.stream', t, title) };
export const embed2_cc = { id: 'embed2_cc', name: '2Embed', types: 'all', scrape: (t, title) => scrapeEmbedProvider('2embed.cc', '2Embed', t, title) };
export const embed2_to = { id: 'embed2_to', name: '2Embed.to', types: 'all', scrape: (t, title) => scrapeEmbedProvider('2embed.to', '2Embed.to', t, title) };
export const embed2_pro = { id: 'embed2_pro', name: '2Embed.pro', types: 'all', scrape: (t, title) => scrapeEmbedProvider('2embed.pro', '2Embed.pro', t, title) };
export const embed2_rs = { id: 'embed2_rs', name: '2Embed.rs', types: 'all', scrape: (t, title) => scrapeEmbedProvider('2embed.rs', '2Embed.rs', t, title) };
export const vidlink = { id: 'vidlink', name: 'VidLink', types: 'all', scrape: (t, title) => scrapeEmbedProvider('vidlink.pro', 'VidLink', t, title) };
export const vidfast = { id: 'vidfast', name: 'VidFast', types: 'all', scrape: (t, title) => scrapeEmbedProvider('vidfast.pro', 'VidFast', t, title) };
export const embedsu = { id: 'embedsu', name: 'EmbedSu', types: 'all', scrape: (t, title) => scrapeEmbedProvider('embed.su', 'EmbedSu', t, title) };
export const multiembed = { id: 'multiembed', name: 'MultiEmbed', types: 'all', scrape: (t, title) => scrapeEmbedProvider('multiembed', 'MultiEmbed', t, title) };
export const autoembed = { id: 'autoembed', name: 'AutoEmbed', types: 'all', scrape: (t, title) => scrapeEmbedProvider('autoembed', 'AutoEmbed', t, title) };
export const smashystream = { id: 'smashystream', name: 'SmashyStream', types: 'all', scrape: (t, title) => scrapeEmbedProvider('smashystream', 'SmashyStream', t, title) };

export default {
  vidsrc_to, vidsrcxyz, vidsrc_me, vidsrc_cc, vidsrc_net, vidsrc_vip, vidsrc_pro,
  vidsrc_stream, embed2_cc, embed2_to, embed2_pro, embed2_rs, vidlink, vidfast,
  embedsu, multiembed, autoembed, smashystream
};
