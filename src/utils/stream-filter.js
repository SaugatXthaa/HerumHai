// src/utils/stream-filter.js — Filter ads, tutorials, small files (< 80MB)

const MIN_SIZE = 80 * 1024 * 1024; // 80MB

const REJECT_NAMES = [
  /donation/i, /donate/i, /support\s+us/i, /premium/i, /upgrade/i,
  /tutorial/i, /how\s+to\s+download/i, /how\s+to\s+watch/i,
  /guide/i, /readme/i, /instructions/i,
  /trailer/i, /teaser/i, /sample/i, /preview/i, /demo/i,
  /advertisement/i, /sponsor/i, /promo/i,
  /sign\s+in/i, /sign\s+up/i, /login/i, /register/i,
  /subscribe/i, /membership/i, /pricing/i,
  /coming\s+soon/i, /not\s+available/i, /error/i,
  /placeholder/i, /loading/i, /spinner/i,
];

const REJECT_URLS = [
  /\/login/i, /\/signin/i, /\/register/i, /\/signup/i,
  /\/donation/i, /\/donate/i, /\/premium/i, /\/upgrade/i,
  /\/subscribe/i, /\/pricing/i,
  /\.html$/i, /\/about/i, /\/contact/i, /\/privacy/i, /\/terms/i,
  /\/category\//i, /\/tag\//i, /\/page\//i, /\/feed/i,
  /googleads/i, /doubleclick/i, /googlesyndication/i,
  /facebook\.com/i, /twitter\.com/i, /instagram\.com/i,
  /youtube\.com\/watch/i, /youtu\.be/i,
];

function parseSize(text) {
  if (!text) return null;
  const m = String(text).match(/(\d+(?:\.\d+)?)\s*(GB|MB|TB|KB)/i);
  if (!m) return null;
  const v = parseFloat(m[1]);
  const u = m[2].toUpperCase();
  if (u === 'TB') return v * 1024 ** 4;
  if (u === 'GB') return v * 1024 ** 3;
  if (u === 'MB') return v * 1024 ** 2;
  if (u === 'KB') return v * 1024;
  return null;
}

export function shouldReject(s) {
  if (!s || !s.url || !s.url.startsWith('http')) return true;
  if (s.infoHash) return true; // No torrents
  const name = (s.name || '').toLowerCase();
  const title = (s.title || '').toLowerCase();
  const desc = (s.description || '').toLowerCase();
  const url = s.url.toLowerCase();
  const fn = (s.behaviorHints?.filename || '').toLowerCase();

  for (const p of REJECT_NAMES) {
    if (p.test(name) || p.test(title)) return true;
  }
  for (const p of REJECT_URLS) {
    if (p.test(url)) return true;
  }

  // Size check
  let size = s.behaviorHints?.videoSize || null;
  if (!size) size = parseSize(desc) || parseSize(fn) || parseSize(title);
  if (size !== null && size < MIN_SIZE) return true;

  // Must look like a video URL
  const videoPatterns = [
    /\.m3u8/i, /\.mp4/i, /\.mkv/i, /\.ts\b/i, /\.mov/i, /\.avi/i, /\.webm/i,
    /\/video\//i, /\/stream\//i, /\/hls\//i, /\/playlist/i, /\/cdn\//i,
    /workers\.dev/i, /pixeldrain/i, /fsl-buckets/i, /hubcloud/i,
    /googleusercontent/i, /hub\.latent/i, /r2\.dev/i, /savefiles/i,
    /111477/i, /cloudserver/i, /a\.111477/i,
  ];
  const isVideo = videoPatterns.some(p => p.test(url));
  if (!isVideo && size === null) return true;

  return false;
}

export function filterStreams(streams) {
  if (!Array.isArray(streams)) return [];
  return streams.filter(s => !shouldReject(s));
}

export { MIN_SIZE };
