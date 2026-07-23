"""
utils/http_client.py — HTTP client with curl_cffi for Cloudflare TLS bypass.

Uses curl_cffi with impersonate="chrome" to mimic real browser TLS handshakes
(JA3/JA4 fingerprints) at the network socket layer. This bypasses Cloudflare's
bot detection without spinning up a browser — uses <50MB RAM.
"""

import asyncio
from typing import Optional, Dict, Any
from curl_cffi import requests as cffi_requests

# Random browser UAs for variety
USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
]

import random

def get_ua() -> str:
    return random.choice(USER_AGENTS)


def _do_request(
    url: str,
    method: str = "GET",
    headers: Optional[Dict[str, str]] = None,
    timeout: int = 10,
    allow_redirects: bool = True,
) -> Optional[str]:
    """Synchronous request using curl_cffi with Chrome impersonation."""
    try:
        req_headers = {
            "User-Agent": get_ua(),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Referer": "https://google.com",
        }
        if headers:
            req_headers.update(headers)

        # impersonate="chrome" mimics Chrome's TLS fingerprint — bypasses CF
        response = cffi_requests.request(
            method,
            url,
            headers=req_headers,
            timeout=timeout,
            allow_redirects=allow_redirects,
            impersonate="chrome",
            verify=False,
        )

        if response.status_code == 200:
            return response.text
        return None
    except Exception as e:
        print(f"[http] {method} {url[:60]} failed: {e}")
        return None


def fetch_html(url: str, headers: Optional[Dict] = None, timeout: int = 8) -> Optional[str]:
    """Fetch HTML content using curl_cffi with Chrome impersonation."""
    return _do_request(url, "GET", headers, timeout)


def fetch_json_sync(url: str, headers: Optional[Dict] = None, timeout: int = 8) -> Optional[Any]:
    """Fetch and parse JSON using curl_cffi."""
    import json
    text = _do_request(url, "GET", {**(headers or {}), "Accept": "application/json"}, timeout)
    if text:
        try:
            return json.loads(text)
        except:
            return None
    return None


async def fetch_html_async(url: str, headers: Optional[Dict] = None, timeout: int = 8) -> Optional[str]:
    """Async wrapper for fetch_html — runs in thread pool to not block event loop."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, fetch_html, url, headers, timeout)


async def fetch_json_async(url: str, headers: Optional[Dict] = None, timeout: int = 8) -> Optional[Any]:
    """Async wrapper for fetch_json_sync."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, fetch_json_sync, url, headers, timeout)
