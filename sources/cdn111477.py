"""
sources/cdn111477.py — 111477 CDN directory listing scraper.

Scrapes the public directory listing at a.111477.xyz to find direct MKV/MP4 files.
The directory listing is NOT Cloudflare-blocked — we can scrape it directly.
File URLs return 307 redirects to p.111477.xyz/bulk (CF-protected from server),
but Stremio's player follows the redirect from the user's residential IP.
"""

import re
import urllib.parse
from typing import List, Dict, Any
from utils.http_client import fetch_html

CDN_BASE = "https://a.111477.xyz"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
MIN_SIZE = 80 * 1024 * 1024


def _parse_files(html: str) -> List[Dict]:
    """Extract MKV/MP4 file links + sizes from directory listing HTML."""
    if not html:
        return []

    files = []
    seen = set()

    for m in re.finditer(r'href="([^"]+\.(?:mkv|mp4|avi|mov))"', html, re.IGNORECASE):
        href = m.group(1)
        if href in seen:
            continue
        seen.add(href)

        filename = href.split("/")[-1]
        try:
            filename = urllib.parse.unquote(filename)
        except:
            pass

        full_url = href if href.startswith("http") else f"{CDN_BASE}{href}"
        files.append({"href": full_url, "filename": filename, "size_text": "", "size_bytes": 0})

    # Extract sizes
    sizes = []
    for m in re.finditer(r"([0-9]+(?:\.[0-9]+)?)\s*(GB|MB|TB|KB)", html, re.IGNORECASE):
        val = float(m.group(1))
        unit = m.group(2).upper()
        if unit == "TB":
            b = int(val * 1024**4)
        elif unit == "GB":
            b = int(val * 1024**3)
        elif unit == "MB":
            b = int(val * 1024**2)
        else:
            b = int(val * 1024)
        sizes.append({"text": f"{val} {unit}", "bytes": b})

    for i in range(min(len(files), len(sizes))):
        files[i]["size_text"] = sizes[i]["text"]
        files[i]["size_bytes"] = sizes[i]["bytes"]

    return files


def _get_meta(text: str) -> Dict[str, str]:
    """Extract metadata from filename."""
    t = str(text)
    meta = {}
    if re.search(r"\b(?:2160p|4k|uhd)\b", t, re.IGNORECASE):
        meta["resolution"] = "4K"
    elif re.search(r"\b1080p\b", t, re.IGNORECASE):
        meta["resolution"] = "1080p"
    elif re.search(r"\b720p\b", t, re.IGNORECASE):
        meta["resolution"] = "720p"
    elif re.search(r"\b480p\b", t, re.IGNORECASE):
        meta["resolution"] = "480p"

    if re.search(r"remux", t, re.IGNORECASE):
        meta["quality"] = "REMUX"
    elif re.search(r"bluray|blu-ray", t, re.IGNORECASE):
        meta["quality"] = "BluRay"
    elif re.search(r"web-?dl", t, re.IGNORECASE):
        meta["quality"] = "WEB-DL"

    if re.search(r"x265|hevc", t, re.IGNORECASE):
        meta["codec"] = "HEVC"
    elif re.search(r"x264|h\.?264", t, re.IGNORECASE):
        meta["codec"] = "AVC"

    if re.search(r"10bit", t, re.IGNORECASE):
        meta["bit_depth"] = "10bit"

    if re.search(r"dolby.?vision|\bdv\b", t, re.IGNORECASE):
        meta["hdr"] = "DV"
    elif re.search(r"hdr", t, re.IGNORECASE):
        meta["hdr"] = "HDR"

    langs = []
    if re.search(r"hindi", t, re.IGNORECASE):
        langs.append("Hindi")
    if re.search(r"english|eng", t, re.IGNORECASE):
        langs.append("English")
    if re.search(r"tamil", t, re.IGNORECASE):
        langs.append("Tamil")
    if re.search(r"telugu", t, re.IGNORECASE):
        langs.append("Telugu")
    if re.search(r"korean|kor", t, re.IGNORECASE):
        langs.append("Korean")
    if langs:
        meta["language"] = " · ".join(langs)

    return meta


