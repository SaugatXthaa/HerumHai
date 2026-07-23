"""
sources/browser_scraper.py — Ultra-lean Playwright ASYNC browser scraper.

Uses Playwright ASYNC API to work with FastAPI's event loop.
Ultra-lean config: images/fonts blocked, single-process, no GPU → ~150MB RAM.
"""

import re
import asyncio
from typing import List, Dict, Optional

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

BLOCKED_DOMAINS = [
    "googlesyndication", "doubleclick", "google-analytics", "googletagmanager",
    "facebook.com", "adsboosters", "cloudflareinsights", "llvpn.com", "tag.min.js",
]


async def browser_fetch_html_async(url: str, wait_seconds: int = 2) -> Optional[str]:
    """Fetch a page with Playwright async browser."""
    from playwright.async_api import async_playwright

    try:
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

            # Block ads + images
            async def route_handler(route):
                if route.request.resource_type in ["image", "font", "media"]:
                    await route.abort()
                elif any(d in route.request.url for d in BLOCKED_DOMAINS):
                    await route.abort()
                else:
                    await route.continue_()

            await page.route("**/*", route_handler)
            await page.add_init_script("""
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                window.chrome = { runtime: {} };
            """)

            await page.goto(url, wait_until="domcontentloaded", timeout=10000)
            await asyncio.sleep(wait_seconds)
            content = await page.content()
            await browser.close()
            return content
    except Exception as e:
        print(f"[browser] fetch failed: {str(e)[:50]}")
        return None


async def browser_scrape_wp_site(source_id: str, name: str, base_url: str, search_path: str,
                                  target: Dict, title: str) -> List[Dict]:
    """Scrape a WordPress site using async browser."""
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

        for m in re.finditer(rf'href="(https?://[^"]*{re.escape(host)}[^"]*)"', html, re.IGNORECASE):
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


async def run_browser_scrapers(target: Dict, title: str, sources: List[Dict]) -> List[Dict]:
    """Run all browser scrapers sequentially (one browser at a time to save memory)."""
    all_streams = []
    for s in sources[:3]:  # Max 3 to avoid timeout
        try:
            streams = await browser_scrape_wp_site(
                s["id"], s["name"], s["base_url"], s["search_path"], target, title
            )
            if streams:
                all_streams.extend(streams)
        except:
            pass
    return all_streams
