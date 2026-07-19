// ============================================================================
// api/manifest.js — HerumHai Stremio / Nuvio Addon Manifest (Configurable)
// ----------------------------------------------------------------------------
// Configurable manifest pattern:
//   GET /manifest.json                         → default config
//   GET /{base64url_config}/manifest.json      → custom config (encoded JSON)
//
// Config schema:
// {
//   "source_4khdhub": true,
//   "source_cinefreak": false,
//   "res_2160": true,
//   "res_1080": true,
//   "audio_hindi": true,
//   "audio_english": true,
//   ...
// }
//
// INDEPENDENT: HerumHai does NOT depend on PenguPlay or HdHub proxies.
// All sources are scraped directly by our own backend.
// ============================================================================

// Our own source list — these are all scraped by our backend (not PenguPlay)
const HERUMHAI_SOURCES = [
  { key: 'source_universal', slug: 'universal', name: 'Universal (xpass.top)', tags: ['Very Fast', '4K', '1080p', '720p', 'Multi-Audio', 'Movies', 'Series', 'Anime'] },
  { key: 'source_streamex', slug: 'streamex', name: 'StreameX', tags: ['Fast', '4K', '1080p', 'Movies', 'Series', 'Anime'] },
  { key: 'source_4khdhub', slug: '4khdhub', name: '4KHDHub', tags: ['4K', 'Mainstream', 'Classics', 'Series', 'Anime', 'Indie'] },
  { key: 'source_4khdhub_one', slug: '4khdhub_one', name: '4KHDHub.one', tags: ['4K', '1080p', 'Movies', 'Series'] },
  { key: 'source_animesky', slug: 'animesky', name: 'AnimeSky (Multi-Audio)', tags: ['Anime', 'Multi-Audio', 'Hindi', 'Tamil', 'Telugu'] },
  { key: 'source_aniwaves', slug: 'aniwaves', name: 'Aniwaves', tags: ['Anime', 'Fast'] },
  { key: 'source_animesuge', slug: 'animesuge', name: 'AnimeSuge', tags: ['Anime', 'Fast'] },
  { key: 'source_cinefreak', slug: 'cinefreak', name: 'CineFreak', tags: ['4K', '1080p', '720p', 'Regional', 'Classics', 'Indie'] },
  { key: 'source_moviebox', slug: 'moviebox', name: 'MovieBox', tags: ['Fast', '1080p', 'Regional', 'Classics', 'Anime', 'Indie'] },
  { key: 'source_mkvbase', slug: 'mkvbase', name: 'MKVBase', tags: ['Fast', '4K', '1080p', 'Regional', 'Mainstream', 'Series'] },
  { key: 'source_moviesdrives', slug: 'moviesdrives', name: 'MoviesDrives', tags: ['4K', '1080p', 'Mainstream', 'Indie', 'Movies Only'] },
  { key: 'source_vaplayer', slug: 'vaplayer', name: 'VAPlayer', tags: ['Very Fast', '1080p', 'Regional', 'Classics', 'Anime', 'Indie', 'Series'] },
  { key: 'source_videasy', slug: 'videasy', name: 'Videasy', tags: ['Fast', '4K', '1080p', 'Regional', 'Classics', 'Anime', 'Indie', 'Series'] },
  { key: 'source_zxcstream', slug: 'zxcstream', name: 'ZXCStream', tags: ['Fast', '4K', '1080p', 'Multi-Audio', 'Subtitles', 'Mainstream', 'Series'] },
  { key: 'source_aether', slug: 'aether', name: 'Aether', tags: ['4K', '1080p', '720p', 'Regional', 'Mainstream', 'Anime'] },
  { key: 'source_vidlink', slug: 'vidlink', name: 'VidLink', tags: ['1080p', 'Classics', 'Mainstream', 'Classic TV', 'Very Fast'] },
  { key: 'source_vidfast', slug: 'vidfast', name: 'VidFast', tags: ['HLS', '4K', '1080p', 'Mainstream', 'Series'] },
  { key: 'source_hdghartv', slug: 'hdghartv', name: 'HDGharTV', tags: ['Fast', '1080p', '720p', '480p', 'Regional', 'Mainstream', 'Series'] },
  { key: 'source_111477', slug: '111477', name: '111477 (OD)', tags: ['Very Fast', '4K', '1080p', 'Huge Library'] },
  { key: 'source_filmhds', slug: 'filmhds', name: 'FilmHDS', tags: ['1080p', 'Movies'] },
  { key: 'source_hdhub4u', slug: 'hdhub4u', name: 'HDHub4u', tags: ['4K', '1080p', 'Movies', 'Series'] },
  { key: 'source_uhdmovies', slug: 'uhdmovies', name: 'UHDMovies', tags: ['4K', '1080p', 'Movies'] },
  { key: 'source_vaplayer', slug: 'vaplayer', name: 'VAPlayer', tags: ['Fast', '1080p', '720p', 'Multi-Audio'] },
  { key: 'source_movieseq', slug: 'movieseq', name: 'MoviesEQ', tags: ['Fast', '1080p', 'Movies', 'Series'] },
  { key: 'source_cinewave', slug: 'cinewave', name: 'CineWave', tags: ['Fast', '1080p', 'Movies', 'Series'] },
  { key: 'source_tatvamovies', slug: 'tatvamovies', name: 'TatvaMovies', tags: ['Fast', '1080p', 'Movies', 'Series'] },
];

