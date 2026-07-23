// =============================================================================
// src/sources/file-hosts.js — WordPress File-Hosting Sites (Pure HTTP)
// -----------------------------------------------------------------------------
// Scrapes WordPress movie sites that use HubCloud/HubDrive embed links.
// Pure HTTP — fetches HTML, extracts HubCloud IDs, resolves to CDN URLs.
//
// Sources (12):
//   1. 4khdhub.one    2. 4khdhub.fans    3. uhdmovies.casa   4. hdhub4u.tax
//   5. moviesmod.chat 6. moviesdrive.city 7. cinefreak.net    8. allmovieland.one
//   9. vegamovie.sn   10. worldfree4u.dog 11. moviescounter.boston 12. nima4k.org
// =============================================================================

import { fetchHtml, validateUrl } from '../utils/http.js';
import { buildValidatedStream, extractMetadata } from '../utils/stream-builder.js';

// ---------------------------------------------------------------------------
// Generic WordPress site scraper (HubCloud → sportverse.cc → CDN)
// ---------------------------------------------------------------------------
async function scrapeWordPressSite(sourceConfig, target, title) {
  const { id, name, baseUrl } = sourceConfig;
  if (!title) return [];

  const cleanTitle = title.replace(/\s+\d{4}$/, '').trim();
  const searchUrl = `${baseUrl}/?s=${encodeURIComponent(cleanTitle)}`;

  const searchHtml = await fetchHtml(searchUrl, { timeout: 8000 });
  if (!searchHtml) return [];

  // Find detail page links
  const detailLinks = new Set();
  const hostPattern = baseUrl.replace('https://', '').replace('http://', '');
  for (const m of searchHtml.matchAll(/href="(https?:\/\/[^"]*\/[a-z0-9-]+\/?)"/gi)) {
    const link = m[1];
    if (link.includes(hostPattern) &&
        !link.includes('/category/') && !link.includes('/page/') &&
        !link.includes('/tag/') && !link.includes('/feed') &&
        !link.endsWith('/about/') && !link.endsWith('/contact/') &&
        !link.endsWith('/dmca/')) {
      const slug = link.toLowerCase().replace(/-/g, ' ');
      const titleWords = cleanTitle.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
      if (titleWords.some((w) => slug.includes(w))) {
        detailLinks.add(link);
      }
    }
  }

  if (detailLinks.size === 0) return [];

  // Fetch detail pages and extract HubCloud IDs
  const hubcloudIds = new Set();
  for (const link of Array.from(detailLinks).slice(0, 2)) {
    const detailHtml = await fetchHtml(link, { timeout: 8000 });
    if (!detailHtml) continue;
    for (const m of detailHtml.matchAll(/hubcloud\.(?:ist|cx|club|fans)\/drive\/([a-zA-Z0-9_-]+)/gi)) {
      hubcloudIds.add(m[1]);
    }
  }

  if (hubcloudIds.size === 0) return [];

  // Resolve HubCloud IDs → sportverse.cc → workers.dev CDN URLs
  const streams = [];
  const hcIds = Array.from(hubcloudIds).slice(0, 4);

  const resolved = await Promise.all(
    hcIds.map(async (hcId) => {
      try {
        // Get sportverse.cc resolver URL from hubcloud.cx page
        let sportverseUrl = null;
        for (const d of ['hubcloud.cx', 'hubcloud.ist', 'hubcloud.club', 'hubcloud.fans']) {
          const hcHtml = await fetchHtml(`https://${d}/drive/${hcId}`, { timeout: 6000 });
          if (!hcHtml) continue;
          const m = hcHtml.match(/var url = '([^']+)'/);
          if (m && m[1]) { sportverseUrl = m[1]; break; }
        }
        if (!sportverseUrl) return null;

        // Fetch sportverse.cc page → extract workers.dev CDN URL
        const svHtml = await fetchHtml(sportverseUrl, { timeout: 8000 });
        if (!svHtml) return null;

        // workers.dev URLs can have spaces in filenames
        const cdnMatches = svHtml.match(/https?:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.workers\.dev\/[^"'<>\s]+(?:\s[^"'<>]+)*/gi);
        if (!cdnMatches || cdnMatches.length === 0) return null;

        const cdnUrl = cdnMatches[0]
          .replace(/ /g, '%20').replace(/\[/g, '%5B').replace(/\]/g, '%5D')
          .replace(/\(/g, '%28').replace(/\)/g, '%29');

        let fileName = '';
        try { fileName = decodeURIComponent(new URL(cdnUrl).pathname.split('/').pop() || ''); } catch {}

        const meta = extractMetadata(`${fileName} ${title}`);
        return await buildValidatedStream({
          name: `HerumHai · ${name}${meta.resolution ? ` · ${meta.resolution}` : ''}${meta.quality ? ` · ${meta.quality}` : ''}${meta.codec ? ` · ${meta.codec}` : ''}`,
          description: `Source: ${name}\nFile: ${fileName}\nTitle: ${title}`,
          url: cdnUrl,
          filename: fileName || `${title}.mkv`,
          sizeBytes: meta.sizeBytes,
          referer: 'https://hubcloud.cx/',
          bingeGroup: `herumhai-${id}-${hcId}`,
          source: id,
        });
      } catch { return null; }
    })
  );

  for (const s of resolved) {
    if (s) streams.push(s);
  }

  return streams;
}

