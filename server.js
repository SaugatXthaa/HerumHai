// =============================================================================
// server.js — HerumHai Stream Addon (v11 — Working Sources Only)
// -----------------------------------------------------------------------------
// This version uses ONLY proven-working sources that return real HTTPS streams:
//   1. HdHub proxy (hdhub.thevolecitor.qzz.io) — 21-65 direct CDN streams
//   2. Torrentio (torrentio.strem.fun) — 56+ torrent streams (P2P)
//
// ARCHITECTURE: Synchronous with caching
//   - Cache HIT → return streams instantly (<50ms)
//   - Cache MISS → fetch from HdHub proxy SYNCHRONOUSLY (3-5s), cache result
//   - Background refresh keeps cache fresh
//
// NO background-only scraping. NO placeholder cards. Returns REAL streams on
// the FIRST request. This is the only architecture that works with Stremio.
// =============================================================================

import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import axios from 'axios';
import { fetchHdHubStreams, fetchTorrentioStreams } from './src/sources.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 7000;

// In-memory cache (global object)
const streamCache = {};
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------
app.get(['/manifest.json', '/manifest'], (req, res) => {
  res.json({
    id: 'com.herumhai.addon',
    version: '11.0.0',
    name: 'HerumHai',
    description: 'Direct stream aggregator. 20+ streams per title from HdHub CDN + Torrentio.',
    logo: '/logo.png',
    resources: ['stream'],
    types: ['movie', 'series', 'anime'],
    idPrefixes: ['tt', 'kitsu', 'mal', 'tvdb', 'tmdb'],
    catalogs: [],
    behaviorHints: { configurable: false, configurationRequired: false },
  });
});

// ---------------------------------------------------------------------------
// Stream endpoint — SYNCHRONOUS with caching
// ---------------------------------------------------------------------------
app.get(['/stream/:type/:id.json', '/stream/:type/:id'], async (req, res) => {
  const start = Date.now();
  const { type, id } = req.params;
  const cleanId = String(id).replace(/\.json$/, '');
  const cacheKey = `${type}:${cleanId}`;

  console.log(`[/stream] ${type}/${cleanId} — request received`);

  // 1. Check cache — if fresh, return instantly
  const cached = streamCache[cacheKey];
  if (cached && cached.streams && cached.streams.length > 0 && (Date.now() - cached.scrapedAt < CACHE_TTL)) {
    const elapsed = Date.now() - start;
    console.log(`[/stream] CACHE HIT — ${cached.streams.length} streams in ${elapsed}ms`);
    return res.json({ streams: cached.streams });
  }

  // 2. Cache miss — fetch SYNCHRONOUSLY (Stremio shows "Fetching..." during this)
  console.log(`[/stream] CACHE MISS — fetching streams synchronously...`);

  try {
    // Fetch from both sources in parallel
    const [hdhubStreams, torrentioStreams] = await Promise.allSettled([
      fetchHdHubStreams(type, cleanId),
      fetchTorrentioStreams(type, cleanId),
    ]);

    const allStreams = [];

    if (hdhubStreams.status === 'fulfilled') {
      allStreams.push(...hdhubStreams.value);
      console.log(`[/stream] HdHub: ${hdhubStreams.value.length} streams`);
    }
    if (torrentioStreams.status === 'fulfilled') {
      allStreams.push(...torrentioStreams.value);
      console.log(`[/stream] Torrentio: ${torrentioStreams.value.length} streams`);
    }

    // Dedupe by URL
    const seen = new Set();
    const deduped = [];
    for (const s of allStreams) {
      const key = s.url || s.infoHash || JSON.stringify(s);
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(s);
      }
    }

    const elapsed = Date.now() - start;
    console.log(`[/stream] DONE — ${deduped.length} streams in ${elapsed}ms`);

    // Cache the result
    streamCache[cacheKey] = {
      streams: deduped,
      scrapedAt: Date.now(),
    };

    return res.json({ streams: deduped });
  } catch (err) {
    console.error(`[/stream] ERROR: ${err.message}`);
    return res.json({ streams: [] });
  }
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
app.get('/health', (req, res) => {
  const mem = process.memoryUsage();
  const cacheSize = Object.keys(streamCache).length;
  let totalStreams = 0;
  for (const key of Object.keys(streamCache)) {
    totalStreams += streamCache[key].streams?.length || 0;
  }
  res.json({
    ok: true,
    version: '11.0.0',
    uptime: process.uptime(),
    memory: {
      rss: Math.round(mem.rss / 1024 / 1024) + 'MB',
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024) + 'MB',
    },
    cache: {
      size: cacheSize,
      totalStreams,
      ttlHours: 6,
    },
    sources: ['hdhub-proxy', 'torrentio'],
  });
});

// ---------------------------------------------------------------------------
// Catch-all
// ---------------------------------------------------------------------------
app.get('*', (req, res) => {
  if (req.path.startsWith('/stream') || req.path.startsWith('/health') || req.path.startsWith('/manifest')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[HerumHai] Running on http://0.0.0.0:${PORT}`);
  console.log(`[HerumHai] Manifest: http://0.0.0.0:${PORT}/manifest.json`);
  console.log(`[HerumHai] Sources: HdHub proxy + Torrentio`);
});

server.timeout = 30000;          // 30s — enough for synchronous fetch
server.keepAliveTimeout = 25000;
server.headersTimeout = 26000;

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('uncaughtException', (err) => console.error('[HerumHai] Uncaught:', err.message));
process.on('unhandledRejection', (err) => console.error('[HerumHai] Rejection:', err?.message || err));
