"""
sources/browser_scraper.py — Patchright (stealth Playwright) async browser scraper.

Uses Patchright instead of vanilla Playwright — patches Chromium at C++ level
to eliminate automation leaks (cdc_ arrays, navigator.webdriver, etc.) that
Cloudflare detects. This bypasses CF Turnstile on sites like xpass.top.

Ultra-lean config: images/fonts blocked, single-process, no GPU → ~150MB RAM.
"""

import re
import asyncio
from typing import List, Dict, Optional

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

BLOCKED_DOMAINS = [
    "googlesyndication", "doubleclick", "google-analytics", "googletagmanager",
    "facebook.com", "adsboosters", "cloudflareinsights", "llvpn.com", "tag.min.js",
    "winexch.com", "a-ads.com", "popads.net", "propellerads", "taboola", "outbrain",
]


async def browser_fetch_html_async(url: str, wait_seconds: int = 2) -> Optional[str]:
    """Fetch a page with Patchright async browser (stealth mode)."""
    try:
        from patchright.async_api import async_playwright

        async with async_playwright() as p:
            browser = await p.chromium.launch(
                headless=True,
                args=[
                    "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
                    "--single-process", "--disable-extensions",
                    "--blink-settings=imagesEnabled=false", "--mute-audio",
                ],
            )
            page = await browser.new_page()

            async def route_handler(route):
                if route.request.resource_type in ["image", "font", "media"]:
                    await route.abort()
                elif any(d in route.request.url for d in BLOCKED_DOMAINS):
                    await route.abort()
                else:
                    await route.continue_()

            await page.route("**/*", route_handler)
            await page.goto(url, wait_until="domcontentloaded", timeout=12000)
            await asyncio.sleep(wait_seconds)
            content = await page.content()
            await browser.close()
            return content
    except Exception as e:
        print(f"[browser] fetch failed: {str(e)[:50]}")
        return None


async def browser_scrape_wp_site(source_id: str, name: str, base_url: str, search_path: str,
                                  target: Dict, title: str) -> List[Dict]:
    """Scrape a WordPress site using Patchright browser."""
    from sources.hubcloud_resolver import resolve_streams_from_html
    import urllib.parse

    try:
        clean = re.sub(r"\s+\d{4}$", "", title or "").strip()
        if not clean:
            return []

        search_url = f"{base_url}{search_path}{clean}"
        html = await browser_fetch_html_async(search_url, wait_seconds=2)
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

        if not detail_links:
            return []

        all_streams = []
        for link in list(detail_links)[:2]:
            detail_html = await browser_fetch_html_async(link, wait_seconds=2)
            if detail_html:
                streams = resolve_streams_from_html(detail_html, title, name, source_id)
                all_streams.extend(streams)

        if all_streams:
            print(f"[{source_id}-browser] {len(all_streams)} streams")
        return all_streams
    except Exception as e:
        print(f"[{source_id}-browser] error: {str(e)[:50]}")
        return []


async def browser_scrape_xpass(target: Dict, title: str) -> List[Dict]:
    """Scrape xpass.top using Patchright (bypasses CF Turnstile)."""
    import json

    try:
        imdb_id = target.get("imdb_id")
        if not imdb_id:
            return []

        media_type = target.get("type", "movie")
        season = target.get("season")
        episode = target.get("episode")

        if media_type == "movie":
            embed_url = f"https://play.xpass.top/e/movie/{imdb_id}"
        else:
            from utils.metadata import resolve_tmdb_id
            tmdb_id = resolve_tmdb_id(imdb_id, media_type, title)
            if not tmdb_id:
                return []
            embed_url = f"https://play.xpass.top/e/tv/{tmdb_id}/{season or 1}/{episode or 1}"

        html = await browser_fetch_html_async(embed_url, wait_seconds=8)
        if not html:
            return []

        if '"playlist":"/vxr/tv/0/' in html or '"playlist":"/vrk/tv/0/' in html:
            return []

        playlist_paths = set()
        for m in re.finditer(r'"url":"([^"]*playlist\.json)"', html):
            if "/video/error" not in m.group(1):
                playlist_paths.add(m.group(1))

        if not playlist_paths:
            return []

        streams = []
        for path in list(playlist_paths)[:5]:
            url = path if path.startswith("http") else f"https://play.xpass.top{path}"
            try:
                from utils.http_client import fetch_json
                data = fetch_json(url, headers={"Referer": embed_url}, timeout=5)
                if not data or not data.get("playlist") or not data["playlist"][0].get("sources"):
                    continue
                for src in data["playlist"][0]["sources"]:
                    file_url = src.get("file", "")
                    if file_url and "/video/error" not in file_url:
                        streams.append({
                            "name": f"HerumHai · xpass",
                            "title": f"HerumHai · xpass · {title}",
                            "description": f"Source: xpass.top (Patchright CF bypass)\nTitle: {title}",
                            "url": file_url, "source": "xpass",
                            "behaviorHints": {
                                "notWebReady": True, "filename": f"{title}.m3u8",
                                "proxyHeaders": {"request": {"User-Agent": UA, "Referer": "https://play.xpass.top/"}},
                            },
                        })
            except:
                continue

        if streams:
            print(f"[xpass-browser] {len(streams)} streams")
        return streams
    except Exception as e:
        print(f"[xpass-browser] error: {str(e)[:50]}")
        return []


async def run_browser_scrapers(target: Dict, title: str, sources: List[Dict]) -> List[Dict]:
    """Run browser scrapers — xpass.top only (CF Turnstile bypass via StealthyFetcher)."""
    all_streams = []
    print("[browser] starting xpass scraper...")
    try:
        from sources.embed_providers import scrape_2embed_xpass
        # Run in separate thread — StealthyFetcher/Playwright needs its own thread
        xpass_streams = await asyncio.to_thread(scrape_2embed_xpass, target, title)
        print(f"[browser] xpass returned {len(xpass_streams)} streams")
        all_streams.extend(xpass_streams)
    except Exception as e:
        print(f"[browser] xpass error: {str(e)[:80]}")
    return all_streams
