// ============================================================================
// server.js — HerumHai Backend API Server
// ----------------------------------------------------------------------------
// Express server that exposes cached streams to the Vercel addon.
//
// Endpoints:
//   GET /health                         → service health
//   GET /stream/:type/:id.json          → cached streams (or on-demand scrape)
//   GET /api/stream?type=movie&id=tt... → same, query-string style
//   POST /scrape/:type/:id              → trigger on-demand scrape
//
// Deploy to Render.com (free tier) or Railway/Fly.io
// ============================================================================

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import { getCachedStreams, setCachedStreams } from './db.js';
import { scrapeTitle, runBackgroundScrape, seedPopularTitles } from './scraper.js';
import { getSourceList } from './sources/registry.js';

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors({ origin: '*' }));
app.use(express.json());

// ---------------------------------------------------------------------------
// Root endpoint — responds to / so cron-job.org health checks work
// ---------------------------------------------------------------------------
app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'herumhai-backend',
    version: '1.0.0',
    ts: new Date().toISOString(),
    endpoints: ['/health', '/stream/:type/:id.json', '/api/stream'],
  });
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
app.get('/health', (req, res) => {
  const sources = getSourceList();
  res.json({
    ok: true,
    service: 'herumhai-backend',
    version: '1.0.0',
    ts: new Date().toISOString(),
    database: process.env.DATABASE_URL ? 'configured' : 'not-configured',
    clonedSources: sources.length,
    sourceList: sources.map(s => s.slug),
    independence: 'full — works without PenguPlay/HdHub',
  });
});

// ---------------------------------------------------------------------------
// Stream endpoint — serves from cache, or triggers on-demand scrape
// ---------------------------------------------------------------------------
async function handleStreamRequest(req, res) {
  const { type, id } = req.params;
  if (!type || !id) {
    return res.status(400).json({ error: 'Missing type or id', streams: [] });
  }

  // Parse ID
  const cleanId = id.replace(/\.json$/i, '');
  const ids = { imdbId: null, tmdbId: null, kitsuId: null };
  let season = null, episode = null;

  if (cleanId.startsWith('tmdb:')) {
    ids.tmdbId = cleanId;
    const parts = cleanId.split(':');
    if (parts.length >= 4) { season = parseInt(parts[2]); episode = parseInt(parts[3]); }
  } else if (cleanId.startsWith('kitsu:') || type === 'anime') {
    const parts = cleanId.split(':');
    ids.kitsuId = parts[0] === 'kitsu' ? parts[1] : parts[0];
    episode = parts[0] === 'kitsu' ? parseInt(parts[2]) || 1 : parseInt(parts[1]) || 1;
  } else if (type === 'series') {
    const parts = cleanId.split(':');
    ids.imdbId = parts[0];
    season = parts[1] ? parseInt(parts[1]) : null;
    episode = parts[2] ? parseInt(parts[2]) : null;
  } else {
    ids.imdbId = cleanId;
  }

  console.log(`[/stream] ${type}/${cleanId}`);

  // 1. Check cache first
  const cached = await getCachedStreams(type, ids, season, episode);
  if (cached && cached.streams.length > 0) {
    console.log(`[cache] HIT — ${cached.streams.length} streams (updated ${cached.updatedAt})`);
    return res.json({ streams: cached.streams, cached: true, sourceCount: cached.sourceCount });
  }

  console.log(`[cache] MISS — triggering on-demand scrape`);

  // 2. On-demand scrape (with 60s timeout)
  try {
    // Resolve title for better scraping
    let title = '';
    if (ids.imdbId) {
      try {
        const metaType = type === 'series' ? 'series' : 'movie';
        const metaRes = await fetch(`https://v3-cinemeta.strem.io/meta/${metaType}/${ids.imdbId}.json`, {
          signal: AbortSignal.timeout(5000),
        });
        if (metaRes.ok) {
          const meta = await metaRes.json();
          title = meta.meta?.name || '';
        }
      } catch {}
    }

    // Scrape with 60s deadline
    const streams = await Promise.race([
      scrapeTitle(type, ids, season, episode, title),
      new Promise((_, reject) => setTimeout(() => reject(new Error('scrape-timeout')), 60000)),
    ]);

    return res.json({ streams, cached: false, sourceCount: streams.length });
  } catch (e) {
    console.error(`[/stream] scrape failed: ${e.message}`);
    // Return empty — Vercel addon will fall back to PenguPlay/HdHub
    return res.json({ streams: [], cached: false, error: e.message });
  }
}

app.get('/stream/:type/:id.json', handleStreamRequest);
app.get('/stream/:type/:id', handleStreamRequest);
app.get('/api/stream/:type/:id.json', handleStreamRequest);
app.get('/api/stream/:type/:id', handleStreamRequest);

app.get('/api/stream', async (req, res) => {
  const { type, id } = req.query;
  req.params = { type, id };
  return handleStreamRequest(req, res);
});

// ---------------------------------------------------------------------------
// Manual scrape trigger
// ---------------------------------------------------------------------------
app.post('/scrape/:type/:id', async (req, res) => {
  const { type, id } = req.params;
  const cleanId = id.replace(/\.json$/i, '');
  const ids = { imdbId: cleanId.startsWith('tt') ? cleanId : null, tmdbId: cleanId.startsWith('tmdb:') ? cleanId : null, kitsuId: null };

  try {
    const streams = await scrapeTitle(type, ids, null, null, req.body?.title || '');
    res.json({ ok: true, count: streams.length });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Cron job — background scrape every 6 hours
// ---------------------------------------------------------------------------
if (process.env.DATABASE_URL) {
  // Seed popular titles on startup
  setTimeout(() => seedPopularTitles().catch(console.error), 5000);

  // Run background scrape every 6 hours
  cron.schedule('0 */6 * * *', () => {
    console.log(`[cron] triggering background scrape at ${new Date().toISOString()}`);
    runBackgroundScrape().catch(console.error);
  });

  // Also run once 30 seconds after startup
  setTimeout(() => runBackgroundScrape().catch(console.error), 30000);

  console.log('[cron] background scraper scheduled (every 6 hours)');
} else {
  console.log('[cron] DATABASE_URL not set — background scraper disabled');
}

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`\n=====================================================`);
  console.log(`  HerumHai Backend v1.0.0`);
  console.log(`  Listening on http://0.0.0.0:${PORT}`);
  console.log(`  Database: ${process.env.DATABASE_URL ? 'configured' : 'NOT configured'}`);
  console.log(`  TMDB API: ${process.env.TMDB_API_KEY ? 'configured' : 'not configured'}`);
  console.log(`=====================================================\n`);
});
