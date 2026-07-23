"""
sources/all_sources.py — All stream sources (NO HdHub, NO PenguPlay).

PRIMARY: 111477 CDN (always works — directory listing)
SECONDARY: 100+ WordPress sites using curl_cffi + multi-host resolver
  - HubCloud → sportverse.cc → workers.dev CDN
  - UnblockedGames → POST → direct video URL
  - Direct m3u8/mp4/mkv URLs
"""

import re
import urllib.parse
from typing import List, Dict, Any
from curl_cffi import requests as cffi
from sources.cdn111477 import scrape as scrape_cdn111477
from sources.hubcloud_resolver import resolve_streams_from_html, extract_hubcloud_ids, resolve_hubcloud_streams
from sources.embed_providers import EMBED_SCRAPERS, scrape_2embed_xpass
from sources.browser_scraper import browser_scrape_wp_site

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"


# =============================================================================
# PRIMARY SOURCE: 111477 CDN (5-27 direct MKV files from directory listing)
# =============================================================================
def fetch_cdn111477_streams(target: Dict, title: str) -> List[Dict]:
    return scrape_cdn111477(target, title)


# =============================================================================
# SECONDARY SOURCES: 2-step WordPress scraper with multi-host resolution
# =============================================================================
def _make_wp_scraper(source_id: str, name: str, base_url: str, search_path: str):
    def scraper(target: Dict, title: str) -> List[Dict]:
        try:
            clean = re.sub(r"\s+\d{4}$", "", title or "").strip()
            if not clean:
                return []

            # Step 1: Search
            search_url = f"{base_url}{search_path}{urllib.parse.quote(clean)}"
            r = cffi.get(search_url, headers={"User-Agent": UA, "Referer": base_url, "Accept": "text/html"},
                         timeout=8, impersonate="chrome", verify=False)
            if r.status_code != 200:
                return []

            html = r.text
            host = urllib.parse.urlparse(base_url).hostname or ""
            detail_links = set()

            # Pattern 1: Absolute URLs (exclude query params)
            for m in re.finditer(rf'href="(https?://[^"]*{re.escape(host)}[^"]*)"', html, re.IGNORECASE):
                link = m.group(1)
                if "?" in link or link in [base_url, base_url + "/"]:
                    continue
                if any(x in link for x in ["/category/", "/tag/", "/page/", "/feed", "/about", "/contact", "/dmca", "/privacy", "/terms", "/wp-", "/author/", "/comment", "/genre/", "/drama-list/"]):
                    continue
                slug = link.lower().replace("-", " ").replace("/", " ")
                title_words = [w for w in clean.lower().split() if len(w) > 2]
                if any(w in slug for w in title_words):
                    detail_links.add(link)

            # Pattern 2: Relative URLs (trailing slash optional)
            for m in re.finditer(r'href="(/[a-z0-9-]+/?)"', html, re.IGNORECASE):
                link = m.group(1)
                if link in ["/", "//"] or "?" in link:
                    continue
                if any(x in link for x in ["/category/", "/tag/", "/page/", "/feed", "/about", "/contact", "/dmca", "/privacy", "/terms", "/wp-", "/author/", "/comment", "/genre/", "/drama-list/"]):
                    continue
                slug = link.lower().replace("-", " ").replace("/", " ")
                title_words = [w for w in clean.lower().split() if len(w) > 2]
                if any(w in slug for w in title_words):
                    detail_links.add(f"{base_url.rstrip('/')}{link}")

            # Pattern 3: movie-card class links
            for m in re.finditer(r'href="([^"]+)"[^>]*class="[^"]*movie-card[^"]*"', html, re.IGNORECASE):
                link = m.group(1)
                if "?" in link:
                    continue
                if link.startswith("/"):
                    link = f"{base_url.rstrip('/')}{link}"
                if link.startswith("http"):
                    detail_links.add(link)

            if not detail_links:
                return []

            # Step 2: Fetch detail pages → extract streams (HubCloud + UnblockedGames + direct)
            all_streams = []
            for link in list(detail_links)[:2]:
                try:
                    r2 = cffi.get(link, headers={"User-Agent": UA, "Referer": base_url},
                                  timeout=8, impersonate="chrome", verify=False)
                    if r2.status_code == 200:
                        streams = resolve_streams_from_html(r2.text, title, name, source_id)
                        all_streams.extend(streams)
                except:
                    continue

            if all_streams:
                print(f"[{source_id}] {len(all_streams)} streams")
            return all_streams

        except Exception as e:
            print(f"[{source_id}] error: {str(e)[:60]}")
            return []
    return scraper


