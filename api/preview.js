// ============================================================================
// api/preview.js — Formatter Preview Endpoint
// ----------------------------------------------------------------------------
// Takes name/description templates + a sample stream, evaluates them using
// the AIOStreams formatter engine, and returns the formatted result.
// Used by the configuration UI to show a live preview.
// ============================================================================

import { evaluateTemplate } from './formatter-engine.js';

// Sample stream data for preview (mimics a real 4K BluRay stream)
const SAMPLE_STREAM = {
  stream: {
    library: false,
    resolution: '2160p',
    quality: 'BluRay',
    type: 'debrid',
    nSeScore: 100,
    seadexBest: null,
    seadex: null,
    seeders: 0,
    audioTags: ['Atmos', 'TrueHD'],
    visualTags: ['DV'],
    filename: 'Oppenheimer.2023.2160p.BluRay.HEVC.DV.TrueHD.Atmos.7.1-group.mkv',
    encode: 'HEVC',
    audioChannels: ['7.1'],
    title: 'Oppenheimer',
    year: '2023',
    source: 'universal',
    seasonEpisode: null,
    episodes: null,
    seasons: null,
    seasonPack: null,
    folderName: null,
    subbed: null,
    dubbed: null,
    seScore: null,
    seMatched: null,
    duration: 9120,
    uLanguageEmojis: ['🇬🇧'],
    uSubtitleEmojis: null,
    dubbed: null,
    subbed: null,
    uLanguages: ['EN'],
    uSubtitles: null,
    uSmallLanguageCodes: ['EN'],
    uSmallSubtitleCodes: null,
    languages: ['EN'],
    subtitles: null,
    languageEmojis: ['🇬🇧'],
    subtitleEmojis: null,
    size: 67108864000,
    folderSize: 134217728000,
    bitrate: 54800000,
    message: null,
    age: '10d',
    releaseGroup: 'group',
    indexer: null,
    provider: 'UNIVERSAL',
    rankedRegexMatched: null,
    rseMatched: null,
    regexMatched: null,
    network: null,
    editions: null,
    edition: null,
    uncensored: null,
    repack: null,
    regraded: null,
    unrated: null,
    upscaled: null,
    private: null,
    freeleech: null,
    proxied: true,
  },
  service: {
    cached: true,
    shortName: 'Universal',
    id: 'universal',
  },
  metadata: {
    episodeRuntime: 152,
    runtime: 152,
  },
  addon: {
    name: 'HerumHai',
  },
  config: {
    addonName: 'HerumHai',
  },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch {
      return res.status(400).json({ error: 'Invalid JSON' });
    }
  }

  const nameTemplate = body.nameTemplate || '';
  const descTemplate = body.descriptionTemplate || '';

  let name = '';
  let description = '';

  try {
    name = evaluateTemplate(nameTemplate, SAMPLE_STREAM);
  } catch (e) {
    name = 'Error: ' + e.message;
  }

  try {
    description = evaluateTemplate(descTemplate, SAMPLE_STREAM);
  } catch (e) {
    description = 'Error: ' + e.message;
  }

  return res.status(200).json({ name, description });
}
