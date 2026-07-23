// server.js — HerumHai v14 (100+ sources, direct HTTPS, no debrid, 80MB+ filter)
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pLimit from 'p-limit';
import { fetchHdHubStreams, fetchCdn111477Streams, ALL_SECONDARY_SOURCES } from './src/sources.js';
import { resolveMeta, parseStremioId } from './src/utils/metadata.js';
import { filterStreams } from './src/utils/stream-filter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 7000;
const streamCache = {};
const CACHE_TTL = 6 * 60 * 60 * 1000;
const limit = pLimit(20);

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get(['/manifest.json', '/manifest'], (req, res) => {
  res.json({
    id: 'com.herumhai.addon', version: '14.0.0', name: 'HerumHai',
    description: '100+ sources. Direct HTTPS streams, no debrid. 80MB+ files only.',
    logo: '/logo.png', resources: ['stream'], types: ['movie', 'series', 'anime'],
    idPrefixes: ['tt', 'kitsu', 'mal', 'tvdb', 'tmdb'], catalogs: [],
    behaviorHints: { configurable: false, configurationRequired: false },
  });
});

app.get(['/stream/:type/:id.json', '/stream/:type/:id'], async (req, res) => {
  const start = Date.now();
  const { type, id } = req.params;
  const cleanId = String(id).replace(/\.json$/, '');
  const cacheKey = `${type}:${cleanId}`;

  const cached = streamCache[cacheKey];
  if (cached?.streams?.length > 0 && Date.now() - cached.scrapedAt < CACHE_TTL) {
    console.log(`[/stream] HIT ${cached.streams.length} in ${Date.now()-start}ms`);
    return res.json({ streams: cached.streams });
  }

  console.log(`[/stream] MISS ${type}/${cleanId}`);
  try {
    const parsed = parseStremioId(cleanId);
    let title = '';
    try { const m = await resolveMeta(parsed.imdbId || `kitsu:${parsed.kitsuId}`, type); if (m) title = `${m.name} ${m.year||''}`.trim(); } catch {}
    const target = { type, ...parsed };

    const [hdhub, cdn111, ...rest] = await Promise.all([
      fetchHdHubStreams(type, cleanId),
      fetchCdn111477Streams(target, title),
      ...ALL_SECONDARY_SOURCES.map(s => limit(() => s.scrape(target, title).catch(() => []))),
    ]);

    const all = [...hdhub, ...cdn111];
    for (const r of rest) if (Array.isArray(r)) all.push(...r);

    const filtered = filterStreams(all);
    const seen = new Set();
    const deduped = filtered.filter(s => s.url && !seen.has(s.url) && seen.add(s.url));

    console.log(`[/stream] DONE ${deduped.length} in ${Date.now()-start}ms (hdhub:${hdhub.length} cdn:${cdn111.length})`);
    streamCache[cacheKey] = { streams: deduped, scrapedAt: Date.now() };
    return res.json({ streams: deduped });
  } catch (e) {
    console.error(`[/stream] ERROR: ${e.message}`);
    return res.json({ streams: [] });
  }
});

app.get('/health', (req, res) => {
  const m = process.memoryUsage();
  res.json({ ok: true, version: '14.0.0', uptime: process.uptime(),
    memory: { rss: Math.round(m.rss/1048576)+'MB' },
    cache: { size: Object.keys(streamCache).length, ttlHours: 6 },
    sources: 2 + ALL_SECONDARY_SOURCES.length, minSizeMB: 80 });
});

app.get('*', (req, res) => {
  if (/^\/(stream|health|manifest)/.test(req.path)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[HerumHai] http://0.0.0.0:${PORT} | Sources: ${2+ALL_SECONDARY_SOURCES.length} | Min: 80MB`);
});
server.timeout = 30000; server.keepAliveTimeout = 25000; server.headersTimeout = 26000;
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('uncaughtException', e => console.error('[HerumHai]', e.message));
process.on('unhandledRejection', e => console.error('[HerumHai]', e?.message || e));
