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

    // CRITICAL FIX: Return direct CDN URLs — do NOT wrap in /direct/ proxy.
    // Vercel serverless functions can't stream video (returns 302 SSO redirect).
    // Stremio's player handles proxyHeaders natively.
    // Backend already returns direct URLs with proxyHeaders set — just pass through.
    return res.status(200).json({ streams });
  } catch (e) {
    console.error(`[/api/streams3] error: ${e.message}`);
    return res.status(200).json({ streams: [] });
  }
}
