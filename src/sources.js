// =============================================================================
// src/sources.js — Working Stream Sources (Pure HTTP, No Browser)
// -----------------------------------------------------------------------------
// These are the ONLY sources that actually return real playable HTTPS streams:
//
//   1. HdHub proxy (hdhub.thevolecitor.qzz.io)
//      - Returns 21-65 direct CDN streams per title
//      - Sources: workers.dev, pixeldrain.dev, fsl-buckets, googleusercontent
//      - All streams have proxyHeaders with proper Referer
//      - Tested: works from any IP (no Cloudflare blocking)
//
//   2. Torrentio (torrentio.strem.fun)
//      - Returns 56+ torrent streams (P2P — requires debrid for playback)
//      - Works without any API key
//      - Provides magnet links / infoHashes
// =============================================================================

import axios from 'axios';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const HDHUB_PROXY = 'https://hdhub.thevolecitor.qzz.io';

// ---------------------------------------------------------------------------
// Fetch streams from HdHub proxy
// ----------------------------------------------------------------------------
// The HdHub proxy is a Stremio addon that returns direct CDN streams.
// It handles all the complex scraping (4khdhub, hdhub4u, fsl-buckets, etc.)
// and returns clean stream objects with proxyHeaders.
//
// We simply proxy its response, filtering out donation messages.
// ---------------------------------------------------------------------------
export async function fetchHdHubStreams(type, id) {
  try {
    // Determine the correct path for the HdHub proxy
    // It uses the same /stream/:type/:id.json format
    const url = `${HDHUB_PROXY}/stream/${type}/${id}.json`;

    console.log(`[hdhub] fetching ${url}`);
    const res = await axios.get(url, {
      timeout: 10000,
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json',
      },
      validateStatus: () => true,
    });

    if (res.status !== 200 || !res.data?.streams) {
      console.log(`[hdhub] no streams (status ${res.status})`);
      return [];
    }

    // Filter out donation messages (streams with externalUrl instead of url)
    const realStreams = res.data.streams.filter((s) => {
      // Keep only streams with actual video URLs
      if (!s.url) return false;
      // Skip donation/promo entries
      if (s.externalUrl && !s.url) return false;
      if (s.name && s.name.toLowerCase().includes('donation')) return false;
      if (s.name && s.name.toLowerCase().includes('donate')) return false;
      // Skip login redirects
      if (s.url.includes('/login.php')) return false;
      return true;
    });

    // Add source tag for the formatter
    const tagged = realStreams.map((s) => ({
      ...s,
      source: 'hdhub',
    }));

    console.log(`[hdhub] returned ${tagged.length} real streams`);
    return tagged;
  } catch (err) {
    console.log(`[hdhub] error: ${err.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Fetch streams from Torrentio
// ----------------------------------------------------------------------------
// Torrentio is the most popular Stremio torrent addon.
// Returns magnet/infoHash streams that work with debrid services.
// No API key required — just hit the public endpoint.
// ---------------------------------------------------------------------------
export async function fetchTorrentioStreams(type, id) {
  try {
    // Torrentio supports: /stream/movie/tt1375666.json or /stream/series/tt0944947:1:1.json
    const url = `https://torrentio.strem.fun/stream/${type}/${id}.json`;

    console.log(`[torrentio] fetching ${url}`);
    const res = await axios.get(url, {
      timeout: 8000,
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json',
      },
      validateStatus: () => true,
    });

    if (res.status !== 200 || !res.data?.streams) {
      console.log(`[torrentio] no streams (status ${res.status})`);
      return [];
    }

    // Tag streams with source = torrentio
    const tagged = res.data.streams.map((s) => ({
      ...s,
      source: 'torrentio',
    }));

    console.log(`[torrentio] returned ${tagged.length} streams`);
    return tagged;
  } catch (err) {
    console.log(`[torrentio] error: ${err.message}`);
    return [];
  }
}

export default { fetchHdHubStreams, fetchTorrentioStreams };
