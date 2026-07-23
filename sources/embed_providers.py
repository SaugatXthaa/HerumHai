"""
sources/embed_providers.py — Embed provider scrapers using curl_cffi.

These providers return stream URLs via JavaScript-loaded iframes.
We reverse-engineer the JS to find the actual API endpoints.

Providers:
  1. 2embed.cc → streamsrcs.2embed.cc → play.xpass.top (HLS streams)
  2. vidsrc.win → JavaScript embed (ad-heavy, skip)
  3. Direct embed providers (vidlink, vidfast, etc.) — SPA, need browser
"""

import re
import json
from typing import List, Dict
from utils.http_client import fetch_html, fetch_json, fetch_stealthy_html, fetch_stealthy_json

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
TMDB_KEY = "f894b4342dfe25ee2ca3ee30b552e16f"


def _resolve_tmdb_id(imdb_id: str, media_type: str) -> str:
    """Resolve IMDB ID to TMDB ID."""
    try:
        kind = "movie" if media_type == "movie" else "tv"
        data = fetch_json(f"https://api.themoviedb.org/3/find/{imdb_id}?api_key={TMDB_KEY}&external_source=imdb_id", timeout=5)
        if data:
            arr = data.get(f"{kind}_results", [])
            if arr and arr[0].get("id"):
                return str(arr[0]["id"])
    except:
        pass
    return ""


# =============================================================================
# 2embed.cc → xpass.top (HLS streams)
# =============================================================================
def scrape_2embed_xpass(target: Dict, title: str) -> List[Dict]:
    """
    2embed.cc embeds go through streamsrcs.2embed.cc → play.xpass.top.
    xpass.top returns HLS playlist URLs.
    """
    try:
        imdb_id = target.get("imdb_id")
        if not imdb_id:
            return []

        media_type = target.get("type", "movie")
        season = target.get("season")
        episode = target.get("episode")

        # Build xpass.top URL
        if media_type == "movie":
            embed_url = f"https://play.xpass.top/e/movie/{imdb_id}"
        else:
            # Need TMDB ID for series
            tmdb_id = _resolve_tmdb_id(imdb_id, media_type)
            if not tmdb_id:
                return []
            embed_url = f"https://play.xpass.top/e/tv/{tmdb_id}/{season or 1}/{episode or 1}"

        html = fetch_stealthy_html(embed_url, timeout=20)
        if not html:
            return []

        # Check if xpass found the title
        if '"playlist":"/vxr/tv/0/' in html or '"playlist":"/vrk/tv/0/' in html:
            return []

        # Extract playlist URLs
        playlist_paths = set()
        for m in re.finditer(r'"url":"([^"]*playlist\.json)"', html):
            if "/video/error" not in m.group(1):
                playlist_paths.add(m.group(1))

        if not playlist_paths:
            return []

        # Fetch playlists
        streams = []
        for path in list(playlist_paths)[:2]:
            url = path if path.startswith("http") else f"https://play.xpass.top{path}"
            try:
                data = fetch_stealthy_json(url, timeout=8)
                if not data or not data.get("playlist") or not data["playlist"][0].get("sources"):
                    continue
                for src in data["playlist"][0]["sources"]:
                    file_url = src.get("file", "")
                    if file_url and "/video/error" not in file_url:
                        # Validate URL returns video
                        streams.append({
                            "name": f"HerumHai · 2Embed",
                            "title": f"HerumHai · 2Embed · {title}",
                            "description": f"Source: 2embed.cc → xpass.top\nTitle: {title}",
                            "url": file_url,
                            "source": "2embed",
                            "behaviorHints": {
                                "notWebReady": True,
                                "filename": f"{title}.m3u8",
                                "proxyHeaders": {"request": {"User-Agent": UA, "Referer": "https://play.xpass.top/"}},
                                "bingeGroup": f"herumhai-2embed-{src.get('id', '')}",
                            },
                        })
            except:
                continue

        if streams:
            print(f"[2embed] {len(streams)} streams")
        return streams
    except Exception as e:
        print(f"[2embed] error: {str(e)[:50]}")
        return []


