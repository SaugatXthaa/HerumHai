"""
utils/http_client.py — 4-layer CF bypass using Scrapling StealthyFetcher + TRAWL + ScraperAPI.

Layer 1: Scrapling StealthyFetcher (bypasses CF Turnstile with stealth browser)
Layer 2: Scrapling Fetcher via .configure() (TLS fingerprint bypass)
Layer 3: ScraperAPI proxy (bypasses IP blocks for GDTot/GDFlix)
Layer 4: TRAWL (FlareSolverr-compatible — github.com/germondai/trawl)
Layer 5: curl_cffi direct (Chrome TLS handshake mimicry fallback)
"""

import os
import re
import json
import time
import base64
import urllib.parse
from typing import Optional, Dict, Any, List

TRAWL_URL = os.environ.get("TRAWL_URL", os.environ.get("FLARESOLVERR_URL", ""))
SCRAPER_API_KEY = os.environ.get("SCRAPER_API_KEY", "")

BROWSER_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
}

CF_TURNSTILE_DOMAINS = [
    "xpass.top", "vidsrc.to", "kisskh.id", "scloudx.lol",
    "ddlbase.com", "dramasuki.xyz", "net77.cc", "vidsrc.xyz",
    "psa.wf", "mkvbase.site", "hydrahd.ru", "jpfilms.com",
    "animepahe", "animaxanime", "asiaflix", "fluxtv",
    "streamiw", "dulo", "sflix", "streamduck", "hydraflix",
    "wmovies", "popcornmovies", "theflixertv", "onionplay",
    "nepu", "streamex", "opstream", "cinebytv", "ridomovies",
    "123moviesfree", "vidplay", "primewire", "m4uhd",
    "gdtot", "gdflix",
]

_stealth_fetcher = None
_fetcher = None


def _get_stealth():
    global _stealth_fetcher
    if _stealth_fetcher is None:
        from scrapling import StealthyFetcher
        _stealth_fetcher = StealthyFetcher()
    return _stealth_fetcher


def _get_fetcher():
    global _fetcher
    if _fetcher is None:
        from scrapling import Fetcher
        _fetcher = Fetcher()
    return _fetcher


def _is_cf_turnstile(url: str) -> bool:
    return any(d in url for d in CF_TURNSTILE_DOMAINS)


def _stealthy_fetch(url: str, timeout: int = 20) -> Optional[str]:
    """StealthyFetcher — bypasses CF Turnstile with 6s+8s wait."""
    try:
        stealth = _get_stealth()
        r = stealth.fetch(url, headless=True, timeout=timeout * 1000, wait_selector="body")
        if r.status == 200 and r.html_content:
            html = str(r.html_content)
            if "Just a moment" not in html:
                return html
            time.sleep(6)
            r2 = stealth.fetch(url, headless=True, timeout=timeout * 1000, wait_selector="body")
            if r2.status == 200 and r2.html_content:
                html2 = str(r2.html_content)
                if "Just a moment" not in html2:
                    return html2
                time.sleep(8)
                r3 = stealth.fetch(url, headless=True, timeout=timeout * 1000, wait_selector="body")
                if r3.status == 200 and r3.html_content:
                    html3 = str(r3.html_content)
                    if "Just a moment" not in html3:
                        return html3
    except:
        pass
    return None


def _stealthy_fetch_json(url: str, timeout: int = 20) -> Optional[Any]:
    html = _stealthy_fetch(url, timeout)
    if not html:
        return None
    text = re.sub(r'^<html><body>', '', html)
    text = re.sub(r'</body></html>$', '', text)
    text = text.replace('&amp;', '&').replace('&lt;', '<').replace('&gt;', '>')
    try:
        return json.loads(text)
    except:
        return None


def _fetcher_get(url: str, headers: Optional[Dict] = None, timeout: int = 8) -> Optional[str]:
    """Scrapling Fetcher — TLS fingerprint bypass."""
    try:
        fetcher = _get_fetcher()
        r = fetcher.get(url, timeout=timeout, headers={**BROWSER_HEADERS, **(headers or {})})
        if r.status == 200 and r.html_content:
            html = str(r.html_content)
            if "Just a moment" not in html:
                return html
    except:
        pass
    return None


def _scraperapi_get(url: str, timeout: int = 10) -> Optional[str]:
    """ScraperAPI proxy — bypasses IP blocks for GDTot/GDFlix."""
    if not SCRAPER_API_KEY:
        return None
    try:
        import requests
        encoded = urllib.parse.quote(url, safe='')
        proxy_url = f"https://api.scraperapi.com?api_key={SCRAPER_API_KEY}&url={encoded}"
        res = requests.get(proxy_url, headers={"User-Agent": BROWSER_HEADERS["User-Agent"]}, timeout=timeout)
        if res.status_code == 200:
            return res.text
    except:
        pass
    return None


def _trawl_get(url: str, timeout: int = 15) -> Optional[str]:
    """TRAWL — FlareSolverr-compatible CF solver."""
    if not TRAWL_URL:
        return None
    try:
        import requests
        res = requests.post(
            TRAWL_URL.rstrip("/") + "/v1",
            json={"cmd": "request.get", "url": url, "maxTimeout": timeout * 1000},
            timeout=timeout + 10,
        )
        if res.status_code == 200:
            data = res.json()
            if data.get("status") == "ok" and data.get("solution", {}).get("response"):
                return data["solution"]["response"]
    except:
        pass
    return None


