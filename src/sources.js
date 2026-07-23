// src/sources.js — All stream sources (HdHub proxy + 111477 CDN + 100+ web scrapers)
import axios from 'axios';
import { fetchHtml } from './utils/http.js';
import cdn111477 from './sources/cdn111477.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// === PRIMARY: HdHub proxy (always works, 25+ direct streams) ===
export async function fetchHdHubStreams(type, id) {
  try {
    const res = await axios.get(`https://hdhub.thevolecitor.qzz.io/stream/${type}/${id}.json`, {
      timeout: 10000, headers: { 'User-Agent': UA, Accept: 'application/json' }, validateStatus: () => true,
    });
    if (res.status !== 200 || !res.data?.streams) return [];
    const direct = res.data.streams.filter(s => s.url && !s.infoHash && !s.url.includes('/login') && s.url.startsWith('http') && !(s.name||'').toLowerCase().includes('donation'));
    console.log(`[hdhub] ${direct.length} streams`);
    return direct.map(s => ({ ...s, source: 'hdhub' }));
  } catch (e) { console.log(`[hdhub] ${e.message}`); return []; }
}

// === PRIMARY: 111477 CDN directory listing ===
export async function fetchCdn111477Streams(target, title) {
  return cdn111477.scrape(target, title);
}

// === SECONDARY: Generic HTML scraper ===
function extractStreams(html) {
  if (!html) return [];
  const urls = new Set();
  for (const m of html.matchAll(/(https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*)/gi)) urls.add(m[1]);
  for (const m of html.matchAll(/(https?:\/\/[^"'\s<>]+\.mp4[^"'\s<>]*)/gi)) urls.add(m[1]);
  for (const m of html.matchAll(/"file"\s*:\s*"(https?:\/\/[^"]+)"/gi)) { if (m[1].includes('.m3u8')||m[1].includes('.mp4')) urls.add(m[1]); }
  return [...urls];
}

function makeScraper(id, name, baseUrl, searchPath) {
  return async function(target, title) {
    try {
      const clean = (title||'').replace(/\s+\d{4}$/, '').trim();
      if (!clean) return [];
      const url = `${baseUrl}${searchPath}${encodeURIComponent(clean)}`;
      const html = await fetchHtml(url, { headers: { Referer: baseUrl } });
      if (!html) return [];
      return extractStreams(html).slice(0,3).map(u => ({
        name: `HerumHai · ${name}`, title: `HerumHai · ${name}`,
        description: `Source: ${name}\nTitle: ${title}`, url: u, source: id,
        behaviorHints: { notWebReady: true, proxyHeaders: { request: { 'User-Agent': UA, Referer: baseUrl } } },
      }));
    } catch { return []; }
  };
}

// All secondary sources
const configs = [
  // Base64-decoded CDN sources
  { id: 'acermovies', name: 'AcerMovies', baseUrl: 'https://acermovies.fun', searchPath: '/search/' },
  { id: 'scloudx', name: 'SCloudX', baseUrl: 'https://scloudx.lol', searchPath: '/search/' },
  { id: 'dramasuki', name: 'DramaSuki', baseUrl: 'https://dramasuki.xyz', searchPath: '/search/' },
  // Direct download sites
  { id: 'vegamovies', name: 'VegaMovies', baseUrl: 'https://vegamovies.navy', searchPath: '/?s=' },
  { id: 'pahe', name: 'Pahe', baseUrl: 'https://pahe.ink', searchPath: '/?s=' },
  { id: 'ddlbase', name: 'DDLBase', baseUrl: 'https://ddlbase.com', searchPath: '/?s=' },
  { id: 'mkvbase', name: 'MKVBase', baseUrl: 'https://mkvbase.site', searchPath: '/?s=' },
  { id: 'xdmovies', name: 'XDMovies', baseUrl: 'https://top.xdmovies.wtf', searchPath: '/?s=' },
  { id: 'showbox', name: 'ShowBox', baseUrl: 'https://www.showbox.media', searchPath: '/?s=' },
  { id: 'psa', name: 'PSA', baseUrl: 'https://psa.wf', searchPath: '/?s=' },
  { id: 'cinebyat', name: 'Cineby.at', baseUrl: 'https://www.cineby.at', searchPath: '/?s=' },
  { id: 'uhdmovies', name: 'UHDMovies', baseUrl: 'https://uhdmovies.casa', searchPath: '/?s=' },
  { id: '4khdhub', name: '4KHDHub', baseUrl: 'https://4khdhub.one', searchPath: '/?s=' },
  { id: 'anime2enjoy', name: 'Anime2Enjoy', baseUrl: 'https://www.anime2enjoy.com', searchPath: '/?s=' },
  { id: 'ondemandchina', name: 'OnDemandChina', baseUrl: 'https://www.ondemandchina.com', searchPath: '/zh-Hans/search?type=video&keyword=' },
  { id: 'aether', name: 'Aether', baseUrl: 'https://aether.cx', searchPath: '/?s=' },
  { id: 'afterstream', name: 'AfterStream', baseUrl: 'https://afterstream.org', searchPath: '/?s=' },
  { id: '1shows', name: '1Shows', baseUrl: 'https://www.1shows.org', searchPath: '/?s=' },
  { id: 'cinestream', name: 'CineStream', baseUrl: 'https://cinestream.kje.us', searchPath: '/?s=' },
  { id: '1flex', name: '1Flex', baseUrl: 'https://www.1flex.org', searchPath: '/?s=' },
  { id: 'hydrahd1', name: 'HydraHD.com', baseUrl: 'https://hydrahd.com', searchPath: '/?s=' },
  { id: 'hydrahd2', name: 'HydraHD.ru', baseUrl: 'https://hydrahd.ru', searchPath: '/?s=' },
  { id: 'anixx', name: 'Anixx', baseUrl: 'https://anixx.fun', searchPath: '/?s=' },
  { id: 'anixtv', name: 'AnixTV', baseUrl: 'https://anixtv.in', searchPath: '/?s=' },
  { id: 'rarefilmm', name: 'RareFilmm', baseUrl: 'https://rarefilmm.com', searchPath: '/?s=' },
  { id: 'jpfilms', name: 'JPFilms', baseUrl: 'https://jp-films.com', searchPath: '/?s=' },
  { id: 'animepahe', name: 'AnimePahe', baseUrl: 'https://animepahe.pw', searchPath: '/?s=' },
  { id: 'animaxanime', name: 'AnimaxAnime', baseUrl: 'https://animaxanime.dpdns.org', searchPath: '/?s=' },
  // Asian drama
  { id: 'kisskh', name: 'KissKh', baseUrl: 'https://kisskh.id', searchPath: '/api/anime/list?q=' },
  { id: 'goplay', name: 'GoPlay', baseUrl: 'https://goplay.su', searchPath: '/search?q=' },
  { id: 'dramacool', name: 'Dramacool', baseUrl: 'https://dramacool.com.tr', searchPath: '/search?query=' },
  { id: 'myasiantv', name: 'MyAsianTV', baseUrl: 'https://myasiantv.com.bz', searchPath: '/search/' },
  { id: 'kissasian', name: 'KissAsian', baseUrl: 'https://wwv19.kissasian.com.lv', searchPath: '/Search?type=Movies&key=' },
  { id: 'asianctv', name: 'AsianCTV', baseUrl: 'https://asianctv.cc', searchPath: '/?s=' },
  { id: 'asiaflix', name: 'AsiaFlix', baseUrl: 'https://asiaflix.net', searchPath: '/search?q=' },
  // Movies & series (previous list)
  { id: 'soap2night', name: 'Soap2Night', baseUrl: 'https://soap2night.cc', searchPath: '/search/' },
  { id: 'ramoflix', name: 'Ramoflix', baseUrl: 'https://ramoflix.net', searchPath: '/search/' },
  { id: 'wmovies', name: 'WMovies', baseUrl: 'https://wmovies.org', searchPath: '/?s=' },
  { id: 'doraby', name: 'Doraby', baseUrl: 'https://doraby.com', searchPath: '/search/' },
  { id: 'cineby', name: 'Cineby', baseUrl: 'https://cineby.sc', searchPath: '/search/' },
  { id: 'flickystream', name: 'FlickyStream', baseUrl: 'https://flickystream.ru', searchPath: '/search/' },
  { id: 'cinema-bz', name: 'Cinema.bz', baseUrl: 'https://cinema.bz', searchPath: '/search/' },
  { id: 'flixer', name: 'Flixer', baseUrl: 'https://flixer.su', searchPath: '/search/' },
  { id: 'goojara', name: 'Goojara', baseUrl: 'https://goojara.to', searchPath: '/search/' },
  { id: 'streamvaults', name: 'StreamVaults', baseUrl: 'https://streamvaults.ru', searchPath: '/search/' },
  { id: '67movies', name: '67Movies', baseUrl: 'https://67movies.net', searchPath: '/search/' },
  { id: 'shuttletv', name: 'ShuttleTV', baseUrl: 'https://shuttletv.su', searchPath: '/search/' },
  { id: 'popcornmovies', name: 'PopcornMovies', baseUrl: 'https://popcornmovies.org', searchPath: '/search/' },
  { id: 'rivestream', name: 'RiveStream', baseUrl: 'https://rivestream.app', searchPath: '/search/' },
  { id: 'theflixertv', name: 'TheFlixerTV', baseUrl: 'https://theflixertv.click', searchPath: '/search/' },
  { id: 'onionplay', name: 'OnionPlay', baseUrl: 'https://onionplay.io', searchPath: '/search/' },
  { id: 'lookmovie2', name: 'LookMovie2', baseUrl: 'https://lookmovie2.to', searchPath: '/search/' },
  { id: 'pressplayz', name: 'PressPlayz', baseUrl: 'https://pressplayz.to', searchPath: '/search/' },
  { id: 'nepu', name: 'Nepu', baseUrl: 'https://nepu.to', searchPath: '/search/' },
  { id: 'fmovies', name: 'FMovies', baseUrl: 'https://fmovies.co', searchPath: '/search/' },
  { id: 'soap2dayhd', name: 'Soap2DayHD', baseUrl: 'https://soap2dayhd.net', searchPath: '/search/' },
  { id: 'projectfreetv', name: 'ProjectFreeTV', baseUrl: 'https://projectfreetv.sx', searchPath: '/search/' },
  { id: 'mappl', name: 'Mappl', baseUrl: 'https://mappl.tv', searchPath: '/search/' },
  { id: 'streamex', name: 'StreamEx', baseUrl: 'https://streamex.sh', searchPath: '/search/' },
  { id: 'opstream', name: 'OpStream', baseUrl: 'https://opstream.fun', searchPath: '/search/' },
  { id: 'movish', name: 'Movish', baseUrl: 'https://movish.to', searchPath: '/search/' },
  { id: 'themoviebox', name: 'TheMovieBox', baseUrl: 'https://themoviebox.org', searchPath: '/search/' },
  { id: 'hdtoday', name: 'HDToday', baseUrl: 'https://hdtoday.tr', searchPath: '/search/' },
  { id: 'cinebytv', name: 'CinebyTV', baseUrl: 'https://cinebytv.com', searchPath: '/search/' },
  { id: 'ridomovies', name: 'RidoMovies', baseUrl: 'https://ridomovies.su', searchPath: '/search/' },
  { id: '123moviesfree', name: '123MoviesFree', baseUrl: 'https://123moviesfree.net', searchPath: '/search/' },
  { id: 'vidplay', name: 'VidPlay', baseUrl: 'https://vidplay.top', searchPath: '/search/' },
  { id: 'cinemaos', name: 'CinemaOS', baseUrl: 'https://cinemaos.live', searchPath: '/search/' },
  { id: 'yesmovies', name: 'YesMovies', baseUrl: 'https://yesmovies.ag', searchPath: '/search/' },
  { id: 'primewire', name: 'PrimeWire', baseUrl: 'https://primewire.mov', searchPath: '/search/' },
  { id: 'm4uhd', name: 'M4UHD', baseUrl: 'https://m4uhd.page', searchPath: '/search/' },
  // New sources
  { id: 'net77', name: 'Net77', baseUrl: 'https://net77.cc', searchPath: '/search/' },
  { id: 'fluxtv', name: 'FluxTV', baseUrl: 'https://fluxtv.cc', searchPath: '/search/' },
  { id: 'ernax', name: 'Ernax', baseUrl: 'https://ernax.pro', searchPath: '/search/' },
  { id: 'boredflix', name: 'Boredflix', baseUrl: 'https://boredflix.tv', searchPath: '/search/' },
  { id: 'hdmovix', name: 'HDMovix', baseUrl: 'https://hdmovix.cc', searchPath: '/search/' },
  { id: 'streamiw', name: 'Streamiw', baseUrl: 'https://streamiw.xyz', searchPath: '/search/' },
  { id: 'fmoviesgd', name: 'FMovies.gd', baseUrl: 'https://fmovies.gd', searchPath: '/search/' },
  { id: 'flixstream', name: 'FlixStream', baseUrl: 'https://flixstream.ca', searchPath: '/search/' },
  { id: 'dulo', name: 'Dulo', baseUrl: 'https://dulo.tv', searchPath: '/search/' },
  { id: 'sflix', name: 'SFlix', baseUrl: 'https://sflix.ws', searchPath: '/search/' },
  { id: 'broodingmovies', name: 'BroodingMovies', baseUrl: 'https://broodingmovies.com', searchPath: '/search/' },
  { id: 'streamduck', name: 'StreamDuck', baseUrl: 'https://streamduck.site', searchPath: '/search/' },
  { id: 'hydraflix', name: 'HydraFlix', baseUrl: 'https://www.hydraflix.cc', searchPath: '/search/' },
  { id: 'cinebygd', name: 'Cineby.gd', baseUrl: 'https://cineby.gd', searchPath: '/search/' },
  { id: 'cinestreamsite', name: 'CineStream.site', baseUrl: 'https://cine-stream.site', searchPath: '/search/' },
  // Anime
  { id: 'anime-nexus', name: 'AnimeNexus', baseUrl: 'https://anime.nexus', searchPath: '/search/' },
  { id: 'anisuge', name: 'Anisuge', baseUrl: 'https://anisuge.tv', searchPath: '/search/' },
  { id: 'anizone', name: 'AniZone', baseUrl: 'https://anizone.to', searchPath: '/search/' },
  { id: 'miruro', name: 'Miruro', baseUrl: 'https://miruro.to', searchPath: '/search/' },
  { id: 'anitaku-io', name: 'AniTaku', baseUrl: 'https://anitaku.io', searchPath: '/search/' },
  { id: 'anify', name: 'Anify', baseUrl: 'https://anify.to', searchPath: '/search/' },
  { id: 'animetsu', name: 'Animetsu', baseUrl: 'https://animetsu.bz', searchPath: '/search/' },
  { id: 'kickass-anime', name: 'KickassAnime', baseUrl: 'https://kickass-anime.ro', searchPath: '/search/' },
  { id: 'animex', name: 'AnimeX', baseUrl: 'https://animex.one', searchPath: '/search/' },
  { id: 'animegg', name: 'AnimeGG', baseUrl: 'https://animegg.org', searchPath: '/search/' },
  { id: 'animestream', name: 'AnimeStream', baseUrl: 'https://animestream.net', searchPath: '/search/' },
  { id: 'allmanga', name: 'AllManga', baseUrl: 'https://allmanga.to', searchPath: '/search/' },
  { id: 'aniworld', name: 'AniWorld', baseUrl: 'https://aniworld.to', searchPath: '/search/' },
  { id: 'wcostream', name: 'WCOStream', baseUrl: 'https://wcostream.tv', searchPath: '/search/' },
  { id: '9anime', name: '9Anime', baseUrl: 'https://9anime.cl', searchPath: '/search/' },
  // Hentai
  { id: 'hanime', name: 'Hanime', baseUrl: 'https://hanime.tv', searchPath: '/search/' },
  { id: 'hentaihaven', name: 'HentaiHaven', baseUrl: 'https://hentaihaven.xxx', searchPath: '/search/' },
  { id: 'nhentai', name: 'Nhentai', baseUrl: 'https://nhentai.net', searchPath: '/search/?q=' },
];

export const ALL_SECONDARY_SOURCES = configs.map(s => ({
  id: s.id, name: s.name, scrape: makeScraper(s.id, s.name, s.baseUrl, s.searchPath),
}));

export default { fetchHdHubStreams, fetchCdn111477Streams, ALL_SECONDARY_SOURCES };
