"""
utils/metadata.py — Resolve Stremio IDs to title + year via Cinemeta/Kitsu APIs.
"""

from typing import Optional, Dict
from utils.http_client import fetch_json_sync

_meta_cache: Dict[str, dict] = {}


def resolve_meta(imdb_id: str, media_type: str) -> Optional[dict]:
    """Resolve title and year from IMDB/kitsu ID."""
    if not imdb_id:
        return None

    cache_key = f"{imdb_id}:{media_type}"
    if cache_key in _meta_cache:
        return _meta_cache[cache_key]

    result = None
    try:
        if imdb_id.startswith("kitsu:"):
            kid = imdb_id.replace("kitsu:", "")
            data = fetch_json_sync(f"https://kitsu.app/api/edge/anime/{kid}", timeout=4)
            if data and "data" in data:
                attrs = data["data"].get("attributes", {})
                sd = attrs.get("startDate", "")
                result = {
                    "name": attrs.get("canonicalTitle", ""),
                    "year": sd[:4] if sd else "",
                }
        else:
            ct = "movie" if media_type == "movie" else "series"
            data = fetch_json_sync(f"https://v3-cinemeta.strem.io/meta/{ct}/{imdb_id}.json", timeout=4)
            if data and "meta" in data:
                m = data["meta"]
                result = {
                    "name": m.get("name", ""),
                    "year": str(m.get("year", ""))[:4] if m.get("year") else "",
                }
    except Exception as e:
        print(f"[metadata] failed for {imdb_id}: {e}")

    if result:
        _meta_cache[cache_key] = result
    return result


def parse_stremio_id(raw_id: str) -> dict:
    """Parse a Stremio ID into components."""
    if not raw_id:
        return {"imdb_id": None, "kitsu_id": None, "season": None, "episode": None}

    clean = raw_id.replace(".json", "")

    for prefix in ["kitsu", "mal", "tvdb", "tmdb"]:
        if clean.startswith(f"{prefix}:"):
            parts = clean[len(prefix) + 1 :].split(":")
            return {
                "imdb_id": None,
                "kitsu_id": parts[0] if prefix == "kitsu" else None,
                "season": int(parts[1]) if len(parts) >= 3 and parts[1].isdigit() else None,
                "episode": int(parts[2]) if len(parts) >= 3 and parts[2].isdigit() else None,
            }

    parts = clean.split(":")
    return {
        "imdb_id": parts[0],
        "kitsu_id": None,
        "season": int(parts[1]) if len(parts) >= 3 and parts[1].isdigit() else None,
        "episode": int(parts[2]) if len(parts) >= 3 and parts[2].isdigit() else None,
    }
