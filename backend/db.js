// ============================================================================
// db.js — PostgreSQL connection pool
// ============================================================================

import pg from 'pg';
const { Pool } = pg;

let pool = null;

export function getPool() {
  if (pool) return pool;
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('[db] DATABASE_URL not set — caching disabled');
    return null;
  }
  // Validate URL format — must start with postgresql:// or postgres://
  if (!url.startsWith('postgresql://') && !url.startsWith('postgres://')) {
    console.error('[db] DATABASE_URL is invalid — must start with postgresql:// or postgres://');
    console.error(`[db] Got: "${url.slice(0, 50)}..."`);
    console.error('[db] Get a valid URL from: Render → PostgreSQL → External Database URL');
    console.error('[db] Or from Supabase: Settings → Database → Connection string → URI');
    return null;
  }
  try {
    // Parse URL to extract host for IPv4 resolution
    const parsed = new URL(url);
    const host = parsed.hostname;
    console.log(`[db] Connecting to: ${host}:5432`);

    pool = new Pool({
      connectionString: url,
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 15_000,
      // SSL for cloud providers
      ssl: /supabase|neon|render|railway|upstash/i.test(url)
        ? { rejectUnauthorized: false }
        : undefined,
      // Force IPv4 (Render free tier doesn't support IPv6 outbound)
      // This prevents "connect ENETUNREACH" errors with IPv6 hosts
      host: host,
      port: parseInt(parsed.port) || 5432,
    });
    console.log(`[db] PostgreSQL pool created for ${host}`);
  } catch (e) {
    console.error(`[db] Failed to create pool: ${e.message}`);
    return null;
  }
  return pool;
}

// Get cached streams for a title
export async function getCachedStreams(type, ids, season, episode) {
  const p = getPool();
  if (!p) return null;

  try {
    let query, params;
    if (ids.imdbId) {
      query = `SELECT streams_json, source_count, updated_at FROM stream_cache
               WHERE type = $1 AND imdb_id = $2 AND season IS NOT DISTINCT FROM $3 AND episode IS NOT DISTINCT FROM $4
                 AND expires_at > NOW()
               ORDER BY updated_at DESC LIMIT 1`;
      params = [type, ids.imdbId, season, episode];
    } else if (ids.tmdbId) {
      query = `SELECT streams_json, source_count, updated_at FROM stream_cache
               WHERE type = $1 AND tmdb_id = $2 AND season IS NOT DISTINCT FROM $3 AND episode IS NOT DISTINCT FROM $4
                 AND expires_at > NOW()
               ORDER BY updated_at DESC LIMIT 1`;
      params = [type, ids.tmdbId, season, episode];
    } else if (ids.kitsuId) {
      query = `SELECT streams_json, source_count, updated_at FROM stream_cache
               WHERE type = $1 AND kitsu_id = $2 AND episode IS NOT DISTINCT FROM $3
                 AND expires_at > NOW()
               ORDER BY updated_at DESC LIMIT 1`;
      params = [type, ids.kitsuId, episode];
    } else {
      return null;
    }

    const r = await p.query(query, params);
    if (r.rows.length === 0) return null;
    return {
      streams: JSON.parse(r.rows[0].streams_json),
      sourceCount: r.rows[0].source_count,
      updatedAt: r.rows[0].updated_at,
    };
  } catch (e) {
    console.error('[db] getCachedStreams error:', e.message);
    return null;
  }
}

// Store scraped streams in cache
export async function setCachedStreams(type, ids, season, episode, title, streams) {
  const p = getPool();
  if (!p) return;

  const streamsJson = JSON.stringify(streams);
  const sourceCount = new Set(streams.map(s => s.name?.split('•')[0]?.trim() || 'unknown')).size;

  try {
    // Upsert — if same type+id+season+episode exists, update it
    let conflictTarget;
    if (ids.imdbId) {
      conflictTarget = '(imdb_id, type, season, episode)';
    } else if (ids.tmdbId) {
      conflictTarget = '(tmdb_id, type, season, episode)';
    } else if (ids.kitsuId) {
      conflictTarget = '(kitsu_id, type, episode)';
    } else {
      return;
    }

    // Use INSERT ... ON CONFLICT DO UPDATE
    await p.query(
      `INSERT INTO stream_cache (type, imdb_id, tmdb_id, kitsu_id, season, episode, title, streams_json, source_count, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW() + INTERVAL '24 hours')
       ON CONFLICT ${conflictTarget}
       DO UPDATE SET streams_json = EXCLUDED.streams_json,
                     source_count = EXCLUDED.source_count,
                     title = EXCLUDED.title,
                     expires_at = EXCLUDED.expires_at`,
      [type, ids.imdbId, ids.tmdbId, ids.kitsuId, season, episode, title, streamsJson, sourceCount]
    );
    console.log(`[db] cached ${streams.length} streams for ${type}/${ids.imdbId || ids.tmdbId || ids.kitsuId}`);
  } catch (e) {
    // If ON CONFLICT fails (no unique constraint), try simple INSERT
    try {
      await p.query(
        `INSERT INTO stream_cache (type, imdb_id, tmdb_id, kitsu_id, season, episode, title, streams_json, source_count, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW() + INTERVAL '24 hours')`,
        [type, ids.imdbId, ids.tmdbId, ids.kitsuId, season, episode, title, streamsJson, streams.length]
      );
      console.log(`[db] cached ${streams.length} streams for ${type}/${ids.imdbId || ids.tmdbId || ids.kitsuId} (simple insert)`);
    } catch (e2) {
      console.error('[db] setCachedStreams error:', e2.message);
    }
  }
}

// Log scraper result
export async function logScraperResult(scraperName, targetId, status, streamCount, durationMs, errorMessage) {
  const p = getPool();
  if (!p) return;
  try {
    await p.query(
      `INSERT INTO scraper_log (scraper_name, target_id, status, stream_count, duration_ms, error_message)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [scraperName, targetId, status, streamCount, durationMs, errorMessage || null]
    );
  } catch {}
}

// Get popular titles that need scraping (not scraped in last 6 hours)
export async function getTitlesToScrape(limit = 50) {
  const p = getPool();
  if (!p) return [];
  try {
    const r = await p.query(
      `SELECT * FROM popular_titles
       WHERE last_scraped_at IS NULL OR last_scraped_at < NOW() - INTERVAL '6 hours'
       ORDER BY priority DESC, last_scraped_at ASC NULLS FIRST
       LIMIT $1`,
      [limit]
    );
    return r.rows;
  } catch (e) {
    console.error('[db] getTitlesToScrape error:', e.message);
    return [];
  }
}

// Mark title as scraped
export async function markTitleScraped(id, streamCount) {
  const p = getPool();
  if (!p) return;
  try {
    await p.query(
      `UPDATE popular_titles SET last_scraped_at = NOW(), scrape_count = scrape_count + 1 WHERE id = $1`,
      [id]
    );
  } catch {}
}

// Add a popular title
export async function addPopularTitle(type, imdbId, tmdbId, title, priority = 0) {
  const p = getPool();
  if (!p) return;
  try {
    await p.query(
      `INSERT INTO popular_titles (type, imdb_id, tmdb_id, title, priority)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (type, imdb_id) DO UPDATE SET priority = GREATEST(popular_titles.priority, $5)`,
      [type, imdbId, tmdbId, title, priority]
    );
  } catch {}
}