// ---------------------------------------------------------------------------
// Export all 12 WordPress sources
// ---------------------------------------------------------------------------
export const hub4khdhub_one = {
  id: '4khdhub_one', name: '4KHDHub', types: 'all',
  scrape: (t, title) => scrapeWordPressSite({ id: '4khdhub_one', name: '4KHDHub', baseUrl: 'https://4khdhub.one' }, t, title),
};

export const hub4khdhub_fans = {
  id: '4khdhub_fans', name: '4KHDHub.fans', types: 'all',
  scrape: (t, title) => scrapeWordPressSite({ id: '4khdhub_fans', name: '4KHDHub.fans', baseUrl: 'https://4khdhub.fans' }, t, title),
};

export const uhdmovies = {
  id: 'uhdmovies', name: 'UHDMovies', types: 'all',
  scrape: (t, title) => scrapeWordPressSite({ id: 'uhdmovies', name: 'UHDMovies', baseUrl: 'https://uhdmovies.casa' }, t, title),
};

export const hdhub4u = {
  id: 'hdhub4u', name: 'HDHub4u', types: 'all',
  scrape: (t, title) => scrapeWordPressSite({ id: 'hdhub4u', name: 'HDHub4u', baseUrl: 'https://hdhub4u.tax' }, t, title),
};

export const moviesmod = {
  id: 'moviesmod', name: 'MoviesMod', types: 'all',
  scrape: (t, title) => scrapeWordPressSite({ id: 'moviesmod', name: 'MoviesMod', baseUrl: 'https://moviesmod.chat' }, t, title),
};

export const moviesdrive = {
  id: 'moviesdrive', name: 'MoviesDrive', types: 'all',
  scrape: (t, title) => scrapeWordPressSite({ id: 'moviesdrive', name: 'MoviesDrive', baseUrl: 'https://moviesdrive.city' }, t, title),
};

export const cinefreak = {
  id: 'cinefreak', name: 'CineFreak', types: 'all',
  scrape: (t, title) => scrapeWordPressSite({ id: 'cinefreak', name: 'CineFreak', baseUrl: 'https://cinefreak.net' }, t, title),
};

export const allmovieland = {
  id: 'allmovieland', name: 'AllMovieLand', types: 'all',
  scrape: (t, title) => scrapeWordPressSite({ id: 'allmovieland', name: 'AllMovieLand', baseUrl: 'https://allmovieland.one' }, t, title),
};

export const vegamovie = {
  id: 'vegamovie', name: 'VegaMovie', types: 'all',
  scrape: (t, title) => scrapeWordPressSite({ id: 'vegamovie', name: 'VegaMovie', baseUrl: 'https://vegamovie.sn' }, t, title),
};

export const worldfree4u = {
  id: 'worldfree4u', name: 'WorldFree4u', types: 'all',
  scrape: (t, title) => scrapeWordPressSite({ id: 'worldfree4u', name: 'WorldFree4u', baseUrl: 'https://worldfree4u.dog' }, t, title),
};

export const moviescounter = {
  id: 'moviescounter', name: 'MoviesCounter', types: 'all',
  scrape: (t, title) => scrapeWordPressSite({ id: 'moviescounter', name: 'MoviesCounter', baseUrl: 'https://moviescounter.boston' }, t, title),
};

export const nima4k = {
  id: 'nima4k', name: 'Nima4K', types: 'all',
  scrape: (t, title) => scrapeWordPressSite({ id: 'nima4k', name: 'Nima4K', baseUrl: 'https://nima4k.org' }, t, title),
};

export default {
  hub4khdhub_one, hub4khdhub_fans, uhdmovies, hdhub4u, moviesmod, moviesdrive,
  cinefreak, allmovieland, vegamovie, worldfree4u, moviescounter, nima4k
};
