"""
sources/all_sources.py — All stream sources with multi-host resolver.

PRIMARY: 111477 CDN + xpass.top (StealthyFetcher CF Turnstile bypass)
SECONDARY: 49+ WordPress sites using ScraperAPI + Scrapling + GDrive/GDTot/GDFlix resolver

Uses resolve_all_from_html() which handles ALL file host types:
  - Google Drive (direct + viewer + atob obfuscated)
  - GDTot (via ScraperAPI proxy)
  - GDFlix (via ScraperAPI proxy + atob deobfuscation)
  - HubCloud → sportverse.cc → workers.dev
  - UnblockedGames
  - Pixeldrain
  - Direct .mkv/.mp4/.m3u8 URLs
  - workers.dev CDN URLs
"""

import re
import urllib.parse
from typing import List, Dict, Any
from utils.http_client import fetch_html
from sources.cdn111477 import scrape as scrape_cdn111477
from sources.gdrive_resolver import resolve_all_from_html
from sources.embed_providers import EMBED_SCRAPERS
from sources.browser_scraper import run_browser_scrapers

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"


def fetch_cdn111477_streams(target: Dict, title: str) -> List[Dict]:
    return scrape_cdn111477(target, title)


def _make_wp_scraper(source_id, name, base_url, search_path):
    def scraper(target, title):
        try:
            clean = re.sub(r"\s+\d{4}$", "", title or "").strip()
            if not clean:
                return []
            search_url = f"{base_url}{search_path}{urllib.parse.quote(clean)}"
            html = fetch_html(search_url, headers={"Referer": base_url})
            if not html:
                return []
            host = urllib.parse.urlparse(base_url).hostname or ""
            detail_links = set()
            for m in re.finditer(r'href="(https?://[^"]*' + re.escape(host) + r'[^"]*)"', html, re.IGNORECASE):
                link = m.group(1)
                if "?" in link or link in [base_url, base_url + "/"]:
                    continue
                if any(x in link for x in ["/category/", "/tag/", "/page/", "/feed", "/wp-", "/author/", "/genre/", "/drama-list/"]):
                    continue
                slug = link.lower().replace("-", " ").replace("/", " ")
                if any(w in slug for w in clean.lower().split() if len(w) > 2):
                    detail_links.add(link)
            for m in re.finditer(r'href="(/[a-z0-9-]+/?)"', html, re.IGNORECASE):
                link = m.group(1)
                if link in ["/", "//"] or "?" in link:
                    continue
                if any(x in link for x in ["/category/", "/tag/", "/page/", "/feed", "/wp-", "/author/", "/genre/", "/drama-list/"]):
                    continue
                slug = link.lower().replace("-", " ").replace("/", " ")
                if any(w in slug for w in clean.lower().split() if len(w) > 2):
                    detail_links.add(f"{base_url.rstrip('/')}{link}")
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
            all_streams = []
            for link in list(detail_links)[:2]:
                try:
                    detail_html = fetch_html(link, headers={"Referer": base_url})
                    if detail_html:
                        streams = resolve_all_from_html(detail_html, title, name, source_id)
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


