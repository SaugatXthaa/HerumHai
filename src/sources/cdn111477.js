// src/sources/cdn111477.js — 111477 CDN Directory Scraper
import axios from 'axios';

const CDN = 'https://a.111477.xyz';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MIN_SIZE = 80 * 1024 * 1024;

async function fetchDir(url) {
  try {
    const res = await axios.get(url, {
      timeout: 8000,
      headers: { 'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9' },
      validateStatus: () => true,
    });
    if (res.status === 200 && typeof res.data === 'string') return res.data;
    return null;
  } catch { return null; }
}

function parseFiles(html) {
  if (!html) return [];
  const files = [];
  const seen = new Set();
  for (const m of html.matchAll(/href="([^"]+\.(?:mkv|mp4|avi|mov))"/gi)) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    let fn;
    try { fn = decodeURIComponent(m[1].split('/').pop() || ''); }
    catch { fn = m[1].split('/').pop() || ''; }
    files.push({ href: m[1].startsWith('http') ? m[1] : `${CDN}${m[1]}`, filename: fn, sizeText: '', sizeBytes: null });
  }
  const sizes = [];
  for (const m of html.matchAll(/([0-9]+(?:\.[0-9]+)?)\s*(GB|MB|TB|KB)/gi)) {
    const v = parseFloat(m[1]); const u = m[2].toUpperCase();
    let b = null;
    if (u === 'TB') b = v * 1024**4;
    else if (u === 'GB') b = v * 1024**3;
    else if (u === 'MB') b = v * 1024**2;
    else if (u === 'KB') b = v * 1024;
    sizes.push({ text: `${v} ${u}`, bytes: b });
  }
  for (let i = 0; i < files.length && i < sizes.length; i++) {
    files[i].sizeText = sizes[i].text;
    files[i].sizeBytes = sizes[i].bytes;
  }
  return files;
}

function getMeta(text) {
  const t = String(text); const m = {};
  if (/\b(?:2160p|4k|uhd)\b/i.test(t)) m.resolution = '4K';
  else if (/\b1080p\b/i.test(t)) m.resolution = '1080p';
  else if (/\b720p\b/i.test(t)) m.resolution = '720p';
  else if (/\b480p\b/i.test(t)) m.resolution = '480p';
  if (/remux/i.test(t)) m.quality = 'REMUX';
  else if (/bluray|blu-ray/i.test(t)) m.quality = 'BluRay';
  else if (/web-?dl/i.test(t)) m.quality = 'WEB-DL';
  if (/x265|hevc/i.test(t)) m.codec = 'HEVC';
  else if (/x264|h\.?264/i.test(t)) m.codec = 'AVC';
  if (/10bit/i.test(t)) m.bitDepth = '10bit';
  if (/dolby.?vision|\bdv\b/i.test(t)) m.hdr = 'DV';
  else if (/hdr/i.test(t)) m.hdr = 'HDR';
  const l = [];
  if (/hindi/i.test(t)) l.push('Hindi');
  if (/english|eng/i.test(t)) l.push('English');
  if (/tamil/i.test(t)) l.push('Tamil');
  if (/telugu/i.test(t)) l.push('Telugu');
  if (/korean|kor/i.test(t)) l.push('Korean');
  if (l.length) m.language = l.join(' · ');
  return m;
}

function build(file, title, src) {
  const m = getMeta(`${file.filename} ${title}`);
  const n = `HerumHai · ${src}` + (m.resolution ? ` · ${m.resolution}` : '') + (m.quality ? ` · ${m.quality}` : '') + (m.codec ? ` · ${m.codec}` : '') + (m.hdr ? ` · ${m.hdr}` : '');
  return {
    name: n, title: n,
    description: `Source: ${src}\nFile: ${file.filename}\nTitle: ${title}` + (m.resolution ? `\nResolution: ${m.resolution}` : '') + (m.quality ? `\nQuality: ${m.quality}` : '') + (m.language ? `\nLanguage: ${m.language}` : '') + (file.sizeText ? `\nSize: ${file.sizeText}` : ''),
    url: file.href, source: 'cdn111477',
    behaviorHints: {
      notWebReady: true, filename: file.filename,
      ...(file.sizeBytes && { videoSize: file.sizeBytes }),
      proxyHeaders: { request: { 'User-Agent': UA, Referer: `${CDN}/` } },
      bingeGroup: `herumhai-111477-${file.filename.slice(0,20)}`,
    },
  };
}

function isValid(f) {
  if (f.sizeBytes !== null && f.sizeBytes < MIN_SIZE) return false;
  const l = (f.filename || '').toLowerCase();
  return !l.includes('trailer') && !l.includes('sample') && !l.includes('preview') && !l.includes('tutorial');
}

async function scrapeMovie(target, title) {
  if (!title) return [];
  const ym = title.match(/\((\d{4})\)|(\d{4})$/);
  const year = ym ? (ym[1] || ym[2]) : '';
  const clean = title.replace(/\s*\(?(\d{4})\)?\s*$/, '').trim();
  if (!clean) return [];
  const url = `${CDN}/movies/${encodeURIComponent(`${clean} (${year})`)}/`;
  const html = await fetchDir(url);
  if (!html) return [];
  const files = parseFiles(html);
  if (!files.length) return [];
  return files.filter(isValid).slice(0, 10).map(f => build(f, title, '111477'));
}

async function scrapeSeries(target, title) {
  if (!title) return [];
  const { season, episode } = target;
  const clean = title.replace(/\s*\(?(\d{4})\)?\s*$/, '').trim();
  if (!clean) return [];
  const url = `${CDN}/tvs/${encodeURIComponent(clean)}/Season%20${season || 1}/`;
  const html = await fetchDir(url);
  if (!html) return [];
  const files = parseFiles(html);
  if (!files.length) return [];
  const ep = episode ? new RegExp(`S0?${season||1}E0?${episode}`, 'i') : null;
  const epFiles = ep ? files.filter(f => ep.test(f.filename)) : files;
  if (!epFiles.length) return [];
  return epFiles.filter(isValid).slice(0, 8).map(f => build(f, `${title} S${season||1}E${episode||1}`, '111477'));
}

async function scrape(target, title) {
  try {
    if (target.type === 'movie') return await scrapeMovie(target, title);
    if (target.type === 'series' || target.type === 'anime') return await scrapeSeries(target, title);
  } catch (e) { console.log(`[cdn111477] error: ${e.message}`); }
  return [];
}

export default { id: 'cdn111477', name: '111477 CDN', types: 'all', scrape };
