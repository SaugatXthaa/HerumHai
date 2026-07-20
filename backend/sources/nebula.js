// ============================================================================
// sources/nebula.js — NebulaStreams Scraper (HubCloud ID extraction)
// ----------------------------------------------------------------------------
// Calls Nebula's /stream/ endpoint, extracts HubCloud IDs from the response,
// and resolves them via OUR HubCloud resolver (not proxying through Nebula).
//
// Nebula returns:
//   - hubcloud.ist/drive/{id} URLs → we resolve these ourselves
//   - GDrive direct URLs → we use directly
//   - HLS URLs → we use directly
//   - hdstream4u.com URLs → we use directly
//
// This is NOT proxying — we extract the raw stream data and resolve it independently.
// ============================================================================

import { resolveHubCloud, detectQuality, detectAudio, formatFileSize } from './hubcloud.js';

const NEBULA_BASE = 'https://nebula.work.gd/private/6d07e6972669462a5e27e2cd';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/**
 * Scrape NebulaStreams for a movie/series
 * @param {string} title     - Movie title (for display)
 * @param {string} imdbId    - IMDB ID (tt1375666)
 * @param {string} type      - 'movie' | 'series' | 'anime'
 * @param {number|null} season
 * @param {number|null} episode
 * @returns {Promise<Array>} Array of stream objects
 */
export async function scrapeNebula(title, imdbId, type = 'movie', season = null, episode = null) {
  if (!imdbId) {
    console.log(`  [nebula] no IMDB ID — cannot scrape`);
    return [];
  }

  // Build the Nebula stream URL
  let nebulaUrl;
  if (type === 'series' || type === 'anime') {
    nebulaUrl = `${NEBULA_BASE}/stream/series/${imdbId}:${season || 1}:${episode || 1}.json`;
  } else {
    nebulaUrl = `${NEBULA_BASE}/stream/movie/${imdbId}.json`;
  }

  console.log(`  [nebula] → ${nebulaUrl.slice(0, 80)}`);

  try {
    const res = await fetch(nebulaUrl, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      console.log(`  [nebula] HTTP ${res.status}`);
      return [];
    }
    const data = await res.json();
    const nebulaStreams = data.streams || [];
    console.log(`  [nebula] got ${nebulaStreams.length} raw streams`);

    const streams = [];

    for (const s of nebulaStreams) {
      const url = s.url || '';
      const name = s.name || 'NebulaStreams';

      // 1. HubCloud links → resolve via OUR resolver
      const hubcloudMatch = url.match(/hubcloud\.[a-z]+\/drive\/([A-Za-z0-9_-]+)/i);
      if (hubcloudMatch) {
        const hubcloudId = hubcloudMatch[1];
        console.log(`  [nebula] resolving HubCloud ID: ${hubcloudId}`);
        try {
          const resolved = await resolveHubCloud(hubcloudId);
          if (resolved && resolved.directUrl) {
            const quality = detectQuality(resolved.filename || resolved.directUrl);
            const audio = detectAudio(resolved.filename);
            streams.push({
              name: `HerumHai ${quality.rank >= 2160 ? '❄️' : '🎯'} ${quality.label} • NebulaStreams`,
              description: `🍿 ${title}\n💾 ${formatFileSize(resolved.fileSize)}\n🎧 Audio: ${audio.join(', ')}\n🛰️ Source: Nebula → HubCloud`,
              url: resolved.directUrl,
              behaviorHints: {
                notWebReady: true,
                filename: resolved.filename || '',
                videoSize: resolved.fileSize || 0,
                proxyHeaders: {
                  request: {
                    'User-Agent': USER_AGENT,
                    'Referer': resolved.referer || 'https://hubcloud.cx/',
                  },
                },
              },
              sourceSlug: 'nebula',
            });
            console.log(`  [nebula] ✓ resolved to: ${resolved.directUrl.slice(0, 60)}...`);
          }
        } catch (e) {
          console.log(`  [nebula] HubCloud resolve failed: ${e.message}`);
        }
        continue;
      }

      // 2. GDrive direct URLs → use directly
      if (url.includes('googleusercontent.com') || url.includes('drive.google.com')) {
        const quality = detectQuality(name);
        streams.push({
          name: `HerumHai 🎯 ${quality.label} • NebulaStreams · GDrive`,
          description: `🍿 ${title}\n💾 GDrive Direct\n🛰️ Source: Nebula`,
          url,
          behaviorHints: {
            notWebReady: true,
            proxyHeaders: {
              request: {
                'User-Agent': USER_AGENT,
              },
            },
          },
          sourceSlug: 'nebula',
        });
        continue;
      }

      // 3. HLS URLs → use directly
      if (url.includes('.m3u8')) {
        const quality = detectQuality(name);
        streams.push({
          name: `HerumHai 🎬 ${quality.label} • NebulaStreams · HLS`,
          description: `🍿 ${title}\n📡 HLS Stream\n🛰️ Source: Nebula`,
          url,
          behaviorHints: {
            notWebReady: false,
            proxyHeaders: {
              request: {
                'User-Agent': USER_AGENT,
              },
            },
          },
          sourceSlug: 'nebula',
        });
        continue;
      }

      // 4. hdstream4u.com and other direct links → use directly
      if (url.startsWith('http')) {
        const quality = detectQuality(name);
        streams.push({
          name: `HerumHai 🎯 ${quality.label} • NebulaStreams`,
          description: `🍿 ${title}\n💾 Direct Link\n🛰️ Source: Nebula`,
          url,
          behaviorHints: {
            notWebReady: true,
            proxyHeaders: {
              request: {
                'User-Agent': USER_AGENT,
              },
            },
          },
          sourceSlug: 'nebula',
        });
      }
    }

    console.log(`  [nebula] ✓ ${streams.length} streams (resolved independently)`);
    return streams;
  } catch (e) {
    console.log(`  [nebula] error: ${e.message}`);
    return [];
  }
}

export async function closeBrowser() {
  // No browser used — pure axios/fetch
}