SOURCE_CONFIGS = [
    ("acermovies", "AcerMovies", "https://acermovies.fun", "/search/"),
    ("vegamovies", "VegaMovies", "https://vegamovies.navy", "/?s="),
    ("uhdmovies", "UHDMovies", "https://uhdmovies.casa", "/?s="),
    ("4khdhub", "4KHDHub", "https://4khdhub.one", "/?s="),
    ("pahe", "Pahe", "https://pahe.ink", "/?s="),
    ("rarefilmm", "RareFilmm", "https://rarefilmm.com", "/?s="),
    ("showbox", "ShowBox", "https://www.showbox.media", "/?s="),
    ("xdmovies", "XDMovies", "https://top.xdmovies.wtf", "/?s="),
    ("cinebyat", "Cineby.at", "https://www.cineby.at", "/?s="),
    ("anime2enjoy", "Anime2Enjoy", "https://www.anime2enjoy.com", "/?s="),
    ("aether", "Aether", "https://aether.cx", "/?s="),
    ("afterstream", "AfterStream", "https://afterstream.org", "/?s="),
    ("1shows", "1Shows", "https://www.1shows.org", "/?s="),
    ("cinestream", "CineStream", "https://cinestream.kje.us", "/?s="),
    ("1flex", "1Flex", "https://www.1flex.org", "/?s="),
    ("hydrahd1", "HydraHD.com", "https://hydrahd.com", "/?s="),
    ("anixx", "Anixx", "https://anixx.fun", "/?s="),
    ("anixtv", "AnixTV", "https://anixtv.in", "/?s="),
    ("dramacool", "Dramacool", "https://dramacoolv.buzz", "/?s="),
    ("myasiantv", "MyAsianTV", "https://myasiantv.com.bz", "/search/"),
    ("kissasian", "KissAsian", "https://wwv19.kissasian.com.lv", "/Search?type=Movies&key="),
    ("asianctv", "AsianCTV", "https://asianctv.cc", "/?s="),
    ("ernax", "Ernax", "https://ernax.pro", "/?s="),
    ("boredflix", "Boredflix", "https://boredflix.tv", "/?s="),
    ("hdmovix", "HDMovix", "https://hdmovix.cc", "/?s="),
    ("fmoviesgd", "FMovies.gd", "https://fmovies.gd", "/?s="),
    ("flixstream", "FlixStream", "https://flixstream.ca", "/?s="),
    ("broodingmovies", "BroodingMovies", "https://broodingmovies.com", "/?s="),
    ("cinebygd", "Cineby.gd", "https://cineby.gd", "/?s="),
    ("cineby", "Cineby", "https://cineby.sc", "/?s="),
    ("soap2night", "Soap2Night", "https://soap2night.cc", "/?s="),
    ("ramoflix", "Ramoflix", "https://ramoflix.net", "/?s="),
    ("doraby", "Doraby", "https://doraby.com", "/?s="),
    ("flixer", "Flixer", "https://flixer.su", "/?s="),
    ("goojara", "Goojara", "https://goojara.to", "/?s="),
    ("67movies", "67Movies", "https://67movies.net", "/?s="),
    ("shuttletv", "ShuttleTV", "https://shuttletv.su", "/?s="),
    ("lookmovie2", "LookMovie2", "https://lookmovie2.to", "/?s="),
    ("pressplayz", "PressPlayz", "https://pressplayz.to", "/?s="),
    ("fmovies", "FMovies", "https://fmovies.co", "/?s="),
    ("soap2dayhd", "Soap2DayHD", "https://soap2dayhd.net", "/?s="),
    ("projectfreetv", "ProjectFreeTV", "https://projectfreetv.sx", "/?s="),
    ("mappl", "Mappl", "https://mappl.tv", "/?s="),
    ("movish", "Movish", "https://movish.to", "/?s="),
    ("themoviebox", "TheMovieBox", "https://themoviebox.org", "/?s="),
    ("hdtoday", "HDToday", "https://hdtoday.tr", "/?s="),
    ("cinemaos", "CinemaOS", "https://cinemaos.live", "/?s="),
    ("yesmovies", "YesMovies", "https://yesmovies.ag", "/?s="),
    # CF-blocked sites (StealthyFetcher + ScraperAPI will try to bypass)
    ("ddlbase", "DDLBase", "https://ddlbase.com", "/?s="),
    ("psa", "PSA", "https://psa.wf", "/?s="),
    ("mkvbase", "MKVBase", "https://mkvbase.site", "/?s="),
    ("hydrahd2", "HydraHD.ru", "https://hydrahd.ru", "/?s="),
    ("jpfilms", "JPFilms", "https://jp-films.com", "/?s="),
    ("animepahe", "AnimePahe", "https://animepahe.pw", "/?s="),
    ("scloudx", "SCloudX", "https://scloudx.lol", "/search/"),
    ("dramasuki", "DramaSuki", "https://dramasuki.xyz", "/search/"),
    ("net77", "Net77", "https://net77.cc", "/?s="),
    ("fluxtv", "FluxTV", "https://fluxtv.cc", "/?s="),
    ("streamiw", "Streamiw", "https://streamiw.xyz", "/?s="),
    ("dulo", "Dulo", "https://dulo.tv", "/?s="),
    ("sflix", "SFlix", "https://sflix.ws", "/?s="),
    ("streamduck", "StreamDuck", "https://streamduck.site", "/?s="),
    ("hydraflix", "HydraFlix", "https://www.hydraflix.cc", "/?s="),
    ("wmovies", "WMovies", "https://wmovies.org", "/?s="),
    ("popcornmovies", "PopcornMovies", "https://popcornmovies.org", "/?s="),
    ("theflixertv", "TheFlixerTV", "https://theflixertv.click", "/?s="),
    ("onionplay", "OnionPlay", "https://onionplay.io", "/?s="),
    ("nepu", "Nepu", "https://nepu.to", "/?s="),
    ("streamex", "StreamEx", "https://streamex.sh", "/?s="),
    ("opstream", "OpStream", "https://opstream.fun", "/?s="),
    ("cinebytv", "CinebyTV", "https://cinebytv.com", "/?s="),
    ("ridomovies", "RidoMovies", "https://ridomovies.su", "/?s="),
    ("123moviesfree", "123MoviesFree", "https://123moviesfree.net", "/?s="),
    ("vidplay", "VidPlay", "https://vidplay.top", "/?s="),
    ("primewire", "PrimeWire", "https://primewire.mov", "/?s="),
    ("m4uhd", "M4UHD", "https://m4uhd.page", "/?s="),
]

ALL_SECONDARY_SOURCES = [
    {"id": sid, "name": sname, "scrape": _make_wp_scraper(sid, sname, burl, spath)}
    for sid, sname, burl, spath in SOURCE_CONFIGS
]

BROWSER_SOURCES = [
    {"id": "vegamovies", "name": "VegaMovies", "base_url": "https://vegamovies.navy", "search_path": "/?s="},
    {"id": "uhdmovies", "name": "UHDMovies", "base_url": "https://uhdmovies.casa", "search_path": "/?s="},
    {"id": "rarefilmm", "name": "RareFilmm", "base_url": "https://rarefilmm.com", "search_path": "/?s="},
]
