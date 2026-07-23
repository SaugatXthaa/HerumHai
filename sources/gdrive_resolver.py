"""
sources/gdrive_resolver.py — Google Drive / GDTot / GDFlix stream resolver.

Resolves GDrive links from WordPress detail pages by:
1. Extracting GDrive file IDs from HTML (direct links, viewer links, atob obfuscated)
2. Extracting GDTot/GDFlix file tokens and resolving via ScraperAPI
3. Converting all file IDs to direct download URLs for Stremio playback
"""

import re
from typing import List, Dict
from utils.http_client import fetch_html, extract_gdrive_links, convert_gdrive_to_direct

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"


def extract_all_file_hosts(html: str) -> List[Dict]:
    """
    Extract ALL file host links from a detail page HTML.
    Returns list of {type, id, url} dicts.
    """
    results = []

    # 1. Google Drive direct links
    for fid in re.findall(r"drive\.google\.com/(?:uc\?export=download&id=|file/d/)([a-zA-Z0-9_-]+)", html, re.IGNORECASE):
        results.append({"type": "gdrive", "id": fid, "url": convert_gdrive_to_direct(fid)})

    # 2. GDTot links
    for match in re.findall(r"(https?://(?:www\.)?gdtot\.[a-z]+/file/[a-zA-Z0-9_-]+)", html, re.IGNORECASE):
        results.append({"type": "gdtot", "id": match.split("/")[-1], "url": match})

    # 3. GDFlix links
    for match in re.findall(r"(https?://(?:www\.)?gdflix\.[a-z]+/file/[a-zA-Z0-9_-]+)", html, re.IGNORECASE):
        results.append({"type": "gdflix", "id": match.split("/")[-1], "url": match})

    # 4. atob/base64 obfuscated GDrive links (GDFlix pattern)
    for b64 in re.findall(r"atob\s*\(\s*['\"]([A-Za-z0-9+/={}\s]+)['\"]\s*\)", html):
        import base64
        try:
            decoded = base64.b64decode(b64).decode('utf-8')
            for fid in re.findall(r"drive\.google\.com/(?:uc\?export=download&id=|file/d/)([a-zA-Z0-9_-]+)", decoded, re.IGNORECASE):
                results.append({"type": "gdrive", "id": fid, "url": convert_gdrive_to_direct(fid)})
        except:
            pass

    # 5. HubCloud IDs (existing resolver handles these)
    for fid in re.findall(r"hubcloud\.(?:ist|cx|club|fans)/drive/([a-zA-Z0-9_-]+)", html, re.IGNORECASE):
        results.append({"type": "hubcloud", "id": fid, "url": ""})

    # 6. UnblockedGames SIDs
    for sid in re.findall(r"cloud\.unblockedgames\.world/\?sid=([A-Za-z0-9+/=_]+)", html, re.IGNORECASE):
        results.append({"type": "unblockedgames", "id": sid, "url": ""})

    # 7. Pixeldrain links
    for match in re.findall(r"(https?://pixeldrain\.(?:dev|com)/[a-z]+/[a-zA-Z0-9]+)", html, re.IGNORECASE):
        results.append({"type": "pixeldrain", "id": match.split("/")[-1], "url": match})

    # 8. Direct video URLs (.mkv, .mp4, .m3u8)
    for url in re.findall(r'(https?://[^\s"\'<>]+\.(?:mkv|mp4|m3u8)[^\s"\'<>]*)', html, re.IGNORECASE):
        # Skip ad/trailer URLs
        if not any(x in url.lower() for x in ["vidverto", "2mdn", "googlesyndication", "trailer", "sample"]):
            results.append({"type": "direct", "id": "", "url": url})

    # 9. workers.dev URLs (Cloudflare CDN)
    for url in re.findall(r'(https?://[a-z0-9-]+\.workers\.dev/[^\s"\'<>]+)', html, re.IGNORECASE):
        results.append({"type": "workers", "id": "", "url": url})

    # Dedupe by URL
    seen = set()
    unique = []
    for r in results:
        key = r["url"] or r["id"]
        if key not in seen:
            seen.add(key)
            unique.append(r)

    return unique