def _cffi_get(url: str, headers: Optional[Dict] = None, timeout: int = 8) -> Optional[str]:
    """curl_cffi — Chrome TLS handshake mimicry."""
    try:
        from curl_cffi import requests as cffi
        r = cffi.get(url, headers={**BROWSER_HEADERS, **(headers or {})},
                     timeout=timeout, impersonate="chrome", verify=False)
        if r.status_code == 200 and r.text:
            if "Just a moment" not in r.text:
                return r.text
    except:
        pass
    return None


def fetch_html(url: str, headers: Optional[Dict] = None, timeout: int = 8) -> Optional[str]:
    """Fetch HTML using 5-layer CF bypass."""
    # Layer 1: StealthyFetcher for CF Turnstile domains
    if _is_cf_turnstile(url):
        html = _stealthy_fetch(url, timeout=20)
        if html:
            return html

    # Layer 2: ScraperAPI for GDTot/GDFlix (bypasses IP blocks)
    if "gdtot" in url or "gdflix" in url:
        html = _scraperapi_get(url, timeout=10)
        if html:
            return html

    # Layer 3: Scrapling Fetcher (TLS bypass)
    html = _fetcher_get(url, headers, timeout)
    if html:
        return html

    # Layer 4: TRAWL
    html = _trawl_get(url, timeout=15)
    if html:
        return html

    # Layer 5: curl_cffi fallback
    html = _cffi_get(url, headers, timeout)
    if html:
        return html

    # Last resort: StealthyFetcher for non-Turnstile domains
    if not _is_cf_turnstile(url):
        html = _stealthy_fetch(url, timeout=15)
        if html:
            return html

    return None


def fetch_json(url: str, headers: Optional[Dict] = None, timeout: int = 8) -> Optional[Any]:
    """Fetch and parse JSON using 5-layer bypass."""
    if _is_cf_turnstile(url):
        data = _stealthy_fetch_json(url, timeout=20)
        if data:
            return data

    try:
        fetcher = _get_fetcher()
        r = fetcher.get(url, timeout=timeout, headers={**BROWSER_HEADERS, "Accept": "application/json", **(headers or {})})
        if r.status == 200:
            try:
                return r.json()
            except:
                content = str(r.html_content) if r.html_content else ""
                content = re.sub(r'^<html><body>', '', content)
                content = re.sub(r'</body></html>$', '', content)
                content = content.replace('&amp;', '&')
                try:
                    return json.loads(content)
                except:
                    pass
    except:
        pass

    try:
        from curl_cffi import requests as cffi
        r = cffi.get(url, headers={**BROWSER_HEADERS, "Accept": "application/json", **(headers or {})},
                     timeout=timeout, impersonate="chrome", verify=False)
        if r.status_code == 200 and r.text:
            return json.loads(r.text)
    except:
        pass

    return None


def fetch_stealthy_html(url: str, timeout: int = 20) -> Optional[str]:
    return _stealthy_fetch(url, timeout)


def fetch_stealthy_json(url: str, timeout: int = 20) -> Optional[Any]:
    return _stealthy_fetch_json(url, timeout)


# =============================================================================
# GDrive / GDTot / GDFlix link extraction and resolution
# =============================================================================

def extract_gdrive_links(html_content: str) -> List[str]:
    """
    Extract Google Drive file IDs from HTML content.
    Handles direct links, viewer links, and atob/base64 obfuscated links.
    Returns list of GDrive file IDs.
    """
    streams = set()

    # Pattern A: Direct GDrive download links
    for fid in re.findall(r"drive\.google\.com/(?:uc\?export=download&id=|file/d/)([a-zA-Z0-9_-]+)", html_content, re.IGNORECASE):
        streams.add(fid)

    # Pattern B: GDTot/GDFlix internal file tokens
    for fid in re.findall(r"(?:gdtot|gdflix)\.[a-z\.]+/(?:file|d)/([a-zA-Z0-9_-]+)", html_content, re.IGNORECASE):
        streams.add(fid)

    # Pattern C: atob/base64 obfuscated GDrive links (GDFlix pattern)
    for b64 in re.findall(r"atob\s*\(\s*['\"]([A-Za-z0-9+/={}\s]+)['\"]\s*\)", html_content):
        try:
            decoded = base64.b64decode(b64).decode('utf-8')
            for fid in re.findall(r"drive\.google\.com/(?:uc\?export=download&id=|file/d/)([a-zA-Z0-9_-]+)", decoded, re.IGNORECASE):
                streams.add(fid)
        except:
            pass

    return list(streams)


def convert_gdrive_to_direct(file_id: str) -> str:
    """Convert GDrive file ID to direct download URL for Stremio."""
    return f"https://drive.google.com/uc?export=download&id={file_id}"


def resolve_gdtot_gdflix(url: str) -> List[str]:
    """
    Resolve GDTot/GDFlix URL to direct GDrive file IDs.
    Uses ScraperAPI (if configured) or StealthyFetcher to bypass blocks.
    """
    # Fetch the page HTML
    html = fetch_html(url, timeout=10)
    if not html:
        return []

    # Extract GDrive file IDs
    file_ids = extract_gdrive_links(html)
    return file_ids
