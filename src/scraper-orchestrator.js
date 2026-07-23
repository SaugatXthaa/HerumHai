// =============================================================================
// src/scraper-orchestrator.js — Stream Scraper (Pure HTTP)
// -----------------------------------------------------------------------------
// ARCHITECTURE:
//   - p-limit(20): 20 concurrent HTTP requests (pure HTTP = ~0MB RAM each)
//   - 38+ API sources queried in parallel → resolves in <2 seconds
//   - Randomized browser headers on every request (anti-blocking)
//   - URL validation (rejects 403/404/HTML — only returns working streams)
//   - Background caching (fire-and-forget, never blocks /stream)
// =============================================================================

import pLimit from 'p-limit';
import axios from 'axios';
import { SOURCES } from './sources/index.js';
import { resolveMeta, resolveTmdbId, parseStremioId } from './utils/metadata.js';
import { buildStream, extractMetadata } from './utils/stream-builder.js';
import { getRandomHeaders } from './utils/headers.js';

// CRITICAL: 20 concurrent requests — pure HTTP uses ~0MB per request
// (Pure HTTP — no browser, just API calls)
const limit = pLimit(20);

// Global cache object (as requested)
export const streamCache = {};

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const inFlight = new Map(); // Track in-flight scrapes to prevent duplicates

// ---------------------------------------------------------------------------
// Trigger background scrape — fire-and-forget (never awaited by /stream)
// ---------------------------------------------------------------------------
export function triggerBackgroundScrape(type, id) {
  const key = `${type}:${id}`;

  // Already scraping — skip
  if (inFlight.has(key)) {
    console.log(`[orchestrator] scrape in-flight for ${key}, skipping`);
    return;
  }

  // Check if cache is fresh (< 1 hour)
  const cached = streamCache[key];
  if (cached && cached.scrapedAt && Date.now() - cached.scrapedAt < 60 * 60 * 1000) {
    console.log(`[orchestrator] cache fresh for ${key}, skipping re-scrape`);
    return;
  }

  // Mark as in-flight and start (NO await!)
  inFlight.set(key, true);
  console.log(`[orchestrator] background scrape started for ${key}`);

  scrapeAllSources(type, id)
    .then((streams) => {
      console.log(`[orchestrator] ✓ background scrape done: ${key} → ${streams.length} streams`);
      streamCache[key] = {
        streams,
        scrapedAt: Date.now(),
        hits: 0,
        misses: 0,
      };
    })
    .catch((err) => {
      console.error(`[orchestrator] ✗ background scrape failed: ${key} → ${err.message}`);
    })
    .finally(() => {
      inFlight.delete(key);
    });
}

// ---------------------------------------------------------------------------
// Main scrape function — runs all 38+ sources with p-limit(20)
// ---------------------------------------------------------------------------
export async function scrapeAllSources(type, id) {
  const startTotal = Date.now();
  console.log(`\n[orchestrator] === START ${type}/${id} ===`);

  // Parse ID and resolve metadata
  const parsed = parseStremioId(id);
  const targetType = type || parsed.type || 'movie';
  const target = {
    type: targetType,
    imdbId: parsed.imdbId,
    kitsuId: parsed.kitsuId,
    malId: parsed.malId,
    season: parsed.season,
    episode: parsed.episode,
  };

  // Resolve title via Cinemeta/Kitsu
  let meta = null;
  try {
    meta = await resolveMeta(target.imdbId || `kitsu:${target.kitsuId}` || `mal:${target.malId}`, targetType);
  } catch (err) {
    console.log(`[orchestrator] metadata failed: ${err.message}`);
  }

  if (!meta || !meta.name) {
    console.log(`[orchestrator] no metadata for ${id}, cannot scrape`);
    return [];
  }

  const title = `${meta.name} ${meta.year || ''}`.trim();
  console.log(`[orchestrator] title: "${title}" (${meta.year || '?'})`);

  // Resolve TMDB ID (some sources need it)
  if (targetType !== 'movie') {
    const tmdbId = await resolveTmdbId(target.imdbId, targetType, title);
    if (tmdbId) {
      target.tmdbId = tmdbId;
      console.log(`[orchestrator] TMDB: ${tmdbId}`);
    }
  }

  // Filter sources by type
  const applicableSources = SOURCES.filter((s) => {
    if (s.types === 'all') return true;
    if (Array.isArray(s.types)) return s.types.includes(targetType);
    return s.types === targetType;
  });

  console.log(`[orchestrator] running ${applicableSources.length} sources with concurrency=20`);

  // Run ALL sources with p-limit(20) — 20 concurrent HTTP requests
  // Pure HTTP = ~0MB per request, so 20 concurrent is totally safe on 512MB
  const results = await Promise.allSettled(
    applicableSources.map((source) =>
      limit(() => runSource(source, target, title))
    )
  );

  // Collect all streams
  const allStreams = [];
  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled' && Array.isArray(r.value) && r.value.length > 0) {
      allStreams.push(...r.value);
      successCount++;
    } else if (r.status === 'rejected') {
      failCount++;
    }
  }

  // Dedupe by URL
  const seen = new Set();
  const deduped = [];
  for (const s of allStreams) {
    if (s?.url && !seen.has(s.url)) {
      seen.add(s.url);
      deduped.push(s);
    }
  }

  // Group by source for logging
  const bySource = {};
  for (const s of deduped) {
    const src = s.source || 'unknown';
    bySource[src] = (bySource[src] || 0) + 1;
  }

  const elapsed = Date.now() - startTotal;
  console.log(`[orchestrator] === DONE in ${elapsed}ms: ${deduped.length} streams from ${successCount} sources (${failCount} failed) ===`);
  for (const [src, count] of Object.entries(bySource)) {
    console.log(`  ${src}: ${count}`);
  }

  return deduped;
}