// Embed sources (always available as fallback, not user-toggleable in v1)
const EMBED_SOURCES = [
  { key: 'source_vidsrc', slug: 'vidsrc', name: 'VidSrc', tags: ['Fast', '1080p'] },
  { key: 'source_2embed', slug: '2embed', name: '2Embed', tags: ['1080p', 'Mainstream'] },
];

const ALL_SOURCES = [...HERUMHAI_SOURCES, ...EMBED_SOURCES];

const QUALITIES = [
  { key: 'res_2160', label: '4K', hint: '2160p' },
  { key: 'res_1080', label: '1080p', hint: 'Full HD' },
  { key: 'res_720', label: '720p', hint: 'HD' },
  { key: 'res_480', label: '480p', hint: 'SD' },
  { key: 'res_360', label: '360p', hint: 'Low data' },
];

const AUDIO_LANGS = [
  'English', 'Hindi', 'Tamil', 'Telugu', 'Kannada', 'Malayalam', 'Bengali',
  'Punjabi', 'Marathi', 'Korean', 'Japanese', 'Chinese', 'Spanish', 'French',
  'German', 'Italian', 'Portuguese', 'Russian', 'Arabic', 'Thai',
  'Vietnamese', 'Malay', 'Indonesian',
];

export default function handler(req, res) {
  // CORS — open to all Stremio / Nuvio clients
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  // Build absolute URL for the logo (dynamic — works on any deployment)
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['host'] || '';
  const baseUrl = host ? `${protocol}://${host}` : '';

  // Parse optional config from path: /{base64url_config}/manifest.json
  // or from query string: ?source_4khdhub=false&res_720=false
  let config = {};
  const urlPath = (req.url || '').split('?')[0];

  // Match /{token}/manifest.json or /{token}/manifest
  const configMatch = urlPath.match(/^\/(?:api\/)?([A-Za-z0-9_-]{20,})\/manifest(?:\.json)?$/);
  if (configMatch) {
    try {
      const padded = configMatch[1] + '='.repeat((4 - (configMatch[1].length % 4)) % 4);
      config = JSON.parse(Buffer.from(padded, 'base64url').toString('utf-8'));
    } catch {
      // Invalid config — fall through to defaults
    }
  }

  // Also accept query string overrides
  for (const [k, v] of Object.entries(req.query || {})) {
    if (k.startsWith('source_') || k.startsWith('res_') || k.startsWith('audio_')) {
      config[k] = v !== 'false' && v !== '0' && v !== 'unchecked';
    }
  }

  // Build the config array for Stremio's configure UI (PenguPlay-style)
  const configArray = [
    // Source toggles
    ...ALL_SOURCES.map((s) => ({
      key: s.key,
      type: 'checkbox',
      title: s.name,
      // Default-enable our best sources (independent — no PenguPlay dependency)
      default: ['source_universal', 'source_streamex', 'source_4khdhub', 'source_4khdhub_one', 'source_animesky', 'source_moviebox', 'source_moviesdrives', 'source_vaplayer', 'source_hdghartv', 'source_aniwaves', 'source_animesuge'].includes(s.key),
    })),
    // Quality filters
    ...QUALITIES.map((q) => ({
      key: q.key,
      type: 'checkbox',
      title: q.label,
      default: true,
    })),
    // Audio language filters
    ...AUDIO_LANGS.map((lang) => ({
      key: `audio_${lang.toLowerCase()}`,
      type: 'checkbox',
      title: `Audio: ${lang}`,
      default: ['English', 'Hindi', 'Tamil', 'Telugu'].includes(lang),
    })),
    // Advanced options
    {
      key: 'subtitles_disabled',
      type: 'checkbox',
      title: 'Disable subtitles',
      default: false,
    },
    {
      key: 'emulate_vpn',
      type: 'checkbox',
      title: 'Emulate VPN (spoof client IP)',
      default: false,
    },
    {
      key: 'disable_direct',
      type: 'checkbox',
      title: 'Hide non-seekable streams',
      default: false,
    },
  ];

  const MANIFEST = {
    id: 'com.herumhai.premium.streams',
    version: '1.0.0',
    name: 'HerumHai',
    description: 'Stream movies and series in Stremio with configurable provider and quality filters.',
    resources: ['stream'],
    types: ['movie', 'series', 'anime'],
    idPrefixes: ['tt', 'kitsu', 'tmdb:'],
    catalogs: [],
    logo: `${baseUrl}/logo.png`,
    config: configArray,
    behaviorHints: {
      configurable: true,
    },
  };

  return res.status(200).json(MANIFEST);
}
