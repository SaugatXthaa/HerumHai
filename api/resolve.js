// ============================================================================
// api/resolve.js — Lazy Client Resolver (Architecture 1)
// ----------------------------------------------------------------------------
// Instead of returning the final video URL directly (which causes MPV errors
// because Vercel's datacenter IP is blocked by Cloudflare on workers.dev),
// this endpoint does a 302 redirect to the target URL.
//
// When Stremio's MPV player opens the stream URL:
//   1. MPV hits https://herum-hai.vercel.app/api/resolve?url=WORKERS_DEV_URL
//   2. This endpoint returns HTTP 302 with Location: WORKERS_DEV_URL
//   3. MPV follows the redirect and fetches from WORKERS_DEV_URL directly
//   4. The fetch uses the USER'S RESIDENTIAL IP (not Vercel's datacenter IP)
//   5. Cloudflare allows the request → video plays ✓
//
// CRITICAL: This endpoint supports BOTH GET and HEAD methods.
// MPV sends a HEAD request first to probe the video metadata (size, format).
// If the endpoint only accepts GET, MPV gets a 404/405 and crashes with
// "unrecognized file format" error.
//
// CORS headers are set globally so Stremio's security layer doesn't block it.
// ============================================================================

export default async function handler(req, res) {
  // ---------------------------------------------------------------------------
  // Global CORS Headers — must be on EVERY response including OPTIONS and HEAD
  // Without these, Stremio's security layer drops the connection immediately
  // ---------------------------------------------------------------------------
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, Location');

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // ---------------------------------------------------------------------------
  // Parse the target URL from query string
  // ---------------------------------------------------------------------------
  const targetUrl = req.query.url || req.query.target;
  if (!targetUrl) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }

  // Validate URL
  try {
    const parsed = new URL(targetUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return res.status(400).json({ error: 'Invalid URL protocol' });
    }
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  // ---------------------------------------------------------------------------
  // HEAD request — MPV sends this FIRST to probe video metadata
  // Return headers that tell MPV this is a valid, seekable video endpoint
  // WITHOUT returning the 302 redirect (MPV needs headers, not a redirect)
  // ---------------------------------------------------------------------------
  if (req.method === 'HEAD') {
    // Set video-like headers so MPV accepts the stream
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', 'video/mp4');
    // Don't set Content-Length (we don't know the actual size here)
    // MPV will follow up with a GET request to fetch the actual bytes
    return res.status(200).end();
  }

  // ---------------------------------------------------------------------------
  // GET request — return 302 redirect to the target URL
  // MPV follows the redirect and fetches the video from the user's IP
  //
  // The redirect is transparent to MPV — it follows it automatically.
  // The user's Stremio app makes the final fetch from their residential IP,
  // bypassing Cloudflare's datacenter IP blocking.
  // ---------------------------------------------------------------------------

  // Log for debugging
  console.log(`[/api/resolve] 302 → ${targetUrl.slice(0, 120)}`);

  // Return 302 redirect
  return res.redirect(302, targetUrl);
}
