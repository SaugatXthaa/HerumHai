// =============================================================================
// src/utils/metadata.js — Cinemeta + Kitsu + TMDB Metadata Resolver
// -----------------------------------------------------------------------------
// Resolves Stremio meta IDs (tt1234567, kitsu:12, mal:21) to title + year.
// Uses pure HTTP (axios) — no browser needed.
// =============================================================================

import { fetchJson } from './http.js';

const TMDB_API_KEY = process.env.TMDB_API_KEY || '6b2dec73b6697866a50cdaef60ccffcb';
const metaCache = new Map();
const META_CACHE_TTL = 30 * 60 * 1000; // 30 min

export async function resolveMeta(imdbId, type) {
  if (!imdbId) return null;

  const cacheKey = `${imdbId}:${type}`;
  const cached = metaCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < META_CACHE_TTL) return cached.data;

  let result = null;
  try {
    if (imdbId.startsWith('kitsu:')) {
      result = await lookupKitsu(imdbId);
    } else if (imdbId.startsWith('mal:')) {
      result = await lookupJikan(imdbId);
    } else if (imdbId.startsWith('tmdb:')) {
      result = await lookupTmdb(imdbId, type);
    } else {
      result = await lookupCinemeta(imdbId, type);
    }
  } catch (err) {
    console.log(`[metadata] failed for ${imdbId}: ${err.message}`);
  }

  if (result) metaCache.set(cacheKey, { data: result, ts: Date.now() });
  return result;
}

async function lookupCinemeta(imdbId, type) {
  const cinemetaType = type === 'movie' ? 'movie' : 'series';
  const url = `https://v3-cinemeta.strem.io/meta/${cinemetaType}/${imdbId}.json`;
  const data = await fetchJson(url, { timeout: 4000 });
  const m = data?.meta;
  if (!m) return null;
  return {
    name: m.name || '',
    year: m.year ? String(m.year).slice(0, 4) : '',
    releaseInfo: m.releaseInfo || m.year || '',
    type: type || (m.type === 'movie' ? 'movie' : 'series'),
  };
}

async function lookupKitsu(kitsuId) {
  const id = String(kitsuId).replace(/^kitsu:/, '');
  const url = `https://kitsu.app/api/edge/anime/${id}`;
  const data = await fetchJson(url, { timeout: 4000 });
  const a = data?.data?.attributes;
  if (!a) return null;
  const startDate = a.startDate || '';
  return {
    name: a.canonicalTitle || a.titles?.en || '',
    year: startDate ? startDate.slice(0, 4) : '',
    releaseInfo: startDate ? startDate.slice(0, 4) : '',
    type: 'anime',
  };
}

async function lookupJikan(malId) {
  const id = String(malId).replace(/^mal:/, '');
  const url = `https://api.jikan.moe/v4/anime/${id}`;
  const data = await fetchJson(url, { timeout: 4000 });
  const a = data?.data;
  if (!a) return null;
  const aired = a.aired?.from ? a.aired.from.slice(0, 4) : '';
  return {
    name: a.title_english || a.title || '',
    year: aired,
    releaseInfo: aired,
    type: 'anime',
  };
}

async function lookupTmdb(tmdbIdRaw, type) {
  const tmdbId = String(tmdbIdRaw).replace(/^tmdb:/, '');
  const kind = type === 'movie' ? 'movie' : 'tv';
  const url = `https://api.themoviedb.org/3/${kind}/${tmdbId}?api_key=${TMDB_API_KEY}`;
  const data = await fetchJson(url, { timeout: 4000 });
  if (!data) return null;
  return {
    name: data.title || data.name || '',
    year: (data.release_date || data.first_air_date || '').slice(0, 4),
    releaseInfo: data.release_date || data.first_air_date || '',
    type: type || kind,
  };
}

// ---------------------------------------------------------------------------
// Resolve TMDB ID from IMDb ID (some sources need TMDB for TV/Anime)
// ---------------------------------------------------------------------------
export async function resolveTmdbId(imdbId, type, title) {
  const kind = type === 'movie' ? 'movie' : 'tv';

  if (imdbId && !imdbId.startsWith('kitsu:') && !imdbId.startsWith('mal:') && !imdbId.startsWith('tmdb:')) {
    const url = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`;
    const data = await fetchJson(url, { timeout: 5000 });
    if (data) {
      const arr = data?.[`${kind}_results`] || [];
      if (arr[0]?.id) return String(arr[0].id);
    }
  }

  if (title) {
    const cleanTitle = title.replace(/\s+\d{4}$/, '').trim();
    const url = `https://api.themoviedb.org/3/search/${kind}?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(cleanTitle)}`;
    const data = await fetchJson(url, { timeout: 5000 });
    if (data?.results?.[0]?.id) return String(data.results[0].id);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Parse Stremio ID into components
// ---------------------------------------------------------------------------
export function parseStremioId(id) {
  if (!id) return { type: null, imdbId: null, kitsuId: null, season: null, episode: null };

  const raw = String(id).replace(/\.json$/, '');

  for (const p of ['kitsu', 'mal', 'tvdb', 'tmdb']) {
    if (raw.startsWith(p + ':')) {
      const parts = raw.slice(p.length + 1).split(':');
      return {
        type: null,
        imdbId: null,
        kitsuId: p === 'kitsu' ? parts[0] : null,
        malId: p === 'mal' ? parts[0] : null,
        tmdbId: p === 'tmdb' ? parts[0] : null,
        season: parts.length >= 3 && /^\d+$/.test(parts[1]) ? Number(parts[1]) : null,
        episode: parts.length >= 3 && /^\d+$/.test(parts[2]) ? Number(parts[2]) : null,
      };
    }
  }

  const parts = raw.split(':');
  return {
    type: null,
    imdbId: parts[0],
    kitsuId: null,
    malId: null,
    tmdbId: null,
    season: parts.length >= 3 && /^\d+$/.test(parts[1]) ? Number(parts[1]) : null,
    episode: parts.length >= 3 && /^\d+$/.test(parts[2]) ? Number(parts[2]) : null,
  };
}
