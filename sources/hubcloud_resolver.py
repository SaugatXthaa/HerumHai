"""
sources/hubcloud_resolver.py — Multi-host resolver for HubCloud + UnblockedGames.

HubCloud chain: hubcloud.cx/drive/ID → sportverse.cc → workers.dev CDN URL
UnblockedGames chain: cloud.unblockedgames.world/?sid=BASE64 → POST → CDN URL
"""

import re
import base64
from typing import List, Dict, Optional
from utils.http_client import fetch_html

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
HUBCLOUD_DOMAINS = ["hubcloud.cx", "hubcloud.ist", "hubcloud.club", "hubcloud.fans"]


def extract_hubcloud_ids(html: str) -> List[str]:
    if not html:
        return []
    ids = set()
    for m in re.finditer(r"hubcloud\.(?:ist|cx|club|fans)/drive/([a-zA-Z0-9_-]+)", html, re.IGNORECASE):
        ids.add(m.group(1))
    return list(ids)


def extract_unblockedgames_sids(html: str) -> List[str]:
    """Extract cloud.unblockedgames.world/?sid=BASE64 IDs from HTML."""
    if not html:
        return []
    sids = set()
    for m in re.finditer(r"cloud\.unblockedgames\.world/\?sid=([A-Za-z0-9+/=_]+)", html, re.IGNORECASE):
        sids.add(m.group(1))
    return list(sids)


def extract_direct_video_urls(html: str) -> List[str]:
    """Extract direct .m3u8/.mp4/.mkv URLs from HTML."""
    if not html:
        return []
    urls = set()
    for m in re.finditer(r'(https?://[^\s"\'<>]+\.m3u8[^\s"\'<>]*)', html, re.IGNORECASE):
        urls.add(m.group(1))
    for m in re.finditer(r'(https?://[^\s"\'<>]+\.mp4[^\s"\'<>]*)', html, re.IGNORECASE):
        urls.add(m.group(1))
    for m in re.finditer(r'(https?://[^\s"\'<>]+\.mkv[^\s"\'<>]*)', html, re.IGNORECASE):
        urls.add(m.group(1))
    for m in re.finditer(r'"file"\s*:\s*"(https?://[^"]+)"', html, re.IGNORECASE):
        if ".m3u8" in m.group(1) or ".mp4" in m.group(1):
            urls.add(m.group(1))
    return list(urls)


def resolve_hubcloud_id(hc_id: str) -> Optional[Dict]:
    """Resolve HubCloud ID → sportverse.cc → workers.dev CDN URL."""
    sportverse_url = None
    for domain in HUBCLOUD_DOMAINS:
        try:
            url = f"https://{domain}/drive/{hc_id}"
            html = fetch_html(url)
            if html:
                m = re.search(r"var url = '([^']+)'", html)
                if m:
                    sportverse_url = m.group(1)
                    break
        except:
            continue

    if not sportverse_url:
        return None

    try:
        html = fetch_html(sportverse_url, headers={'Referer': 'https://hubcloud.cx/'})
        if not html:
            return None
            return None

        matches = re.findall(
            r"https?://[a-z0-9-]+(?:\.[a-z0-9-]+)*\.workers\.dev/[^\"'<>\s]+(?:\s[^\"'<>]+)*",
            html, re.IGNORECASE
        )
        if not matches:
            return None

        cdn_url = matches[0].replace(" ", "%20").replace("[", "%5B").replace("]", "%5D")
        cdn_url = cdn_url.replace("(", "%28").replace(")", "%29")

        filename = ""
        try:
            from urllib.parse import unquote, urlparse
            filename = unquote(urlparse(cdn_url).path.split("/")[-1])
        except:
            pass

        return {"url": cdn_url, "filename": filename}
    except:
        return None


def resolve_unblockedgames_sid(sid: str) -> Optional[Dict]:
    """Resolve cloud.unblockedgames.world/?sid=BASE64 → direct video URL."""
    try:
        # Step 1: Decode the SID to find the target URL
        try:
            decoded = base64.b64decode(sid).decode("utf-8")
            if not decoded.startswith("http"):
                return None
        except:
            return None

        # Step 2: The SID is actually a redirect — fetch the unblockedgames page
        url = f"https://cloud.unblockedgames.world/?sid={sid}"
        html = fetch_html(url)
        if not html:
            return None

        # The page POSTs to itself with the SID to get the actual download URL
        # Try POST
        # For POST, use curl_cffi directly (Scrapling doesn't support POST well)
        from curl_cffi import requests as _cffi
        r2 = _cffi.post("https://cloud.unblockedgames.world/", data=f"_wp_http={sid}",
                       headers={"User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded",
                                "Referer": url},
                       timeout=8, impersonate="chrome", verify=False)

        if r2.status_code == 200:
            # Look for direct video URLs in the response
            video_urls = extract_direct_video_urls(r2.text)
            # Also look for workers.dev URLs
            workers_urls = re.findall(r"https?://[a-z0-9-]+\.workers\.dev/[^\s\"'<>]+", r2.text, re.IGNORECASE)
            all_urls = video_urls + workers_urls

            if all_urls:
                # Filter out non-video URLs
                video_url = None
                for u in all_urls:
                    if any(ext in u.lower() for ext in [".mkv", ".mp4", ".m3u8", "workers.dev"]):
                        video_url = u.replace(" ", "%20")
                        break

                if video_url:
                    filename = ""
                    try:
                        from urllib.parse import unquote, urlparse
                        filename = unquote(urlparse(video_url).path.split("/")[-1])
                    except:
                        pass
                    return {"url": video_url, "filename": filename}

        return None
    except:
        return None