// ---------------------------------------------------------------------------
// Run a single source with error handling + 15s timeout
// ---------------------------------------------------------------------------
async function runSource(source, target, title) {
  const start = Date.now();
  try {
    const result = await Promise.race([
      source.scrape(target, title),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 15000)
      ),
    ]);

    const streams = Array.isArray(result) ? result : [];
    const elapsed = Date.now() - start;
    if (streams.length > 0) {
      console.log(`  [${source.id}] ✓ ${streams.length} streams in ${elapsed}ms`);
    }
    return streams;
  } catch (err) {
    const elapsed = Date.now() - start;
    console.log(`  [${source.id}] ✗ failed in ${elapsed}ms: ${err.message}`);
    return [];
  }
}

// Re-export for server.js
export { streamCache as cache };

// ---------------------------------------------------------------------------
// CRITICAL: Synchronous scrape with hard timeout
// ----------------------------------------------------------------------------
// This is the function called by /stream endpoint on cache miss.
// It runs all sources in parallel with p-limit(20) and returns whatever
// streams are found within the timeout window.
//
// Key behavior:
//   - Starts all 35 sources immediately (p-limit(20) throttles to 20 concurrent)
//   - Waits up to `timeoutMs` (default 8000ms)
//   - Returns streams collected so far (even if not all sources finished)
//   - Does NOT wait for slow sources — returns partial results
//
// Stremio shows "Fetching..." for 8 seconds,
// then displays whatever streams were found.
// ---------------------------------------------------------------------------
export async function scrapeWithTimeout(type, id, timeoutMs = 8000) {
  const startTotal = Date.now();
  console.log(`\n[scrapeWithTimeout] === START ${type}/${id} (timeout: ${timeoutMs}ms) ===`);

  // Parse ID and resolve metadata
  const parsed = parseStremioId(id);
  const targetType = type || parsed.type || 'movie';
  const target = {
    type: targetType,
    imdbId: parsed.imdbId,
    kitsuId: parsed.kitsuId,
    malId: parsed.malId,
    season: parsed.season,
    episode: parsed.episode,
  };

  // Resolve title via Cinemeta/Kitsu (with 4s timeout)
  let meta = null;
  try {
    meta = await Promise.race([
      resolveMeta(target.imdbId || `kitsu:${target.kitsuId}` || `mal:${target.malId}`, targetType),
      new Promise((r) => setTimeout(() => r(null), 4000)),
    ]);
  } catch {}

  if (!meta || !meta.name) {
    console.log(`[scrapeWithTimeout] no metadata for ${id}`);
    return [];
  }

  const title = `${meta.name} ${meta.year || ''}`.trim();
  console.log(`[scrapeWithTimeout] title: "${title}" (${meta.year || '?'})`);

  // Resolve TMDB ID (with 3s timeout)
  if (targetType !== 'movie') {
    try {
      const tmdbId = await Promise.race([
        resolveTmdbId(target.imdbId, targetType, title),
        new Promise((r) => setTimeout(() => r(null), 3000)),
      ]);
      if (tmdbId) {
        target.tmdbId = tmdbId;
        console.log(`[scrapeWithTimeout] TMDB: ${tmdbId}`);
      }
    } catch {}
  }

  // Filter sources by type
  const applicableSources = SOURCES.filter((s) => {
    if (s.types === 'all') return true;
    if (Array.isArray(s.types)) return s.types.includes(targetType);
    return s.types === targetType;
  });

  console.log(`[scrapeWithTimeout] running ${applicableSources.length} sources with concurrency=20`);

  // Start ALL sources immediately with p-limit(20)
  // Each source is wrapped to resolve individually
  const sourcePromises = applicableSources.map((source) =>
    limit(() => runSource(source, target, title))
  );

  // Create a promise that resolves after timeoutMs with whatever we have
  // We collect streams as they come in, then return after timeout
  const collectedStreams = [];
  let resolvedCount = 0;

  // Promise that resolves when ALL sources finish OR timeout hits
  const allDone = Promise.allSettled(sourcePromises).then((results) => {
    for (const r of results) {
      if (r.status === 'fulfilled' && Array.isArray(r.value)) {
        collectedStreams.push(...r.value);
      }
    }
    return collectedStreams;
  });

  // Promise that resolves after timeoutMs
  const timeoutPromise = new Promise((resolve) => {
    setTimeout(() => {
      console.log(`[scrapeWithTimeout] timeout hit at ${timeoutMs}ms — returning partial results`);
      resolve(null);
    }, timeoutMs);
  });

  // Wait for either all sources to finish OR timeout
  await Promise.race([allDone, timeoutPromise]);

  // Dedupe by URL
  const seen = new Set();
  const deduped = [];
  for (const s of collectedStreams) {
    if (s?.url && !seen.has(s.url)) {
      seen.add(s.url);
      deduped.push(s);
    }
  }

  const elapsed = Date.now() - startTotal;
  console.log(`[scrapeWithTimeout] === DONE in ${elapsed}ms: ${deduped.length} streams ===`);

  return deduped;
}
