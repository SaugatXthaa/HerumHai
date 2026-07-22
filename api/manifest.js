// ============================================================================
// api/manifest.js — HerumHai Stremio Addon Manifest (Configurable)
// ----------------------------------------------------------------------------
// Accepts configuration via:
//   1. Base64 URL path: /{base64url_config}/manifest.json
//   2. Query string: /manifest.json?res_2160=true&required=BluRay,WEB-DL&...
//
// Query params from Configure-WebUI:
//   res_2160, res_1080, res_720, res_480, res_360, res_240, res_144
//   required, excluded (quality filters)
//   sources (comma-separated source names)
//   nameTemplate, descriptionTemplate (stream formatting)
//   subtitles (true/false)
// ============================================================================

const HERUMHAI_SOURCES = [
  { key: 'source_universal', slug: 'universal', name: 'Universal (xpass.top)', tags: ['Very Fast', '4K', '1080p', '720p', 'Multi-Audio', 'Movies', 'Series', 'Anime'] },
  { key: 'source_streamex', slug: 'streamex', name: 'StreameX', tags: ['Fast', '4K', '1080p', 'Movies', 'Series', 'Anime'] },
  { key: 'source_nebula', slug: 'nebula', name: 'NebulaStreams', tags: ['Fast', '4K', '1080p', 'Movies', 'Series'] },
  { key: 'source_4khdhub', slug: '4khdhub', name: '4KHDHub', tags: ['4K', 'Mainstream', 'Classics', 'Series', 'Anime', 'Indie'] },
  { key: 'source_4khdhub_one', slug: '4khdhub_one', name: '4KHDHub.one', tags: ['4K', '1080p', 'Movies', 'Series'] },
  { key: 'source_animesky', slug: 'animesky', name: 'AnimeSky (Multi-Audio)', tags: ['Anime', 'Multi-Audio', 'Hindi', 'Tamil', 'Telugu'] },
  { key: 'source_movieseq', slug: 'movieseq', name: 'MoviesEQ', tags: ['Fast', '1080p', 'Movies', 'Series'] },
  { key: 'source_cinewave', slug: 'cinewave', name: 'CineWave', tags: ['Fast', '1080p', 'Movies', 'Series'] },
  { key: 'source_tatvamovies', slug: 'tatvamovies', name: 'TatvaMovies', tags: ['Fast', '1080p', 'Movies', 'Series'] },
  { key: 'source_cinefreak', slug: 'cinefreak', name: 'CineFreak', tags: ['4K', '1080p', '720p', 'Regional', 'Classics', 'Indie'] },
  { key: 'source_moviebox', slug: 'moviebox', name: 'MovieBox', tags: ['Fast', '1080p', 'Regional', 'Classics', 'Anime', 'Indie'] },
  { key: 'source_mkvbase', slug: 'mkvbase', name: 'MKVBase', tags: ['Fast', '4K', '1080p', 'Regional', 'Mainstream', 'Series'] },
  { key: 'source_moviesdrives', slug: 'moviesdrives', name: 'MoviesDrives', tags: ['4K', '1080p', 'Mainstream', 'Indie', 'Movies Only'] },
  { key: 'source_vaplayer', slug: 'vaplayer', name: 'VAPlayer', tags: ['Very Fast', '1080p', 'Regional', 'Classics', 'Anime', 'Indie', 'Series'] },
  { key: 'source_videasy', slug: 'videasy', name: 'Videasy', tags: ['Fast', '4K', '1080p', 'Regional', 'Classics', 'Anime', 'Indie', 'Series'] },
  { key: 'source_aether', slug: 'aether', name: 'Aether', tags: ['4K', '1080p', '720p', 'Regional', 'Mainstream', 'Anime'] },
  { key: 'source_hdghartv', slug: 'hdghartv', name: 'HDGharTV', tags: ['Fast', '1080p', '720p', '480p', 'Regional', 'Mainstream', 'Series'] },
  { key: 'source_111477', slug: '111477', name: '111477 (OD)', tags: ['Very Fast', '4K', '1080p', 'Huge Library'] },
  { key: 'source_filmhds', slug: 'filmhds', name: 'FilmHDS', tags: ['1080p', 'Movies'] },
  { key: 'source_hdhub4u', slug: 'hdhub4u', name: 'HDHub4u', tags: ['4K', '1080p', 'Movies', 'Series'] },
  { key: 'source_uhdmovies', slug: 'uhdmovies', name: 'UHDMovies', tags: ['4K', '1080p', 'Movies'] },
  { key: 'source_moviescounter', slug: 'moviescounter', name: 'MoviesCounter', tags: ['1080p', 'Movies'] },
  { key: 'source_vidsrc', slug: 'vidsrc', name: 'VidSrc', tags: ['Fast', '1080p'] },
  { key: 'source_2embed', slug: '2embed', name: '2Embed', tags: ['1080p', 'Mainstream'] },
];

