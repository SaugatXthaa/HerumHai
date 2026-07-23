"""
sources/all_sources.py — All stream sources using curl_cffi for CF bypass.

Primary sources (always work):
  1. HdHub proxy (hdhub.thevolecitor.qzz.io) — 25+ direct CDN streams
  2. PenguPlay (pengu.uk) — 1+ direct stream
  3. 111477 CDN (a.111477.xyz) — 5-27 direct MKV files from directory listing

Secondary sources (104+ web scrapers using curl_cffi with impersonate="chrome"):
  - Asian drama, movies, series, anime, hentai, direct download sites
  - curl_cffi bypasses Cloudflare TLS fingerprinting without a browser
"""

import re
from typing import List, Dict, Any
from utils.http_client import fetch_html, fetch_json_sync, get_ua
from sources.cdn111477 import scrape as scrape_cdn111477

CDN_BASE = "https://a.111477.xyz"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"


# =============================================================================
# PRIMARY SOURCE 1: HdHub proxy (always works, 25+ direct streams)
# =============================================================================
def fetch_hdhub_streams(media_type: str, media_id: str) -> List[Dict]:
    """Fetch streams from HdHub proxy — returns direct CDN URLs."""
    try:
        import json
        from curl_cffi import requests as cffi_requests

        url = f"https://hdhub.thevolecitor.qzz.io/stream/{media_type}/{media_id}.json"
        response = cffi_requests.get(
            url,
            headers={"User-Agent": UA, "Accept": "application/json"},
            timeout=10,
            impersonate="chrome",
            verify=False,
        )

        if response.status_code != 200:
            return []

        data = response.json()
        streams = data.get("streams", [])

        # Filter: only direct HTTPS streams (no torrents, no donation messages)
        direct = []
        for s in streams:
            if not s.get("url") or s.get("infoHash"):
                continue
            if not s["url"].startswith("http"):
                continue
            if "/login" in s["url"]:
                continue
            name = (s.get("name") or "").lower()
            if "donation" in name or "donate" in name:
                continue
            s["source"] = "hdhub"
            direct.append(s)

        print(f"[hdhub] {len(direct)} streams")
        return direct
    except Exception as e:
        print(f"[hdhub] error: {e}")
        return []


# =============================================================================
# PRIMARY SOURCE 2: PenguPlay (pengu.uk — returns 1+ direct stream)
# =============================================================================
def fetch_pengu_streams(media_type: str, media_id: str) -> List[Dict]:
    """Fetch streams from PenguPlay."""
    try:
        from curl_cffi import requests as cffi_requests

        url = f"https://pengu.uk/stream/{media_type}/{media_id}.json"
        response = cffi_requests.get(
            url,
            headers={"User-Agent": UA, "Accept": "application/json"},
            timeout=10,
            impersonate="chrome",
            verify=False,
        )

        if response.status_code != 200:
            return []

        data = response.json()
        streams = data.get("streams", [])

        direct = []
        for s in streams:
            if not s.get("url") or s.get("infoHash"):
                continue
            if not s["url"].startswith("http"):
                continue
            if "signin" in s["url"]:
                continue
            s["source"] = "pengu"
            direct.append(s)

        print(f"[pengu] {len(direct)} streams")
        return direct
    except Exception as e:
        print(f"[pengu] error: {e}")
        return []


# =============================================================================
# PRIMARY SOURCE 3: 111477 CDN (5-27 direct MKV files from directory listing)
# =============================================================================
def fetch_cdn111477_streams(target: Dict, title: str) -> List[Dict]:
    """Fetch streams from 111477 CDN directory listing."""
    return scrape_cdn111477(target, title)


# =============================================================================
# SECONDARY SOURCES: 104+ web scrapers using curl_cffi
# =============================================================================

def _extract_streams(html: str) -> List[str]:
    """Extract m3u8/mp4 URLs from HTML."""
    if not html:
        return []
    urls = set()
    for m in re.finditer(r"(https?://[^\s\"'<>]+\.m3u8[^\s\"'<>]*)", html, re.IGNORECASE):
        urls.add(m.group(1))
    for m in re.finditer(r"(https?://[^\s\"'<>]+\.mp4[^\s\"'<>]*)", html, re.IGNORECASE):
        urls.add(m.group(1))
    for m in re.finditer(r'"file"\s*:\s*"(https?://[^"]+)"', html, re.IGNORECASE):
        if ".m3u8" in m.group(1) or ".mp4" in m.group(1):
            urls.add(m.group(1))
    return list(urls)


