// =============================================================================
// src/sources/index.js — Source Registry (38+ Pure HTTP Sources)
// -----------------------------------------------------------------------------
// Central registry of all scraping sources. Each source exports:
//   - id:     unique identifier
//   - name:   display name
//   - types:  'all' | 'movie' | 'series' | 'anime' | ['movie', 'series']
//   - scrape: async (target, title) → streams[]
//
// All sources use PURE HTTP (axios + randomized browser headers).
// No Puppeteer, no FlareSolverr — runs on 512MB RAM with p-limit(20).
// =============================================================================

// Direct API sources (5)
import directApis from './direct-apis.js';
const { xpass, databasegda, mflix, gomo, vidsrcwin } = directApis;

// Embed API sources (18)
import embedApis from './embed-apis.js';
const {
  vidsrc_to, vidsrcxyz, vidsrc_me, vidsrc_cc, vidsrc_net, vidsrc_vip, vidsrc_pro,
  vidsrc_stream, embed2_cc, embed2_to, embed2_pro, embed2_rs, vidlink, vidfast,
  embedsu, multiembed, autoembed, smashystream
} = embedApis;

// File-hosting WordPress sites (12)
import fileHosts from './file-hosts.js';
const {
  hub4khdhub_one, hub4khdhub_fans, uhdmovies, hdhub4u, moviesmod, moviesdrive,
  cinefreak, allmovieland, vegamovie, worldfree4u, moviescounter, nima4k
} = fileHosts;

// ---------------------------------------------------------------------------
// Complete source registry — 35 sources (38+ with mirrors)
// ---------------------------------------------------------------------------
export const SOURCES = [
  // Direct API sources (fastest — return JSON directly)
  xpass,                    // 1. xpass.top HLS
  databasegda,              // 2. databasegda.com API
  mflix,                    // 3. mflix.com.de API
  gomo,                     // 4. gomo.to embed
  vidsrcwin,                // 5. vidsrc.win embed

  // Embed API sources (pure HTTP, return m3u8/mp4 in HTML)
  vidsrc_to,                // 6. vidsrc.to
  vidsrcxyz,                // 7. vidsrc.xyz (JSON API)
  vidsrc_me,                // 8. vidsrc.me
  vidsrc_cc,                // 9. vidsrc.cc
  vidsrc_net,               // 10. vidsrc.net
  vidsrc_vip,               // 11. vidsrc.vip
  vidsrc_pro,               // 12. vidsrc.pro
  vidsrc_stream,            // 13. vidsrc.stream
  embed2_cc,                // 14. 2embed.cc
  embed2_to,                // 15. 2embed.to
  embed2_pro,               // 16. 2embed.pro
  embed2_rs,                // 17. 2embed.rs
  vidlink,                  // 18. vidlink.pro
  vidfast,                  // 19. vidfast.pro
  embedsu,                  // 20. embed.su
  multiembed,               // 21. multiembed.mov
  autoembed,                // 22. autoembed.cc
  smashystream,             // 23. smashystream

  // File-hosting WordPress sites (HubCloud → CDN)
  hub4khdhub_one,           // 24. 4khdhub.one
  hub4khdhub_fans,          // 25. 4khdhub.fans (mirror)
  uhdmovies,                // 26. uhdmovies.casa
  hdhub4u,                  // 27. hdhub4u.tax
  moviesmod,                // 28. moviesmod.chat
  moviesdrive,              // 29. moviesdrive.city
  cinefreak,                // 30. cinefreak.net
  allmovieland,             // 31. allmovieland.one
  vegamovie,                // 32. vegamovie.sn
  worldfree4u,              // 33. worldfree4u.dog
  moviescounter,            // 34. moviescounter.boston
  nima4k,                   // 35. nima4k.org
];

// Total: 35 sources (38+ effective with mirrors + alternative endpoints)

export default SOURCES;
