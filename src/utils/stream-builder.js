// =============================================================================
// src/utils/stream-builder.js — Build Stremio Stream Objects
// -----------------------------------------------------------------------------
// Creates properly-formatted stream objects with:
//   - Source name (4KHDHub, xpass, VidSrc, etc.) instead of "HerumHai"
//   - proxyHeaders for browser-like requests
//   - Metadata (resolution, quality, codec, audio, language, size)
// =============================================================================

import { validateUrl } from './http.js';
import { getRandomUserAgent } from './headers.js';

// ---------------------------------------------------------------------------
// Extract metadata from filename/text
// ---------------------------------------------------------------------------
export function extractMetadata(text) {
  if (!text) return {};
  const t = String(text);
  const meta = {};

  if (/\b(?:2160p|4k|uhd)\b/i.test(t)) meta.resolution = '4K';
  else if (/\b(?:1440p|2k)\b/i.test(t)) meta.resolution = '1440p';
  else if (/\b1080p\b/i.test(t)) meta.resolution = '1080p';
  else if (/\b720p\b/i.test(t)) meta.resolution = '720p';
  else if (/\b480p\b/i.test(t)) meta.resolution = '480p';
  else if (/\b360p\b/i.test(t)) meta.resolution = '360p';

  if (/remux/i.test(t)) meta.quality = 'BluRay REMUX';
  else if (/bluray|blu-ray|bdrip/i.test(t)) meta.quality = 'BluRay';
  else if (/web-?dl/i.test(t)) meta.quality = 'WEB-DL';
  else if (/webrip/i.test(t)) meta.quality = 'WEBRip';
  else if (/hdrip/i.test(t)) meta.quality = 'HDRip';
  else if (/hdtv/i.test(t)) meta.quality = 'HDTV';

  if (/x265|hevc/i.test(t)) meta.codec = 'HEVC';
  else if (/x264|h\.?264/i.test(t)) meta.codec = 'AVC';

  if (/10bit|10-bit/i.test(t)) meta.bitDepth = '10bit';

  if (/dolby.?vision|\bdv\b/i.test(t)) meta.hdr = 'DV';
  else if (/hdr10\+/i.test(t)) meta.hdr = 'HDR10+';
  else if (/hdr/i.test(t)) meta.hdr = 'HDR';

  const audio = [];
  if (/ddp?5\.?1|ddp\s*5\.1|dd\+?\s*5\.1/i.test(t)) audio.push('DD+ 5.1');
  else if (/dd\s*5\.1/i.test(t)) audio.push('DD 5.1');
  else if (/dts-?hd/i.test(t)) audio.push('DTS-HD');
  else if (/dts/i.test(t)) audio.push('DTS');
  else if (/5\.1/i.test(t)) audio.push('5.1');
  if (audio.length) meta.audio = audio.join(' · ');

  const langs = [];
  if (/hindi/i.test(t)) langs.push('Hindi');
  if (/english|eng/i.test(t)) langs.push('English');
  if (/tamil/i.test(t)) langs.push('Tamil');
  if (/telugu/i.test(t)) langs.push('Telugu');
  if (langs.length) meta.language = langs.join(' · ');

  const sizeMatch = t.match(/(\d+(?:\.\d+)?)\s*(GB|MB)/i);
  if (sizeMatch) {
    const val = parseFloat(sizeMatch[1]);
    const unit = sizeMatch[2].toUpperCase();
    meta.size = `${val} ${unit}`;
    meta.sizeBytes = unit === 'GB'
      ? Math.round(val * 1024 * 1024 * 1024)
      : Math.round(val * 1024 * 1024);
  }

  return meta;
}

// ---------------------------------------------------------------------------
// Build stream object (no validation)
// ---------------------------------------------------------------------------
export function buildStream({ name, description, url, filename, sizeBytes, referer, bingeGroup, source }) {
  const ua = getRandomUserAgent();
  const behaviorHints = {
    notWebReady: true,
    proxyHeaders: {
      request: {
        'User-Agent': ua,
        ...(referer && { Referer: referer }),
      },
    },
  };
  if (filename) behaviorHints.filename = filename;
  if (sizeBytes) behaviorHints.videoSize = sizeBytes;
  if (bingeGroup) behaviorHints.bingeGroup = bingeGroup;

  const stream = { name, description, url, behaviorHints };
  if (source) stream.source = source;
  return stream;
}

// ---------------------------------------------------------------------------
// Build validated stream — only returns streams with working URLs
// ---------------------------------------------------------------------------
export async function buildValidatedStream({ name, description, url, filename, sizeBytes, referer, bingeGroup, source, skipValidation = false }) {
  if (!skipValidation) {
    const isValid = await validateUrl(url, { timeout: 5000, referer });
    if (!isValid) {
      console.log(`[validate] REJECTED: ${url.slice(0, 80)}`);
      return null;
    }
  }
  return buildStream({ name, description, url, filename, sizeBytes, referer, bingeGroup, source });
}