const QUALITIES = [
  { key: 'res_2160', label: '4K', hint: '2160p' },
  { key: 'res_1440', label: '2K', hint: '1440p' },
  { key: 'res_1080', label: '1080p', hint: 'Full HD' },
  { key: 'res_720', label: '720p', hint: 'HD' },
  { key: 'res_576', label: '576p', hint: 'PAL SD' },
  { key: 'res_480', label: '480p', hint: 'SD' },
  { key: 'res_360', label: '360p', hint: 'Low data' },
  { key: 'res_240', label: '240p', hint: 'Very low' },
  { key: 'res_144', label: '144p', hint: 'Minimum data' },
];

const DEFAULT_ENABLED_SOURCES = [
  'source_universal', 'source_streamex', 'source_nebula', 'source_4khdhub',
  'source_4khdhub_one', 'source_animesky', 'source_movieseq', 'source_cinewave',
  'source_tatvamovies', 'source_cinefreak', 'source_moviebox', 'source_hdghartv'
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(204).end();

  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['host'] || '';
  const baseUrl = host ? `${protocol}://${host}` : '';

  // Parse config from query string
  const query = req.query || {};
  const enabledSources = new Set(DEFAULT_ENABLED_SOURCES);

  // Check if 'sources' param is provided (from Configure-WebUI)
  if (query.sources) {
    enabledSources.clear();
    const requestedSources = query.sources.split(',').map(s => s.trim());
    for (const s of requestedSources) {
      // Map source name to key
      const source = HERUMHAI_SOURCES.find(src =>
        src.name.toLowerCase().includes(s.toLowerCase()) ||
        src.slug === s.toLowerCase()
      );
      if (source) enabledSources.add(source.key);
    }
  }

  // Also check individual source_ params (legacy support)
  for (const [k, v] of Object.entries(query)) {
    if (k.startsWith('source_')) {
      if (v === 'true' || v === '1') enabledSources.add(k);
      else enabledSources.delete(k);
    }
  }

  // --- Resolve formatter templates ---
  // Two ways to provide the formatter:
  //   1. config=<id>   — short hash ID, fetched from /api/config (preferred;
  //                      supports full 24KB formatter without URL truncation)
  //   2. nameTemplate=...&descriptionTemplate=... — direct URL params (legacy;
  //                      limited to ~8KB total before Vercel truncates)
  let nameTemplate = query.nameTemplate || '';
  let descriptionTemplate = query.descriptionTemplate || '';
  if (query.config) {
    try {
      const cfgRes = await fetch(`${baseUrl}/api/config?id=${encodeURIComponent(query.config)}`, {
        signal: AbortSignal.timeout(3000),
      });
      if (cfgRes.ok) {
        const cfg = await cfgRes.json();
        if (cfg.nameTemplate) nameTemplate = cfg.nameTemplate;
        if (cfg.descriptionTemplate) descriptionTemplate = cfg.descriptionTemplate;
      }
    } catch (e) {
      console.error('[manifest] failed to fetch config:', e.message);
    }
  }

  // Build config array
  const configArray = [
    // Source toggles
    ...HERUMHAI_SOURCES.map((s) => ({
      key: s.key,
      type: 'checkbox',
      title: s.name,
      default: enabledSources.has(s.key),
    })),
    // Quality/resolution filters
    ...QUALITIES.map((q) => ({
      key: q.key,
      type: 'checkbox',
      title: q.label,
      default: query[q.key] !== 'false' && query[q.key] !== '0',
    })),
    // Quality type filters (from Configure-WebUI)
    ...(query.required ? [{
      key: 'quality_required',
      type: 'text',
      title: 'Required Qualities',
      default: query.required,
    }] : []),
    ...(query.excluded ? [{
      key: 'quality_excluded',
      type: 'text',
      title: 'Excluded Qualities',
      default: query.excluded,
    }] : []),
    // Formatter — exposed as Stremio config fields so users can edit in Stremio UI
    ...(nameTemplate ? [{
      key: 'nameTemplate',
      type: 'text',
      title: 'Stream Name Template',
      default: nameTemplate,
    }] : []),
    ...(descriptionTemplate ? [{
      key: 'descriptionTemplate',
      type: 'text',
      title: 'Stream Description Template',
      default: descriptionTemplate,
    }] : []),
    // Subtitles
    {
      key: 'subtitles_disabled',
      type: 'checkbox',
      title: 'Disable subtitles',
      default: query.subtitles === 'false',
    },
    // Advanced
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
