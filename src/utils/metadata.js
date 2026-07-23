// src/utils/metadata.js — Cinemeta + Kitsu resolver
import axios from 'axios';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const cache = new Map();

export async function resolveMeta(imdbId, type) {
  if (!imdbId) return null;
  const key = `${imdbId}:${type}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.ts < 1800000) return cached.data;

  let result = null;
  try {
    if (imdbId.startsWith('kitsu:')) {
      const id = imdbId.replace('kitsu:', '');
      const res = await axios.get(`https://kitsu.app/api/edge/anime/${id}`, { timeout: 4000, headers: { 'User-Agent': UA } });
      const a = res.data?.data?.attributes;
      if (a) result = { name: a.canonicalTitle || '', year: (a.startDate || '').slice(0, 4) };
    } else {
      const ct = type === 'movie' ? 'movie' : 'series';
      const res = await axios.get(`https://v3-cinemeta.strem.io/meta/${ct}/${imdbId}.json`, { timeout: 4000, headers: { 'User-Agent': UA } });
      const m = res.data?.meta;
      if (m) result = { name: m.name || '', year: m.year ? String(m.year).slice(0, 4) : '' };
    }
  } catch {}
  if (result) cache.set(key, { data: result, ts: Date.now() });
  return result;
}

export async function resolveTmdbId(imdbId, type, title) {
  const TMDB_KEY = '6b2dec73b6697866a50cdaef60ccffcb';
  const kind = type === 'movie' ? 'movie' : 'tv';
  try {
    if (imdbId && !imdbId.startsWith('kitsu:') && !imdbId.startsWith('tmdb:')) {
      const res = await axios.get(`https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_KEY}&external_source=imdb_id`, { timeout: 5000 });
      const arr = res.data?.[`${kind}_results`] || [];
      if (arr[0]?.id) return String(arr[0].id);
    }
    if (title) {
      const clean = title.replace(/\s+\d{4}$/, '').trim();
      const res = await axios.get(`https://api.themoviedb.org/3/search/${kind}?api_key=${TMDB_KEY}&query=${encodeURIComponent(clean)}`, { timeout: 5000 });
      if (res.data?.results?.[0]?.id) return String(res.data.results[0].id);
    }
  } catch {}
  return null;
}

export function parseStremioId(id) {
  if (!id) return { imdbId: null, kitsuId: null, season: null, episode: null };
  const raw = String(id).replace(/\.json$/, '');
  for (const p of ['kitsu', 'mal', 'tvdb', 'tmdb']) {
    if (raw.startsWith(p + ':')) {
      const parts = raw.slice(p.length + 1).split(':');
      return {
        imdbId: null,
        kitsuId: p === 'kitsu' ? parts[0] : null,
        season: parts.length >= 3 && /^\d+$/.test(parts[1]) ? Number(parts[1]) : null,
        episode: parts.length >= 3 && /^\d+$/.test(parts[2]) ? Number(parts[2]) : null,
      };
    }
  }
  const parts = raw.split(':');
  return {
    imdbId: parts[0],
    kitsuId: null,
    season: parts.length >= 3 && /^\d+$/.test(parts[1]) ? Number(parts[1]) : null,
    episode: parts.length >= 3 && /^\d+$/.test(parts[2]) ? Number(parts[2]) : null,
  };
}