# =============================================================================
# Embed provider list (direct iframe → m3u8/mp4 extraction)
# =============================================================================
def scrape_embed_provider(provider_id: str, name: str, embed_url: str, target: Dict, title: str) -> List[Dict]:
    """Scrape an embed provider for direct stream URLs."""
    try:
        r = cffi.get(embed_url, headers={"User-Agent": UA, "Referer": "https://google.com"},
                     timeout=8, impersonate="chrome", verify=False)
        if r.status_code != 200:
            return []

        # Look for stream URLs
        m3u8 = re.findall(r'https?://[^\s"\'<>]+\.m3u8[^\s"\'<>]*', r.text, re.IGNORECASE)
        mp4 = re.findall(r'https?://[^\s"\'<>]+\.mp4[^\s"\'<>]*', r.text, re.IGNORECASE)
        file_json = re.findall(r'"file"\s*:\s*"(https?://[^"]+)"', r.text, re.IGNORECASE)
        src_json = re.findall(r'"src"\s*:\s*"(https?://[^"]+)"', r.text, re.IGNORECASE)

        all_urls = list(set(m3u8 + mp4 + [f for f in file_json if ".m3u8" in f or ".mp4" in f] +
                           [s for s in src_json if ".m3u8" in s or ".mp4" in s]))

        if not all_urls:
            return []

        streams = []
        for url in all_urls[:3]:
            streams.append({
                "name": f"HerumHai · {name}",
                "title": f"HerumHai · {name} · {title}",
                "description": f"Source: {name}\nTitle: {title}",
                "url": url, "source": provider_id,
                "behaviorHints": {
                    "notWebReady": True, "filename": f"{title}.m3u8",
                    "proxyHeaders": {"request": {"User-Agent": UA, "Referer": embed_url}},
                },
            })

        if streams:
            print(f"[{provider_id}] {len(streams)} streams")
        return streams
    except:
        return []


def make_embed_scraper(provider_id: str, name: str, url_builder):
    """Create an embed scraper with a URL builder function."""
    def scraper(target: Dict, title: str) -> List[Dict]:
        url = url_builder(target)
        if not url:
            return []
        return scrape_embed_provider(provider_id, name, url, target, title)
    return scraper


# URL builders for embed providers
def _vidlink_url(t): return f"https://vidlink.pro/movie/{t['imdb_id']}" if t.get("type") == "movie" else f"https://vidlink.pro/tv/{t['imdb_id']}/{t.get('season',1)}/{t.get('episode',1)}"
def _vidfast_url(t): return f"https://vidfast.pro/movie/{t['imdb_id']}" if t.get("type") == "movie" else f"https://vidfast.pro/tv/{t['imdb_id']}/{t.get('season',1)}/{t.get('episode',1)}"
def _2embed_url(t): return f"https://www.2embed.cc/embed/{t['imdb_id']}" if t.get("type") == "movie" else f"https://www.2embed.cc/embed/tv/{t['imdb_id']}&s={t.get('season',1)}&e={t.get('episode',1)}"
def _vidsrcwin_url(t): return f"https://vidsrc.win/embed/movie/{t['imdb_id']}" if t.get("type") == "movie" else f"https://vidsrc.win/embed/tv/{t['imdb_id']}/{t.get('season',1)}/{t.get('episode',1)}"
def _multiembed_url(t): return f"https://multiembed.mov/?video_id={t['imdb_id']}" + (f"&s={t.get('season',1)}&e={t.get('episode',1)}" if t.get("type") != "movie" else "")
def _embedsu_url(t): return f"https://embed.su/embed/movie/{t['imdb_id']}" if t.get("type") == "movie" else f"https://embed.su/embed/tv/{t['imdb_id']}/{t.get('season',1)}/{t.get('episode',1)}"
def _autoembed_url(t): return f"https://autoembed.cc/embed/movie/{t['imdb_id']}" if t.get("type") == "movie" else f"https://autoembed.cc/embed/tv/{t['imdb_id']}/{t.get('season',1)}/{t.get('episode',1)}"

# All embed scrapers
EMBED_SCRAPERS = [
    # xpass/2embed is handled by browser_scraper.py via StealthyFetcher (CF Turnstile bypass)
    {"id": "vidlink", "name": "VidLink", "scrape": make_embed_scraper("vidlink", "VidLink", _vidlink_url)},
    {"id": "vidfast", "name": "VidFast", "scrape": make_embed_scraper("vidfast", "VidFast", _vidfast_url)},
    {"id": "vidsrcwin", "name": "VidSrc.win", "scrape": make_embed_scraper("vidsrcwin", "VidSrc.win", _vidsrcwin_url)},
    {"id": "multiembed", "name": "MultiEmbed", "scrape": make_embed_scraper("multiembed", "MultiEmbed", _multiembed_url)},
    {"id": "embedsu", "name": "EmbedSu", "scrape": make_embed_scraper("embedsu", "EmbedSu", _embedsu_url)},
    {"id": "autoembed", "name": "AutoEmbed", "scrape": make_embed_scraper("autoembed", "AutoEmbed", _autoembed_url)},
]
