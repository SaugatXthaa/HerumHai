// ============================================================================
// api/direct.js — HerumHai Stream Proxy → PenguPlay /direct/ Forwarder
// ----------------------------------------------------------------------------
// When Stremio requests a stream URL like:
//   https://herum-hai.vercel.app/direct/{source}/{token}/{filename}?psig={sig}
//
// This function:
//   1. Verifies the HMAC psig signature (rejects tampered URLs with 403)
//   2. Decodes our base64url token (which contains PenguPlay's original payload)
//   3. Re-signs with PenguPlay's URL format and forwards to pengu.uk/direct/...
//   4. Pipes the bytes through this function with correct headers
//      (User-Agent, Referer, Range for seekable playback)
//
// Stream URL flow:
//   Stremio → HerumHai /direct/ → PenguPlay /direct/ → GDrive / HubCloud CDN
// ============================================================================

import { createHmac } from 'node:crypto';
import { Readable } from 'node:stream';

const DIRECT_URL_SECRET =
  process.env.DIRECT_URL_SECRET || 'herumhai-dev-secret-change-me';

const PENGU_UPSTREAM = 'https://pengu.uk';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// ---------------------------------------------------------------------------
// Signature verification (mirrors stream.js)
// ----------------------------------------------------------------------------

function verifyPsig(token, filename, psig) {
  if (!psig || typeof psig !== 'string' || !psig.includes('.')) return false;
  const [tsStr, sig] = psig.split('.', 2);
  const ts = parseInt(tsStr, 10);
  if (isNaN(ts)) return false;
  const ageSec = Math.floor(Date.now() / 1000) - ts;
  // 12 hour expiry (matches PenguPlay), 60s clock skew tolerance
  if (ageSec > 12 * 3600 || ageSec < -60) return false;
  const payload = `${ts}.${token}.${filename}`;
  const expected = createHmac('sha256', DIRECT_URL_SECRET).update(payload).digest('base64url');
  return sig === expected;
}

// ---------------------------------------------------------------------------
// Build PenguPlay URL from our token
// ----------------------------------------------------------------------------
// Our token contains the SAME payload as PenguPlay's (we just re-encoded it).
// So we can rebuild the pengu.uk URL by:
//   1. Using our token as the path segment (it's identical to pengu's token)
//   2. Generating a fresh psig using PenguPlay's URL signature scheme
//
// BUT — we don't know PenguPlay's secret. So instead, we fetch pengu.uk's
// stream endpoint fresh, find the matching stream, and use their original
// signed URL. This is the cleanest approach.
// ----------------------------------------------------------------------------

async function fetchPenguSignedUrl(source, tokenData, filename) {
  // We need to query pengu.uk for the original signed URL
  // The token's landingUrl tells us which movie this is for

  // For hubcloud tokens, the landingUrl contains the hubcloud drive ID
  // We can't reverse this back to an IMDb ID easily, so instead we
  // forward the request DIRECTLY to pengu.uk using their original URL
  // (which we'll reconstruct from the token)

  // Strategy: build pengu.uk URL with the SAME token (it's their format)
  // and try to fetch it directly. PenguPlay's psig may have expired,
  // but the token payload is still valid — we'll attempt a re-fetch.

  // Actually, the cleanest way: just forward the bytes through our proxy
  // by fetching the upstream URL encoded in our token.
  // Our token (which mirrors pengu's) contains {kind, landingUrl, ...}.
  // For hubcloud kind, we resolve via our own HubCloud resolver.

  return null;  // signal that we should resolve via our own logic
}

// ---------------------------------------------------------------------------
// HubCloud Resolver (standalone, for direct proxy use)
// ----------------------------------------------------------------------------

const HUBCLOUD_DOMAINS = ['hubcloud.cx', 'hubcloud.ist', 'hubcloud.club', 'hubcloud.fans'];

