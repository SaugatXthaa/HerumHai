"""
utils/stream_filter.py — Filter out ads, trailers, tutorials, and files < 80MB.
"""

import re
from typing import List, Dict, Any

MIN_SIZE_BYTES = 80 * 1024 * 1024  # 80MB

REJECT_NAMES = [
    r"donation", r"donate", r"support\s+us", r"premium", r"upgrade",
    r"tutorial", r"how\s+to\s+download", r"how\s+to\s+watch",
    r"guide", r"readme", r"instructions",
    r"trailer", r"teaser", r"sample", r"preview", r"demo",
    r"advertisement", r"sponsor", r"promo",
    r"sign\s+in", r"sign\s+up", r"login", r"register",
    r"subscribe", r"membership", r"pricing",
    r"coming\s+soon", r"not\s+available", r"error",
    r"placeholder", r"loading", r"spinner",
]

REJECT_URLS = [
    r"/login", r"/signin", r"/register", r"/signup",
    r"/donation", r"/donate", r"/premium", r"/upgrade",
    r"/subscribe", r"/pricing",
    r"\.html$", r"/about", r"/contact", r"/privacy", r"/terms",
    r"/category/", r"/tag/", r"/page/", r"/feed",
    r"googleads", r"doubleclick", r"googlesyndication",
    r"facebook\.com", r"twitter\.com", r"instagram\.com",
    r"youtube\.com/watch", r"youtu\.be",
]

VIDEO_PATTERNS = [
    r"\.m3u8", r"\.mp4", r"\.mkv", r"\.ts\b", r"\.mov", r"\.avi", r"\.webm",
    r"/video/", r"/stream/", r"/hls/", r"/playlist", r"/cdn/",
    r"workers\.dev", r"pixeldrain", r"fsl-buckets", r"hubcloud",
    r"googleusercontent", r"hub\.latent", r"r2\.dev", r"savefiles",
    r"111477", r"cloudserver",
]


def parse_size(text: str) -> int:
    """Parse file size from text, returns bytes or 0 if not found."""
    if not text:
        return 0
    m = re.search(r"(\d+(?:\.\d+)?)\s*(GB|MB|TB|KB)", str(text), re.IGNORECASE)
    if not m:
        return 0
    val = float(m.group(1))
    unit = m.group(2).upper()
    if unit == "TB":
        return int(val * 1024**4)
    elif unit == "GB":
        return int(val * 1024**3)
    elif unit == "MB":
        return int(val * 1024**2)
    elif unit == "KB":
        return int(val * 1024)
    return 0


def should_reject(stream: Dict[str, Any]) -> bool:
    """Check if a stream should be rejected (ad, tutorial, small file, etc.)."""
    if not stream or not stream.get("url"):
        return True
    url = stream["url"]
    if not url.startswith("http"):
        return True

    # Reject torrents
    if stream.get("infoHash"):
        return True

    name = (stream.get("name") or "").lower()
    title = (stream.get("title") or "").lower()
    desc = (stream.get("description") or "").lower()
    url_lower = url.lower()
    bh = stream.get("behaviorHints") or {}
    filename = (bh.get("filename") or "").lower()

    # Check reject patterns
    for pattern in REJECT_NAMES:
        if re.search(pattern, name) or re.search(pattern, title):
            return True

    for pattern in REJECT_URLS:
        if re.search(pattern, url_lower):
            return True

    # Size check
    size = bh.get("videoSize") or 0
    if not size:
        size = parse_size(desc) or parse_size(filename) or parse_size(title)
    if size and size < MIN_SIZE_BYTES:
        return True

    # Must look like a video URL
    is_video = any(re.search(p, url_lower) for p in VIDEO_PATTERNS)
    if not is_video and size == 0:
        return True

    return False


def filter_streams(streams: List[Dict]) -> List[Dict]:
    """Filter out ads, trailers, tutorials, and small files."""
    if not streams:
        return []
    return [s for s in streams if not should_reject(s)]
