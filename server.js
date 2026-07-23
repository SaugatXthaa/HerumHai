// =============================================================================
// server.js — HerumHai PenguPlay Edition (Pure HTTP, No Browser)
// -----------------------------------------------------------------------------
// ARCHITECTURE: Asynchronous Background Caching + p-limit(20) concurrency
//
//   Stremio request → /stream/:type/:id.json
//        │
//        ├─→ Check streamCache (instant, <50ms)
//        │     ├─ HIT  → return cached streams immediately
//        │     └─ MISS → triggerBackgroundScrape(id) [fire-and-forget]
//        │                 return {"streams":[]} instantly
//        │
//        └─→ Background scraper (p-limit throttled, 20 concurrent)
//              ├─ Queries 38+ API endpoints in parallel (~2 seconds)
//              ├─ Validates every URL (rejects 403/404/HTML)
//              └─ Stores working streams in streamCache (TTL: 6 hours)
//
// MEMORY FOOTPRINT: ~30MB (no browser, pure HTTP)
// PERFECT FOR: SnapDeploy free tier (512MB RAM)
// =============================================================================

import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { triggerBackgroundScrape, streamCache, scrapeAllSources } from './src/scraper-orchestrator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 7000;

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(cors({ origin: '*' }));
app.use(express.json());

// Serve frontend dashboard from /public
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Manifest — Stremio addon descriptor
// ---------------------------------------------------------------------------
app.get(['/manifest.json', '/manifest'], (req, res) => {
  res.json({
    id: 'com.herumhai.addon.pengu',
    version: '9.0.0',
    name: 'HerumHai',
    description: 'PenguPlay-style pure HTTP engine. 38+ API sources aggregated in <2s. Background-cached for instant playback.',
    logo: '/logo.png',
    resources: ['stream'],
    types: ['movie', 'series', 'anime'],
    idPrefixes: ['tt', 'kitsu', 'mal', 'tvdb', 'tmdb'],
    catalogs: [],
    behaviorHints: { configurable: false, configurationRequired: false },
  });
});

// ---------------------------------------------------------------------------
// CRITICAL: Stream endpoint — NEVER waits for scraping
// ---------------------------------------------------------------------------
// Cache HIT  → return streams instantly (<50ms)
// Cache MISS → trigger background scrape, return [] instantly (<10ms)
//
// This prevents Stremio's 10s "Failed to fetch" timeout.
// User refreshes after 2-3s → cache is populated → streams appear.
// ---------------------------------------------------------------------------
app.get(['/stream/:type/:id.json', '/stream/:type/:id'], async (req, res) => {
  const start = Date.now();
  const { type, id } = req.params;
  const cleanId = String(id).replace(/\.json$/, '');

  console.log(`[/stream] ${type}/${cleanId} — cache lookup...`);

  // Check cache
  const cacheKey = `${type}:${cleanId}`;
  const cached = streamCache[cacheKey];

  if (cached && Array.isArray(cached.streams) && cached.streams.length > 0) {
    const elapsed = Date.now() - start;
    console.log(`[/stream] CACHE HIT — ${cached.streams.length} streams in ${elapsed}ms`);
    return res.json({ streams: cached.streams });
  }

  // Cache miss — trigger background scrape (fire-and-forget, NO await)
  console.log(`[/stream] CACHE MISS — triggering background scrape, returning [] instantly`);
  triggerBackgroundScrape(type, cleanId);

  // Return empty array IMMEDIATELY — prevents Stremio timeout
  return res.json({ streams: [] });
});

// ---------------------------------------------------------------------------
// Cache status endpoint (for dashboard)
// ---------------------------------------------------------------------------
app.get('/cache-status', (req, res) => {
  const entries = Object.keys(streamCache);
  let totalStreams = 0;
  let hits = 0;
  let misses = 0;
  for (const key of entries) {
    const entry = streamCache[key];
    if (entry.streams) totalStreams += entry.streams.length;
    if (entry.hits) hits += entry.hits;
    if (entry.misses) misses += entry.misses;
  }
  res.json({
    size: entries.length,
    totalStreams,
    hits,
    misses,
    ttlHours: 6,
  });
});

// ---------------------------------------------------------------------------
// Manual cache refresh endpoint (for dashboard)
// ---------------------------------------------------------------------------
app.post('/cache-refresh/:type/:id', async (req, res) => {
  const { type, id } = req.params;
  console.log(`[manual-refresh] ${type}/${id}`);
  const streams = await scrapeAllSources(type, id);
  const cacheKey = `${type}:${id}`;
  streamCache[cacheKey] = {
    streams,
    scrapedAt: Date.now(),
    hits: 0,
    misses: 0,
  };
  res.json({ success: true, count: streams.length });
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
app.get('/health', (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    ok: true,
    version: '9.0.0',
    uptime: process.uptime(),
    memory: {
      rss: Math.round(mem.rss / 1024 / 1024) + 'MB',
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024) + 'MB',
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024) + 'MB',
    },
    cache: {
      size: Object.keys(streamCache).length,
      ttlHours: 6,
    },
    concurrency: 20,
    sources: 38,
  });
});

// ---------------------------------------------------------------------------
// Catch-all: serve index.html for non-API routes
// ---------------------------------------------------------------------------
app.get('*', (req, res) => {
  if (req.path.startsWith('/stream') || req.path.startsWith('/cache') ||
      req.path.startsWith('/health') || req.path.startsWith('/manifest')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------------------------------------------------------------------------
// Start server with long timeouts (for background scrapes)
// ---------------------------------------------------------------------------
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[HerumHai] PenguPlay engine running on http://0.0.0.0:${PORT}`);
  console.log(`[HerumHai] Manifest: http://0.0.0.0:${PORT}/manifest.json`);
  console.log(`[HerumHai] Dashboard: http://0.0.0.0:${PORT}/`);
  console.log(`[HerumHai] Sources: 38 | Concurrency: 20 | Cache TTL: 6h | Memory: ~30MB`);
});

// Override default timeouts — prevents background scrape kills
server.timeout = 180000;          // 3 minutes
server.keepAliveTimeout = 120000; // 2 minutes
server.headersTimeout = 125000;   // 125 seconds

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[HerumHai] SIGTERM received, shutting down');
  server.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  console.log('[HerumHai] SIGINT received, shutting down');
  server.close(() => process.exit(0));
});

// Prevent crashes
process.on('uncaughtException', (err) => {
  console.error('[HerumHai] Uncaught:', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('[HerumHai] Rejection:', err?.message || err);
});
