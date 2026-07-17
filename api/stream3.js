// ============================================================================
// api/stream3.js — HerumHai Backend Proxy (queries our dedicated backend)
// ----------------------------------------------------------------------------
// SEPARATE from api/stream.js — does NOT touch the existing PenguPlay/HdHub proxy.
//
// This endpoint queries our dedicated backend (backend/server.js) which has:
//   ✓ Pre-scraped streams cached in PostgreSQL (instant response)
//   ✓ Background scraper running every 6 hours (always fresh)
//   ✓ Independent HubCloud scraper (works without PenguPlay)
//   ✓ Full PenguPlay + HdHub cloning (works even if they go down)
//
// Set BACKEND_URL env var in Vercel to enable (e.g., https://herumhai-backend.onrender.com)
// If BACKEND_URL not set, this endpoint returns empty (use /stream/ instead)
//
// Routes (via vercel.json):
//   GET /streams3/movie/tt1375666.json
//   GET /streams3/series/tt0944947:1:1.json
//   GET /streams3/movie/tmdb:27205.json
// ============================================================================

const BACKEND_TIMEOUT_MS = 30_000;

function getBackendUrl() {
  return process.env.BACKEND_URL || '';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(204).end();

  const backendUrl = getBackendUrl();
  if (!backendUrl) {
    return res.status(200).json({
      streams: [],
      error: 'BACKEND_URL not set — configure the HerumHai backend URL in Vercel env vars',
    });
  }

  const { type, id } = req.query;
  let parsedType = type;
  let parsedId = id;

  if (!parsedType || !parsedId) {
    const parts = (req.url || '').split('?')[0].split('/').filter(Boolean);
    const idx = parts.findIndex((p) => p === 'streams3');
    if (idx !== -1 && parts.length >= idx + 3) {
      parsedType = parts[idx + 1];
      parsedId = parts[idx + 2];
    }
  }

  if (!parsedType || !parsedId) {
    return res.status(400).json({
      error: 'Missing type or id',
      usage: '/streams3/movie/tt1375666.json',
    });
  }

  const cleanId = parsedId.replace(/\.json$/i, '');
  console.log(`[/api/streams3] ${parsedType}/${cleanId} → backend`);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BACKEND_TIMEOUT_MS);

    const fetchUrl = `${backendUrl}/stream/${parsedType}/${cleanId}.json`;
    const backendRes = await fetch(fetchUrl, {
      headers: { 'User-Agent': 'HerumHai-Vercel/1.0', Accept: 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!backendRes.ok) {
      console.error(`[/api/streams3] backend returned ${backendRes.status}`);
      return res.status(200).json({ streams: [] });
    }

    const data = await backendRes.json();
    const streams = data.streams || [];
    console.log(`[/api/streams3] backend returned ${streams.length} streams (cached=${data.cached || false})`);

    // Rewrite stream URLs to point to our Vercel /direct/ proxy
    // (backend returns raw URLs; we need to sign them with our DIRECT_URL_SECRET)
    const { createHmac, randomBytes } = await import('node:crypto');
    const DIRECT_URL_SECRET = process.env.DIRECT_URL_SECRET || 'herumhai-dev-secret';
    const baseUrl = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : `https://${req.headers.host || 'herum-hai.vercel.app'}`;

    const rewrittenStreams = streams.map((s) => {
      if (!s.url || !s.url.startsWith('http')) return s;

      // Build signed /direct/ URL
      const tokenData = {
        kind: 'direct',
        url: s.url,
        referer: s.behaviorHints?.proxyHeaders?.request?.Referer || '',
        cookie: '',
        filename: s.behaviorHints?.filename || '',
      };
      const token = Buffer.from(JSON.stringify(tokenData)).toString('base64url');
      const filename = s.behaviorHints?.filename || 'stream.mkv';
      const ts = Math.floor(Date.now() / 1000);
      const sig = createHmac('sha256', DIRECT_URL_SECRET)
        .update(`${ts}.${token}.${filename}`)
        .digest('base64url');
      const psig = `${ts}.${sig}`;

      return {
        ...s,
        url: `${baseUrl}/direct/backend/${token}/${encodeURIComponent(filename)}?psig=${encodeURIComponent(psig)}`,
        behaviorHints: {
          ...s.behaviorHints,
          notWebReady: true,
          proxyHeaders: {
            request: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
              ...(s.behaviorHints?.proxyHeaders?.request || {}),
            },
          },
        },
      };
    });

    return res.status(200).json({ streams: rewrittenStreams });
  } catch (e) {
    console.error(`[/api/streams3] error: ${e.message}`);
    return res.status(200).json({ streams: [] });
  }
}