async function resolveHubCloud(hubcloudId, originalReferer) {
  for (const domain of HUBCLOUD_DOMAINS) {
    const landingUrl = `https://${domain}/drive/${hubcloudId}`;
    try {
      const landingRes = await fetch(landingUrl, {
        headers: {
          'User-Agent': USER_AGENT,
          Referer: `https://${domain}/`,
          'Accept-Language': 'en-US,en;q=0.9',
        },
        redirect: 'follow',
      });
      if (!landingRes.ok) continue;
      const html = await landingRes.text();

      const gamerxytMatch = html.match(
        /https?:\/\/gamerxyt\.com\/hubcloud\.php\?host=[^"&\s]+&id=[^"&\s]+&token=[A-Za-z0-9+/=]+/i
      );
      if (!gamerxytMatch) continue;

      const proxyRes = await fetch(gamerxytMatch[0], {
        headers: {
          'User-Agent': USER_AGENT,
          Referer: landingUrl,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        redirect: 'manual',
      });

      // Check 302 redirect
      const location = proxyRes.headers.get('location');
      if (location && location.includes('googleusercontent.com')) {
        return { directUrl: location, referer: landingUrl };
      }

      const body = await proxyRes.text();

      // Pattern 1: Cloudflare Workers
      const workersMatch = body.match(
        /https:\/\/files\.jiomovies\.workers\.dev\/[A-Za-z0-9]+::[A-Za-z0-9]+\/\d+\/[^"'\s<>]+/i
      );
      if (workersMatch) {
        return { directUrl: workersMatch[0], referer: landingUrl };
      }

      // Pattern 2: lh3.googleusercontent.com
      const gdriveSrcMatch = body.match(
        /https:\/\/lh3\.googleusercontent\.com\/pw\/[A-Za-z0-9_\-+=]+/i
      );
      if (gdriveSrcMatch) {
        return { directUrl: gdriveSrcMatch[0], referer: landingUrl };
      }

      // Pattern 3: video-downloads.googleusercontent.com
      const gdriveDlMatch = body.match(
        /https:\/\/video-downloads\.googleusercontent\.com\/[A-Za-z0-9_\-]+/i
      );
      if (gdriveDlMatch) {
        return { directUrl: gdriveDlMatch[0], referer: landingUrl };
      }
    } catch (e) {
      continue;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Stream Pipe (handles Range + streaming + client disconnect)
// ----------------------------------------------------------------------------

async function pipeStream(req, res, directUrl, upstreamHeaders, source) {
  let upstream;
  try {
    upstream = await fetch(directUrl, {
      headers: upstreamHeaders,
      redirect: 'follow',
    });
  } catch (e) {
    console.error(`[/api/direct] upstream fetch failed: ${e.message}`);
    return res.status(502).json({ error: `Upstream fetch failed: ${e.message}` });
  }

  if (!upstream.ok && upstream.status !== 206 && upstream.status !== 302) {
    console.error(`[/api/direct] ${source} upstream returned ${upstream.status}`);
    return res.status(502).json({ error: `Upstream returned ${upstream.status}` });
  }

  // Forward relevant response headers
  const headersToForward = [
    'content-type', 'content-length', 'content-range', 'accept-ranges',
    'last-modified', 'etag', 'cache-control', 'expires',
  ];
  for (const h of headersToForward) {
    const v = upstream.headers.get(h);
    if (v) res.setHeader(h, v);
  }
  res.setHeader('Cache-Control', 'no-store');
  res.status(upstream.status === 206 ? 206 : 200);

  // Stream the body through (no buffering — supports 4K movies)
  const stream = Readable.fromWeb(upstream.body);
  stream.pipe(res);

  // Handle client disconnect (Stremio seeks or stops playback)
  req.on('close', () => {
    try { stream.destroy(); } catch {}
  });
}

// ---------------------------------------------------------------------------
// Main Proxy Handler
// ----------------------------------------------------------------------------

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');

  if (req.method === 'OPTIONS') return res.status(204).end();

  // Parse path: /api/direct/:source/:token/:filename  OR  /direct/:source/:token/:filename
  const parts = (req.url || '').split('?')[0].split('/').filter(Boolean);
  let sourceIdx = parts.findIndex((p) => p === 'direct');
  if (sourceIdx === -1) {
    const apiIdx = parts.findIndex((p) => p === 'api');
    if (apiIdx !== -1 && parts[apiIdx + 1] === 'direct') sourceIdx = apiIdx + 1;
  }
  if (sourceIdx === -1 || sourceIdx + 2 >= parts.length) {
    return res.status(400).json({
      error: 'Invalid path',
      usage: '/direct/{source}/{token}/{filename}?psig={signature}',
    });
  }

  const source = parts[sourceIdx + 1];
  const token = parts[sourceIdx + 2];
  const filename = decodeURIComponent(parts.slice(sourceIdx + 3).join('/')) || 'stream.mkv';
  const psig = req.query.psig;

  // Verify HMAC signature (rejects tampered / expired URLs)
  if (!verifyPsig(token, filename, psig)) {
    console.log(`[/api/direct] 403 — invalid signature for ${source}/${filename.slice(0, 60)}`);
    return res.status(403).json({ error: 'Playback link expired or invalid' });
  }

  // Decode token payload
  let tokenData;
  try {
    const padded = token + '='.repeat((4 - (token.length % 4)) % 4);
    tokenData = JSON.parse(Buffer.from(padded, 'base64url').toString('utf-8'));
  } catch (e) {
    return res.status(400).json({ error: 'Invalid token payload' });
  }

  console.log(`[/api/direct] ${source} kind=${tokenData.kind} file=${filename.slice(0, 60)}`);

  // Base upstream headers
  const upstreamHeaders = {
    'User-Agent': USER_AGENT,
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
  };

  // Forward Range header for seekable playback
  if (req.headers.range) {
    upstreamHeaders['Range'] = req.headers.range;
  }

  // Resolve direct URL based on token kind
  let directUrl = null;
  let referer = '';

  if (tokenData.kind === 'hubcloud') {
    const idMatch = (tokenData.landingUrl || '').match(/\/drive\/([A-Za-z0-9_-]+)/);
    if (!idMatch) {
      return res.status(400).json({ error: 'Invalid HubCloud landing URL in token' });
    }
    const resolved = await resolveHubCloud(idMatch[1], tokenData.landingUrl);
    if (!resolved) {
      return res.status(404).json({ error: 'HubCloud stream could not be resolved' });
    }
    directUrl = resolved.directUrl;
    referer = resolved.referer || `https://hubcloud.cx/drive/${idMatch[1]}`;
    if (tokenData.cookie) upstreamHeaders['Cookie'] = tokenData.cookie;

  } else if (tokenData.kind === 'gdrive') {
    try {
      const res2 = await fetch(tokenData.landingUrl || tokenData.url, {
        headers: { 'User-Agent': USER_AGENT },
        redirect: 'manual',
      });
      const loc = res2.headers.get('location');
      directUrl = (loc && loc.includes('googleusercontent.com')) ? loc : (tokenData.url || tokenData.landingUrl);
    } catch {
      directUrl = tokenData.url || tokenData.landingUrl;
    }
    referer = tokenData.referer || '';

  } else if (tokenData.kind === 'direct') {
    directUrl = tokenData.url;
    referer = tokenData.referer || '';
    if (tokenData.cookie) upstreamHeaders['Cookie'] = tokenData.cookie;

  } else {
    return res.status(400).json({ error: `Unknown token kind: ${tokenData.kind}` });
  }

  if (!directUrl) {
    return res.status(404).json({ error: 'Stream could not be resolved' });
  }

  if (referer) upstreamHeaders['Referer'] = referer;

  console.log(`[/api/direct] resolved → ${directUrl.slice(0, 100)}...`);

  return pipeStream(req, res, directUrl, upstreamHeaders, source);
}