def _build_stream(file: Dict, title: str, src: str) -> Dict[str, Any]:
    """Build a Stremio stream object."""
    m = _get_meta(f"{file['filename']} {title}")
    parts = [f"HerumHai · {src}"]
    if m.get("resolution"):
        parts.append(m["resolution"])
    if m.get("quality"):
        parts.append(m["quality"])
    if m.get("codec"):
        parts.append(m["codec"])
    if m.get("hdr"):
        parts.append(m["hdr"])
    name = " · ".join(parts)

    desc_parts = [f"Source: {src}", f"File: {file['filename']}", f"Title: {title}"]
    if m.get("resolution"):
        desc_parts.append(f"Resolution: {m['resolution']}")
    if m.get("quality"):
        desc_parts.append(f"Quality: {m['quality']}")
    if m.get("language"):
        desc_parts.append(f"Language: {m['language']}")
    if file.get("size_text"):
        desc_parts.append(f"Size: {file['size_text']}")

    bh = {
        "notWebReady": True,
        "filename": file["filename"],
        "proxyHeaders": {"request": {"User-Agent": UA, "Referer": f"{CDN_BASE}/"}},
        "bingeGroup": f"herumhai-111477-{file['filename'][:20]}",
    }
    if file.get("size_bytes"):
        bh["videoSize"] = file["size_bytes"]

    return {
        "name": name,
        "title": name,
        "description": "\n".join(desc_parts),
        "url": file["href"],
        "source": "cdn111477",
        "behaviorHints": bh,
    }


def _is_valid(f: Dict) -> bool:
    """Check if file is valid (>=80MB, not trailer/sample)."""
    if f.get("size_bytes") and f["size_bytes"] < MIN_SIZE:
        return False
    fn = (f.get("filename") or "").lower()
    return not any(x in fn for x in ["trailer", "sample", "preview", "tutorial"])


def _parse_title_and_year(title: str) -> tuple:
    """Parse title and year — returns (clean_title, year)."""
    if not title:
        return ("", "")
    m = re.match(r"^(.+?)\s*\(?(\d{4})\)?\s*$", title)
    if m:
        return (m.group(1).strip(), m.group(2))
    return (title.strip(), "")


def scrape(target: Dict, title: str) -> List[Dict]:
    """Main scrape function — routes to movie/series handler."""
    try:
        if target.get("type") == "movie":
            return _scrape_movie(target, title)
        else:
            return _scrape_series(target, title)
    except Exception as e:
        print(f"[cdn111477] error: {e}")
        return []


def _scrape_movie(target: Dict, title: str) -> List[Dict]:
    if not title:
        return []
    clean, year = _parse_title_and_year(title)
    if not clean:
        return []

    # CDN uses "Title (Year)" format with parens
    formats = [f"{clean} ({year})" if year else clean, clean]

    for fmt in formats:
        encoded = urllib.parse.quote(fmt)
        url = f"{CDN_BASE}/movies/{encoded}/"
        print(f"[cdn111477] trying: {url[:80]}")
        html = fetch_html(url)
        if not html:
            continue
        files = _parse_files(html)
        if not files:
            continue
        print(f"[cdn111477] found {len(files)} files for '{fmt}'")
        valid = [f for f in files if _is_valid(f)]
        return [_build_stream(f, title, "111477") for f in valid[:15]]

    return []


def _scrape_series(target: Dict, title: str) -> List[Dict]:
    if not title:
        return []
    clean, _ = _parse_title_and_year(title)
    if not clean:
        return []

    season = target.get("season") or 1
    episode = target.get("episode")

    encoded = urllib.parse.quote(clean)
    url = f"{CDN_BASE}/tvs/{encoded}/Season%20{season}/"
    print(f"[cdn111477] series: {url[:80]}")
    html = fetch_html(url)
    if not html:
        return []

    files = _parse_files(html)
    if not files:
        return []
    print(f"[cdn111477] found {len(files)} episode files")

    # Filter for specific episode
    if episode:
        ep_pattern = re.compile(f"S0?{season}E0?{episode}", re.IGNORECASE)
        ep_files = [f for f in files if ep_pattern.search(f["filename"])]
    else:
        ep_files = files

    if not ep_files:
        return []

    valid = [f for f in ep_files if _is_valid(f)]
    ep_title = f"{title} S{season}E{episode or 1}"
    return [_build_stream(f, ep_title, "111477") for f in valid[:10]]