def resolve_streams_from_html(html: str, title: str, source_name: str, source_id: str) -> List[Dict]:
    """
    Extract ALL stream URLs from a detail page HTML.
    Handles HubCloud IDs, UnblockedGames SIDs, and direct video URLs.
    """
    from utils.stream_filter import parse_size

    streams = []

    # 1. HubCloud IDs
    hc_ids = extract_hubcloud_ids(html)
    for hc_id in hc_ids[:3]:
        result = resolve_hubcloud_id(hc_id)
        if result:
            url = result["url"]
            filename = result["filename"]
            size_bytes = parse_size(filename)

            name_parts = [f"HerumHai · {source_name}"]
            if re.search(r"2160p|4k|uhd", filename, re.IGNORECASE):
                name_parts.append("4K")
            elif re.search(r"1080p", filename, re.IGNORECASE):
                name_parts.append("1080p")
            elif re.search(r"720p", filename, re.IGNORECASE):
                name_parts.append("720p")
            if re.search(r"remux", filename, re.IGNORECASE):
                name_parts.append("REMUX")
            elif re.search(r"bluray", filename, re.IGNORECASE):
                name_parts.append("BluRay")
            if re.search(r"x265|hevc", filename, re.IGNORECASE):
                name_parts.append("HEVC")

            bh = {
                "notWebReady": True, "filename": filename,
                "proxyHeaders": {"request": {"User-Agent": UA, "Referer": "https://hubcloud.cx/"}},
                "bingeGroup": f"herumhai-{source_id}-{hc_id}",
            }
            if size_bytes:
                bh["videoSize"] = size_bytes

            streams.append({
                "name": " · ".join(name_parts), "title": " · ".join(name_parts),
                "description": f"Source: {source_name}\nFile: {filename}\nTitle: {title}",
                "url": url, "source": source_id, "behaviorHints": bh,
            })

    # 2. UnblockedGames SIDs (uhdmovies pattern)
    sids = extract_unblockedgames_sids(html)
    for sid in sids[:3]:
        result = resolve_unblockedgames_sid(sid)
        if result:
            url = result["url"]
            filename = result["filename"]
            size_bytes = parse_size(filename)

            name_parts = [f"HerumHai · {source_name}"]
            if re.search(r"2160p|4k|uhd", filename, re.IGNORECASE):
                name_parts.append("4K")
            elif re.search(r"1080p", filename, re.IGNORECASE):
                name_parts.append("1080p")

            bh = {
                "notWebReady": True, "filename": filename,
                "proxyHeaders": {"request": {"User-Agent": UA, "Referer": "https://cloud.unblockedgames.world/"}},
                "bingeGroup": f"herumhai-{source_id}-{sid[:10]}",
            }
            if size_bytes:
                bh["videoSize"] = size_bytes

            streams.append({
                "name": " · ".join(name_parts), "title": " · ".join(name_parts),
                "description": f"Source: {source_name}\nFile: {filename}\nTitle: {title}",
                "url": url, "source": source_id, "behaviorHints": bh,
            })

    # 3. Direct video URLs (m3u8/mp4/mkv in HTML)
    direct_urls = extract_direct_video_urls(html)
    for url in direct_urls[:3]:
        if "workers.dev" in url or ".mkv" in url or ".mp4" in url or ".m3u8" in url:
            filename = url.split("/")[-1].split("?")[0]
            name_parts = [f"HerumHai · {source_name}"]
            if re.search(r"2160p|4k|uhd", filename, re.IGNORECASE):
                name_parts.append("4K")
            elif re.search(r"1080p", filename, re.IGNORECASE):
                name_parts.append("1080p")

            streams.append({
                "name": " · ".join(name_parts), "title": " · ".join(name_parts),
                "description": f"Source: {source_name}\nFile: {filename}\nTitle: {title}",
                "url": url, "source": source_id,
                "behaviorHints": {"notWebReady": True, "filename": filename},
            })

    return streams


def resolve_hubcloud_streams(hc_ids: List[str], title: str, source_name: str) -> List[Dict]:
    """Legacy compatibility — resolve HubCloud IDs only."""
    streams = []
    for hc_id in hc_ids[:3]:
        result = resolve_hubcloud_id(hc_id)
        if not result:
            continue

        url = result["url"]
        filename = result["filename"]
        from utils.stream_filter import parse_size
        size_bytes = parse_size(filename)

        name_parts = [f"HerumHai · {source_name}"]
        if re.search(r"2160p|4k|uhd", filename, re.IGNORECASE):
            name_parts.append("4K")
        elif re.search(r"1080p", filename, re.IGNORECASE):
            name_parts.append("1080p")
        elif re.search(r"720p", filename, re.IGNORECASE):
            name_parts.append("720p")
        if re.search(r"remux", filename, re.IGNORECASE):
            name_parts.append("REMUX")
        elif re.search(r"bluray", filename, re.IGNORECASE):
            name_parts.append("BluRay")
        if re.search(r"x265|hevc", filename, re.IGNORECASE):
            name_parts.append("HEVC")

        bh = {
            "notWebReady": True, "filename": filename,
            "proxyHeaders": {"request": {"User-Agent": UA, "Referer": "https://hubcloud.cx/"}},
            "bingeGroup": f"herumhai-{source_name.lower()}-{hc_id}",
        }
        if size_bytes:
            bh["videoSize"] = size_bytes

        streams.append({
            "name": " · ".join(name_parts), "title": " · ".join(name_parts),
            "description": f"Source: {source_name}\nFile: {filename}\nTitle: {title}",
            "url": url, "source": source_name.lower().replace(" ", ""), "behaviorHints": bh,
        })

    return streams