# All source configurations
SOURCE_CONFIGS = [
    ("acermovies", "AcerMovies", "https://acermovies.fun", "/search/"),
    ("scloudx", "SCloudX", "https://scloudx.lol", "/search/"),
    ("dramasuki", "DramaSuki", "https://dramasuki.xyz", "/search/"),
    ("vegamovies", "VegaMovies", "https://vegamovies.navy", "/?s="),
    ("pahe", "Pahe", "https://pahe.ink", "/?s="),
    ("ddlbase", "DDLBase", "https://ddlbase.com", "/?s="),
    ("mkvbase", "MKVBase", "https://mkvbase.site", "/?s="),
    ("xdmovies", "XDMovies", "https://top.xdmovies.wtf", "/?s="),
    ("showbox", "ShowBox", "https://www.showbox.media", "/?s="),
    ("psa", "PSA", "https://psa.wf", "/?s="),
    ("cinebyat", "Cineby.at", "https://www.cineby.at", "/?s="),
    ("uhdmovies", "UHDMovies", "https://uhdmovies.casa", "/?s="),
    ("4khdhub", "4KHDHub", "https://4khdhub.one", "/?s="),
    ("anime2enjoy", "Anime2Enjoy", "https://www.anime2enjoy.com", "/?s="),
    ("aether", "Aether", "https://aether.cx", "/?s="),
    ("afterstream", "AfterStream", "https://afterstream.org", "/?s="),
    ("1shows", "1Shows", "https://www.1shows.org", "/?s="),
    ("cinestream", "CineStream", "https://cinestream.kje.us", "/?s="),
    ("1flex", "1Flex", "https://www.1flex.org", "/?s="),
    ("hydrahd1", "HydraHD.com", "https://hydrahd.com", "/?s="),
    ("hydrahd2", "HydraHD.ru", "https://hydrahd.ru", "/?s="),
    ("anixx", "Anixx", "https://anixx.fun", "/?s="),
    ("anixtv", "AnixTV", "https://anixtv.in", "/?s="),
    ("rarefilmm", "RareFilmm", "https://rarefilmm.com", "/?s="),
    ("jpfilms", "JPFilms", "https://jp-films.com", "/?s="),
    ("animepahe", "AnimePahe", "https://animepahe.pw", "/?s="),
    ("animaxanime", "AnimaxAnime", "https://animaxanime.dpdns.org", "/?s="),
    ("kisskh", "KissKh", "https://kisskh.id", "/api/anime/list?q="),
    ("goplay", "GoPlay", "https://goplay.su", "/search?q="),
    ("dramacool", "Dramacool", "https://dramacoolv.buzz", "/?s="),
    ("myasiantv", "MyAsianTV", "https://myasiantv.com.bz", "/search/"),
    ("kissasian", "KissAsian", "https://wwv19.kissasian.com.lv", "/Search?type=Movies&key="),
    ("asianctv", "AsianCTV", "https://asianctv.cc", "/?s="),
    ("asiaflix", "AsiaFlix", "https://asiaflix.net", "/search?q="),
    ("soap2night", "Soap2Night", "https://soap2night.cc", "/?s="),
    ("ramoflix", "Ramoflix", "https://ramoflix.net", "/?s="),
    ("wmovies", "WMovies", "https://wmovies.org", "/?s="),
    ("doraby", "Doraby", "https://doraby.com", "/?s="),
    ("cineby", "Cineby", "https://cineby.sc", "/?s="),
    ("flickystream", "FlickyStream", "https://flickystream.ru", "/?s="),
    ("cinema-bz", "Cinema.bz", "https://cinema.bz", "/?s="),
    ("flixer", "Flixer", "https://flixer.su", "/?s="),
    ("goojara", "Goojara", "https://goojara.to", "/?s="),
    ("streamvaults", "StreamVaults", "https://streamvaults.ru", "/?s="),
    ("67movies", "67Movies", "https://67movies.net", "/?s="),
    ("shuttletv", "ShuttleTV", "https://shuttletv.su", "/?s="),
    ("popcornmovies", "PopcornMovies", "https://popcornmovies.org", "/?s="),
    ("rivestream", "RiveStream", "https://rivestream.app", "/?s="),
    ("theflixertv", "TheFlixerTV", "https://theflixertv.click", "/?s="),
    ("onionplay", "OnionPlay", "https://onionplay.io", "/?s="),
    ("lookmovie2", "LookMovie2", "https://lookmovie2.to", "/?s="),
    ("pressplayz", "PressPlayz", "https://pressplayz.to", "/?s="),
    ("nepu", "Nepu", "https://nepu.to", "/?s="),
    ("fmovies", "FMovies", "https://fmovies.co", "/?s="),
    ("soap2dayhd", "Soap2DayHD", "https://soap2dayhd.net", "/?s="),
    ("projectfreetv", "ProjectFreeTV", "https://projectfreetv.sx", "/?s="),
    ("mappl", "Mappl", "https://mappl.tv", "/?s="),
    ("streamex", "StreamEx", "https://streamex.sh", "/?s="),
    ("opstream", "OpStream", "https://opstream.fun", "/?s="),
    ("movish", "Movish", "https://movish.to", "/?s="),
    ("themoviebox", "TheMovieBox", "https://themoviebox.org", "/?s="),
    ("hdtoday", "HDToday", "https://hdtoday.tr", "/?s="),
    ("cinebytv", "CinebyTV", "https://cinebytv.com", "/?s="),
    ("ridomovies", "RidoMovies", "https://ridomovies.su", "/?s="),
    ("123moviesfree", "123MoviesFree", "https://123moviesfree.net", "/?s="),
    ("vidplay", "VidPlay", "https://vidplay.top", "/?s="),
    ("cinemaos", "CinemaOS", "https://cinemaos.live", "/?s="),
    ("yesmovies", "YesMovies", "https://yesmovies.ag", "/?s="),
    ("primewire", "PrimeWire", "https://primewire.mov", "/?s="),
    ("m4uhd", "M4UHD", "https://m4uhd.page", "/?s="),
    ("net77", "Net77", "https://net77.cc", "/?s="),
    ("fluxtv", "FluxTV", "https://fluxtv.cc", "/?s="),
    ("ernax", "Ernax", "https://ernax.pro", "/?s="),
    ("boredflix", "Boredflix", "https://boredflix.tv", "/?s="),
    ("hdmovix", "HDMovix", "https://hdmovix.cc", "/?s="),
    ("streamiw", "Streamiw", "https://streamiw.xyz", "/?s="),
    ("fmoviesgd", "FMovies.gd", "https://fmovies.gd", "/?s="),
    ("flixstream", "FlixStream", "https://flixstream.ca", "/?s="),
    ("dulo", "Dulo", "https://dulo.tv", "/?s="),
    ("sflix", "SFlix", "https://sflix.ws", "/?s="),
    ("broodingmovies", "BroodingMovies", "https://broodingmovies.com", "/?s="),
    ("streamduck", "StreamDuck", "https://streamduck.site", "/?s="),
    ("hydraflix", "HydraFlix", "https://www.hydraflix.cc", "/?s="),
    ("cinebygd", "Cineby.gd", "https://cineby.gd", "/?s="),
    ("cinestreamsite", "CineStream.site", "https://cine-stream.site", "/?s="),
    ("anime-nexus", "AnimeNexus", "https://anime.nexus", "/?s="),
    ("anisuge", "Anisuge", "https://anisuge.tv", "/?s="),
    ("anizone", "AniZone", "https://anizone.to", "/?s="),
    ("miruro", "Miruro", "https://miruro.to", "/?s="),
    ("anitaku-io", "AniTaku", "https://anitaku.io", "/?s="),
    ("anify", "Anify", "https://anify.to", "/?s="),
    ("animetsu", "Animetsu", "https://animetsu.bz", "/?s="),
    ("kickass-anime", "KickassAnime", "https://kickass-anime.ro", "/?s="),
    ("animex", "AnimeX", "https://animex.one", "/?s="),
    ("animegg", "AnimeGG", "https://animegg.org", "/?s="),
    ("animestream", "AnimeStream", "https://animestream.net", "/?s="),
    ("allmanga", "AllManga", "https://allmanga.to", "/?s="),
    ("aniworld", "AniWorld", "https://aniworld.to", "/?s="),
    ("wcostream", "WCOStream", "https://wcostream.tv", "/?s="),
    ("9anime", "9Anime", "https://9anime.cl", "/?s="),
    ("hanime", "Hanime", "https://hanime.tv", "/?s="),
    ("hentaihaven", "HentaiHaven", "https://hentaihaven.xxx", "/?s="),
    ("nhentai", "Nhentai", "https://nhentai.net", "/search/?q="),
]

ALL_SECONDARY_SOURCES = [
    {"id": sid, "name": sname, "scrape": _make_wp_scraper(sid, sname, burl, spath)}
    for sid, sname, burl, spath in SOURCE_CONFIGS
]

# Browser-based scrapers for sites that need JavaScript rendering
# These use Playwright (ultra-lean: images blocked, single-process) to render
# JS-loaded content that curl_cffi can't see
BROWSER_SOURCES = [
    {"id": "vegamovies", "name": "VegaMovies", "base_url": "https://vegamovies.navy", "search_path": "/?s="},
    {"id": "uhdmovies", "name": "UHDMovies", "base_url": "https://uhdmovies.casa", "search_path": "/?s="},
    {"id": "rarefilmm", "name": "RareFilmm", "base_url": "https://rarefilmm.com", "search_path": "/?s="},
    {"id": "pahe", "name": "Pahe", "base_url": "https://pahe.ink", "search_path": "/?s="},
    {"id": "showbox", "name": "ShowBox", "base_url": "https://www.showbox.media", "search_path": "/?s="},
    {"id": "xdmovies", "name": "XDMovies", "base_url": "https://top.xdmovies.wtf", "search_path": "/?s="},
]