def _make_scraper(source_id: str, name: str, base_url: str, search_path: str):
    """Create a scraper function for a web source."""
    def scraper(target: Dict, title: str) -> List[Dict]:
        try:
            clean = re.sub(r"\s+\d{4}$", "", title or "").strip()
            if not clean:
                return []
            search_url = f"{base_url}{search_path}{urllib.parse.quote(clean)}"
            html = fetch_html(search_url, headers={"Referer": base_url})
            if not html:
                return []
            stream_urls = _extract_streams(html)[:3]
            return [
                {
                    "name": f"HerumHai · {name}",
                    "title": f"HerumHai · {name}",
                    "description": f"Source: {name}\nTitle: {title}",
                    "url": u,
                    "source": source_id,
                    "behaviorHints": {
                        "notWebReady": True,
                        "proxyHeaders": {"request": {"User-Agent": UA, "Referer": base_url}},
                    },
                }
                for u in stream_urls
            ]
        except:
            return []
    return scraper


import urllib.parse

# All secondary source configurations
SOURCE_CONFIGS = [
    # Base64-decoded CDN sources
    ("acermovies", "AcerMovies", "https://acermovies.fun", "/search/"),
    ("scloudx", "SCloudX", "https://scloudx.lol", "/search/"),
    ("dramasuki", "DramaSuki", "https://dramasuki.xyz", "/search/"),
    # Direct download sites
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
    ("ondemandchina", "OnDemandChina", "https://www.ondemandchina.com", "/zh-Hans/search?type=video&keyword="),
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
    # Asian drama
    ("kisskh", "KissKh", "https://kisskh.id", "/api/anime/list?q="),
    ("goplay", "GoPlay", "https://goplay.su", "/search?q="),
    ("dramacool", "Dramacool", "https://dramacool.com.tr", "/search?query="),
    ("myasiantv", "MyAsianTV", "https://myasiantv.com.bz", "/search/"),
    ("kissasian", "KissAsian", "https://wwv19.kissasian.com.lv", "/Search?type=Movies&key="),
    ("asianctv", "AsianCTV", "https://asianctv.cc", "/?s="),
    ("asiaflix", "AsiaFlix", "https://asiaflix.net", "/search?q="),
    # Movies & series
    ("soap2night", "Soap2Night", "https://soap2night.cc", "/search/"),
    ("ramoflix", "Ramoflix", "https://ramoflix.net", "/search/"),
    ("wmovies", "WMovies", "https://wmovies.org", "/?s="),
    ("doraby", "Doraby", "https://doraby.com", "/search/"),
    ("cineby", "Cineby", "https://cineby.sc", "/search/"),
    ("flickystream", "FlickyStream", "https://flickystream.ru", "/search/"),
    ("cinema-bz", "Cinema.bz", "https://cinema.bz", "/search/"),
    ("flixer", "Flixer", "https://flixer.su", "/search/"),
    ("goojara", "Goojara", "https://goojara.to", "/search/"),
    ("streamvaults", "StreamVaults", "https://streamvaults.ru", "/search/"),
    ("67movies", "67Movies", "https://67movies.net", "/search/"),
    ("shuttletv", "ShuttleTV", "https://shuttletv.su", "/search/"),
    ("popcornmovies", "PopcornMovies", "https://popcornmovies.org", "/search/"),
    ("rivestream", "RiveStream", "https://rivestream.app", "/search/"),
    ("theflixertv", "TheFlixerTV", "https://theflixertv.click", "/search/"),
    ("onionplay", "OnionPlay", "https://onionplay.io", "/search/"),
    ("lookmovie2", "LookMovie2", "https://lookmovie2.to", "/search/"),
    ("pressplayz", "PressPlayz", "https://pressplayz.to", "/search/"),
    ("nepu", "Nepu", "https://nepu.to", "/search/"),
    ("fmovies", "FMovies", "https://fmovies.co", "/search/"),
    ("soap2dayhd", "Soap2DayHD", "https://soap2dayhd.net", "/search/"),
    ("projectfreetv", "ProjectFreeTV", "https://projectfreetv.sx", "/search/"),
    ("mappl", "Mappl", "https://mappl.tv", "/search/"),
    ("streamex", "StreamEx", "https://streamex.sh", "/search/"),
    ("opstream", "OpStream", "https://opstream.fun", "/search/"),
    ("movish", "Movish", "https://movish.to", "/search/"),
    ("themoviebox", "TheMovieBox", "https://themoviebox.org", "/search/"),
    ("hdtoday", "HDToday", "https://hdtoday.tr", "/search/"),
    ("cinebytv", "CinebyTV", "https://cinebytv.com", "/search/"),
    ("ridomovies", "RidoMovies", "https://ridomovies.su", "/search/"),
    ("123moviesfree", "123MoviesFree", "https://123moviesfree.net", "/search/"),
    ("vidplay", "VidPlay", "https://vidplay.top", "/search/"),
    ("cinemaos", "CinemaOS", "https://cinemaos.live", "/search/"),
    ("yesmovies", "YesMovies", "https://yesmovies.ag", "/search/"),
    ("primewire", "PrimeWire", "https://primewire.mov", "/search/"),
    ("m4uhd", "M4UHD", "https://m4uhd.page", "/search/"),
    # New sources
    ("net77", "Net77", "https://net77.cc", "/search/"),
    ("fluxtv", "FluxTV", "https://fluxtv.cc", "/search/"),
    ("ernax", "Ernax", "https://ernax.pro", "/search/"),
    ("boredflix", "Boredflix", "https://boredflix.tv", "/search/"),
    ("hdmovix", "HDMovix", "https://hdmovix.cc", "/search/"),
    ("streamiw", "Streamiw", "https://streamiw.xyz", "/search/"),
    ("fmoviesgd", "FMovies.gd", "https://fmovies.gd", "/search/"),
    ("flixstream", "FlixStream", "https://flixstream.ca", "/search/"),
    ("dulo", "Dulo", "https://dulo.tv", "/search/"),
    ("sflix", "SFlix", "https://sflix.ws", "/search/"),
    ("broodingmovies", "BroodingMovies", "https://broodingmovies.com", "/search/"),
    ("streamduck", "StreamDuck", "https://streamduck.site", "/search/"),
    ("hydraflix", "HydraFlix", "https://www.hydraflix.cc", "/search/"),
    ("cinebygd", "Cineby.gd", "https://cineby.gd", "/search/"),
    ("cinestreamsite", "CineStream.site", "https://cine-stream.site", "/search/"),
    # Anime
    ("anime-nexus", "AnimeNexus", "https://anime.nexus", "/search/"),
    ("anisuge", "Anisuge", "https://anisuge.tv", "/search/"),
    ("anizone", "AniZone", "https://anizone.to", "/search/"),
    ("miruro", "Miruro", "https://miruro.to", "/search/"),
    ("anitaku-io", "AniTaku", "https://anitaku.io", "/search/"),
    ("anify", "Anify", "https://anify.to", "/search/"),
    ("animetsu", "Animetsu", "https://animetsu.bz", "/search/"),
    ("kickass-anime", "KickassAnime", "https://kickass-anime.ro", "/search/"),
    ("animex", "AnimeX", "https://animex.one", "/search/"),
    ("animegg", "AnimeGG", "https://animegg.org", "/search/"),
    ("animestream", "AnimeStream", "https://animestream.net", "/search/"),
    ("allmanga", "AllManga", "https://allmanga.to", "/search/"),
    ("aniworld", "AniWorld", "https://aniworld.to", "/search/"),
    ("wcostream", "WCOStream", "https://wcostream.tv", "/search/"),
    ("9anime", "9Anime", "https://9anime.cl", "/search/"),
    # Hentai
    ("hanime", "Hanime", "https://hanime.tv", "/search/"),
    ("hentaihaven", "HentaiHaven", "https://hentaihaven.xxx", "/search/"),
    ("nhentai", "Nhentai", "https://nhentai.net", "/search/?q="),
]

# Build all secondary scrapers
ALL_SECONDARY_SOURCES = [
    {"id": sid, "name": sname, "scrape": _make_scraper(sid, sname, burl, spath)}
    for sid, sname, burl, spath in SOURCE_CONFIGS
]
