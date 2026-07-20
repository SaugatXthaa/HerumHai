// ============================================================================
// sources/hubcloud.js — HubCloud Resolver (cloned from PenguPlay)
// ----------------------------------------------------------------------------
// PenguPlay's core technique:
//   1. Visit hubcloud.{cx|ist|club|fans}/drive/{id}
//   2. Extract hidden gamerxyt.com/hubcloud.php URL from page
//   3. Fetch gamerxyt proxy → returns HTML with direct CDN URLs
//   4. Extract one of 3 CDN patterns:
//      a) files.jiomovies.workers.dev/{hash}::{hash}/{size}/{filename}
//      b) lh3.googleusercontent.com/pw/AP1Gcz...=m18
//      c) video-downloads.googleusercontent.com/{token}
// ============================================================================

import axios from 'axios';

const HUBCLOUD_DOMAINS = ['hubcloud.cx', 'hubcloud.ist', 'hubcloud.club', 'hubcloud.fans'];
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export async function fetchHtml(url, { headers = {}, timeout = 15000 } = {}) {
  try {
    const res = await axios.get(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        ...headers,
      },
      timeout,
      maxRedirects: 5,
      validateStatus: () => true,
    });
    return { status: res.status, headers: res.headers, body: res.data };
  } catch (e) {
    return { status: 0, headers: {}, body: '' };
  }
}

export function extractHubCloudIds(html) {
  const ids = new Set();
  const re = /hubcloud\.(?:ist|cx|club|fans)\/drive\/([A-Za-z0-9_-]+)/gi;
  let m;
  while ((m = re.exec(html)) !== null) ids.add(m[1]);
  return Array.from(ids);
}

export async function resolveHubCloud(hubcloudId) {
  for (const domain of HUBCLOUD_DOMAINS) {
    const landingUrl = `https://${domain}/drive/${hubcloudId}`;
    try {
      const landing = await fetchHtml(landingUrl, {
        headers: { Referer: `https://${domain}/` },
        timeout: 10000,
      });
      if (landing.status !== 200 || !landing.body) continue;

      // HubCloud proxy URL — domain rotates (gamerxyt.com, sportverse.cc, etc.)
      // Match ANY domain that has /hubcloud.php
      const proxyMatch = landing.body.match(
        /https?:\/\/[a-z0-9.-]+\/hubcloud\.php\?host=[^"&\s]+&id=[^"&\s]+&token=[A-Za-z0-9+/=]+/i
      );
      if (!proxyMatch) continue;

      const proxy = await fetchHtml(proxyMatch[0], {
        headers: { Referer: landingUrl },
        timeout: 10000,
      });
      const body = proxy.body || '';

      // Pattern 1: Cloudflare Workers
      const workersMatch = body.match(
        /https:\/\/files\.jiomovies\.workers\.dev\/[A-Za-z0-9]+::[A-Za-z0-9]+\/\d+\/[^"'\s<>]+/i
      );
      if (workersMatch) {
        const directUrl = workersMatch[0];
        const fnMatch = directUrl.match(/\/\d+\/(.+)$/);
        const sizeMatch = directUrl.match(/\/(\d+)\//);
        return {
          directUrl,
          filename: fnMatch ? decodeURIComponent(fnMatch[1]) : '',
          fileSize: sizeMatch ? parseInt(sizeMatch[1], 10) : 0,
          cookie: proxy.headers['set-cookie'] || '',
          cdn: 'workers',
          referer: landingUrl,
        };
      }

      // Pattern 2: GDrive lh3
      const gdriveSrcMatch = body.match(/https:\/\/lh3\.googleusercontent\.com\/pw\/[A-Za-z0-9_\-+=]+/i);
      if (gdriveSrcMatch) {
        return { directUrl: gdriveSrcMatch[0], filename: '', fileSize: 0, cookie: '', cdn: 'gdrive-lh3', referer: landingUrl };
      }

      // Pattern 3: video-downloads.googleusercontent.com
      const gdriveDlMatch = body.match(/https:\/\/video-downloads\.googleusercontent\.com\/[A-Za-z0-9_\-]+/i);
      if (gdriveDlMatch) {
        return { directUrl: gdriveDlMatch[0], filename: '', fileSize: 0, cookie: '', cdn: 'gdrive-dl', referer: landingUrl };
      }
    } catch (e) {
      continue;
    }
  }
  return null;
}

// Detect quality from filename
export function detectQuality(filename) {
  const t = (filename || '').toLowerCase();
  if (/2160p|4k|uhd|remux/.test(t)) return { label: '4K', rank: 2160 };
  if (/1080p|fhd|1080/.test(t)) return { label: '1080p', rank: 1080 };
  if (/720p|hd|720/.test(t)) return { label: '720p', rank: 720 };
  if (/480p|sd|480/.test(t)) return { label: '480p', rank: 480 };
  if (/360p|360/.test(t)) return { label: '360p', rank: 360 };
  return { label: '1080p', rank: 1080 };
}

// Detect audio languages from filename
export function detectAudio(filename) {
  const t = (filename || '').toLowerCase();
  const langs = [];
  if (/hindi/i.test(t)) langs.push('Hindi');
  if (/tamil/i.test(t)) langs.push('Tamil');
  if (/telugu/i.test(t)) langs.push('Telugu');
  if (/english/i.test(t)) langs.push('English');
  if (/japanese/i.test(t)) langs.push('Japanese');
  if (/korean/i.test(t)) langs.push('Korean');
  return langs.length > 0 ? langs : ['English'];
}

export function formatFileSize(bytes) {
  if (!bytes) return '';
  const gb = bytes / 1024 / 1024 / 1024;
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}