def resolve_file_host(file_info: Dict, title: str, source_name: str) -> List[Dict]:
    """
    Resolve a file host entry to a Stremio stream object.
    Handles GDrive, GDTot, GDFlix, HubCloud, UnblockedGames, direct URLs.
    """
    from sources.hubcloud_resolver import resolve_hubcloud_id, resolve_unblockedgames_sid

    streams = []
    ftype = file_info["type"]

    if ftype == "gdrive":
        # Direct GDrive download URL — Stremio can play with proxyHeaders
        file_id = file_info["id"]
        url = file_info["url"]
        streams.append({
            "name": f"HerumHai · {source_name} · GDrive",
            "title": f"HerumHai · {source_name}\nFile: {file_id[:20]}...\nTitle: {title}",
            "description": f"Source: {source_name} (Google Drive)\nFile ID: {file_id}\nTitle: {title}",
            "url": url,
            "source": source_name.lower().replace(" ", ""),
            "behaviorHints": {
                "notWebReady": True,
                "filename": f"{title}.mkv",
                "proxyHeaders": {"request": {"User-Agent": UA}},
                "bingeGroup": f"herumhai-gdrive-{file_id[:10]}",
            },
        })

    elif ftype == "gdtot" or ftype == "gdflix":
        # Resolve GDTot/GDFlix → GDrive file ID
        host_url = file_info["url"]
        # Fetch the GDTot/GDFlix page (via ScraperAPI if configured)
        html = fetch_html(host_url, timeout=10)
        if html:
            file_ids = extract_gdrive_links(html)
            for fid in file_ids[:2]:
                url = convert_gdrive_to_direct(fid)
                streams.append({
                    "name": f"HerumHai · {source_name} · {ftype.upper()}",
                    "title": f"HerumHai · {source_name}\nFile: {fid[:20]}...\nTitle: {title}",
                    "description": f"Source: {source_name} ({ftype.upper()} → GDrive)\nFile ID: {fid}\nTitle: {title}",
                    "url": url,
                    "source": source_name.lower().replace(" ", ""),
                    "behaviorHints": {
                        "notWebReady": True,
                        "filename": f"{title}.mkv",
                        "proxyHeaders": {"request": {"User-Agent": UA}},
                        "bingeGroup": f"herumhai-{ftype}-{fid[:10]}",
                    },
                })

    elif ftype == "hubcloud":
        # Resolve HubCloud → workers.dev CDN
        result = resolve_hubcloud_id(file_info["id"])
        if result:
            url = result["url"]
            filename = result["filename"]
            # Parse metadata from filename
            meta_parts = []
            if re.search(r"2160p|4k|uhd", filename, re.IGNORECASE):
                meta_parts.append("4K")
            elif re.search(r"1080p", filename, re.IGNORECASE):
                meta_parts.append("1080p")
            if re.search(r"remux", filename, re.IGNORECASE):
                meta_parts.append("REMUX")
            elif re.search(r"bluray", filename, re.IGNORECASE):
                meta_parts.append("BluRay")

            streams.append({
                "name": f"HerumHai · {source_name}" + (" · " + " · ".join(meta_parts) if meta_parts else ""),
                "title": f"HerumHai · {source_name}\nFile: {filename}\nTitle: {title}",
                "description": f"Source: {source_name} (HubCloud)\nFile: {filename}\nTitle: {title}",
                "url": url,
                "source": source_name.lower().replace(" ", ""),
                "behaviorHints": {
                    "notWebReady": True,
                    "filename": filename,
                    "proxyHeaders": {"request": {"User-Agent": UA, "Referer": "https://hubcloud.cx/"}},
                    "bingeGroup": f"herumhai-hubcloud-{file_info['id'][:10]}",
                },
            })

    elif ftype == "direct" or ftype == "workers" or ftype == "pixeldrain":
        # Direct video URL — play as-is
        url = file_info["url"]
        filename = url.split("/")[-1].split("?")[0]
        streams.append({
            "name": f"HerumHai · {source_name}",
            "title": f"HerumHai · {source_name}\nFile: {filename}\nTitle: {title}",
            "description": f"Source: {source_name}\nURL: {url}\nTitle: {title}",
            "url": url,
            "source": source_name.lower().replace(" ", ""),
            "behaviorHints": {
                "notWebReady": True,
                "filename": filename,
                "proxyHeaders": {"request": {"User-Agent": UA}},
                "bingeGroup": f"herumhai-direct-{filename[:10]}",
            },
        })

    return streams


def resolve_all_from_html(html: str, title: str, source_name: str, source_id: str) -> List[Dict]:
    """
    Extract and resolve ALL file host links from a detail page HTML.
    This is the main entry point — handles ALL file host types.
    """
    file_hosts = extract_all_file_hosts(html)
    all_streams = []

    for fh in file_hosts[:5]:  # Max 5 to keep response fast
        try:
            streams = resolve_file_host(fh, title, source_name)
            all_streams.extend(streams)
        except:
            continue

    return all_streams
