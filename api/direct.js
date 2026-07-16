// ============================================================================
// api/direct.js — HerumHai Signed-URL Stream Proxy (PenguPlay-style)
// ----------------------------------------------------------------------------
// Mirrors pengu.uk's /direct/{source}/{token}/{filename}?psig={sig} flow.
//
// Token kinds supported:
//   {kind: 'hubcloud', landingUrl, referer, cookie, filename}
//     → Re-resolves HubCloud landing URL → gamerxyt → GDrive direct
//
//   {kind: 'gdrive', landingUrl, referer}
//     → Resolves GDrive URL → follows 302 to googleusercontent
//
//   {kind: 'direct', url, referer, cookie}
//     → Streams URL directly with provided headers
//
// Features:
//   ✓ HMAC-SHA256 signature verification (12h expiry)
//   ✓ Range header forwarding for seekable playback
//   ✓ Streaming response (no buffering — supports full 4K movies)
//   ✓ Per-CDN header injection (Referer, UA, Cookie)
//   ✓ 302 redirect chasing through gamerxyt → GDrive
//   ✓ Client disconnect handling (stream.destroy on req.close)
// ============================================================================

import { createHmac } from 'node:crypto';
import { Readable } from 'node:stream';

const DIRECT_URL_SECRET =
  process.env.DIRECT_URL_SECRET || 'herumhai-dev-secret-change-me';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// HubCloud domain rotation (matches stream.js)
const HUBCLOUD_DOMAINS = ['hubcloud.cx', 'hubcloud.ist', 'hubcloud.club', 'hubcloud.fans'];

// ---------------------------------------------------------------------------
// Signature verification (mirrors the signer in stream.js)
// ----------------------------------------------------------------------------

function verifyPsig(token, filename, psig) {
  if (!psig || typeof psig !== 'string' || !psig.includes('.')) return false;
  const [tsStr, sig] = psig.split('.', 2);
  const ts = parseInt(tsStr, 10);
  if (isNaN(ts)) return false;
  const ageSec = Math.floor(Date.now() / 1000) - ts;
  if (ageSec > 12 * 3600 || ageSec < -60) return false;  // 12h expiry, 60s clock skew
  const payload = `${ts}.${token}.${filename}`;
  const expected = createHmac('sha256', DIRECT_URL_SECRET).update(payload).digest('base64url');
  return sig === expected;
}

// ---------------------------------------------------------------------------
// HubCloud Resolver (mirrors stream.js but standalone for the proxy)
// ----------------------------------------------------------------------------

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
        redirect: 'manual',  // capture 302 without following
      });

      // Check 302 redirect first
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
// GDrive Resolver (for {kind: 'gdrive'} tokens)
// ----------------------------------------------------------------------------

async function resolveGdrive(landingUrl) {
  try {
    const res = await fetch(landingUrl, {
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'manual',
    });
    const loc = res.headers.get('location');
    if (loc && (loc.includes('googleusercontent.com') || loc.includes('docs.google.com'))) {
      return loc;
    }
  } catch {}
  return landingUrl;
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

  // 200 / 206 / 302 are acceptable; anything else is an error
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
  // CORS — open to all Stremio / Nuvio clients
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');

  if (req.method === 'OPTIONS') return res.status(204).end();

  // Parse path: /api/direct/:source/:token/:filename  OR  /direct/:source/:token/:filename
  const parts = (req.url || '').split('?')[0].split('/').filter(Boolean);
  let sourceIdx = parts.findIndex((p) => p === 'direct');
  if (sourceIdx === -1) {
    // /api/direct/:source/:token/:filename
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

  // Base upstream headers (always include UA + Accept-Language)
  const upstreamHeaders = {
    'User-Agent': USER_AGENT,
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
  };

  // Forward Range header for seekable playback (Stremio seeks a lot)
  if (req.headers.range) {
    upstreamHeaders['Range'] = req.headers.range;
  }

  // Resolve direct URL based on token kind
  let directUrl = null;

  if (tokenData.kind === 'hubcloud') {
    // Extract HubCloud ID from landing URL
    const idMatch = (tokenData.landingUrl || '').match(/\/drive\/([A-Za-z0-9_-]+)/);
    if (!idMatch) {
      return res.status(400).json({ error: 'Invalid HubCloud landing URL in token' });
    }
    const resolved = await resolveHubCloud(idMatch[1], tokenData.landingUrl);
    if (!resolved) {
      return res.status(404).json({ error: 'HubCloud stream could not be resolved' });
    }
    directUrl = resolved.directUrl;
    upstreamHeaders['Referer'] = resolved.referer || `https://hubcloud.cx/drive/${idMatch[1]}`;
    if (tokenData.cookie) upstreamHeaders['Cookie'] = tokenData.cookie;

  } else if (tokenData.kind === 'gdrive') {
    directUrl = await resolveGdrive(tokenData.landingUrl || tokenData.url);
    if (tokenData.referer) upstreamHeaders['Referer'] = tokenData.referer;

  } else if (tokenData.kind === 'direct') {
    directUrl = tokenData.url;
    if (tokenData.referer) upstreamHeaders['Referer'] = tokenData.referer;
    if (tokenData.cookie) upstreamHeaders['Cookie'] = tokenData.cookie;

  } else {
    return res.status(400).json({ error: `Unknown token kind: ${tokenData.kind}` });
  }

  if (!directUrl) {
    return res.status(404).json({ error: 'Stream could not be resolved' });
  }

  console.log(`[/api/direct] resolved → ${directUrl.slice(0, 100)}...`);

  // Stream the bytes through with correct headers
  return pipeStream(req, res, directUrl, upstreamHeaders, source);
}
