"""
utils/metadata.py — Cinemeta + Kitsu + series episode formatting.

Resolves Stremio IDs to title + year, and formats series queries
(S02E05, Season 2, S02) for search engines.
"""

import re
from typing import Optional, Dict, List
from utils.http_client import fetch_json

_meta_cache: Dict[str, dict] = {}


def resolve_meta(imdb_id: str, media_type: str) -> Optional[dict]:
    if not imdb_id:
        return None
    cache_key = f"{imdb_id}:{media_type}"
    if cache_key in _meta_cache:
        return _meta_cache[cache_key]
    result = None
    try:
        if imdb_id.startswith("kitsu:"):
            kid = imdb_id.replace("kitsu:", "")
            data = fetch_json(f"https://kitsu.app/api/edge/anime/{kid}", timeout=4)
            if data and "data" in data:
                attrs = data["data"].get("attributes", {})
                sd = attrs.get("startDate", "")
                result = {"name": attrs.get("canonicalTitle", ""), "year": sd[:4] if sd else ""}
        else:
            ct = "movie" if media_type == "movie" else "series"
            data = fetch_json(f"https://v3-cinemeta.strem.io/meta/{ct}/{imdb_id}.json", timeout=4)
            if data and "meta" in data:
                m = data["meta"]
                result = {"name": m.get("name", ""), "year": str(m.get("year", ""))[:4] if m.get("year") else ""}
    except Exception as e:
        print(f"[metadata] failed for {imdb_id}: {e}")
    if result:
        _meta_cache[cache_key] = result
    return result


def resolve_tmdb_id(imdb_id: str, media_type: str, title: str) -> Optional[str]:
    TMDB_KEY = "f894b4342dfe25ee2ca3ee30b552e16f"
    kind = "movie" if media_type == "movie" else "tv"
    try:
        if imdb_id and not imdb_id.startswith("kitsu:") and not imdb_id.startswith("tmdb:"):
            data = fetch_json(f"https://api.themoviedb.org/3/find/{imdb_id}?api_key={TMDB_KEY}&external_source=imdb_id", timeout=5)
            if data:
                arr = data.get(f"{kind}_results", [])
                if arr and arr[0].get("id"):
                    return str(arr[0]["id"])
        if title:
            clean = re.sub(r"\s+\d{4}$", "", title).strip()
            data = fetch_json(f"https://api.themoviedb.org/3/search/{kind}?api_key={TMDB_KEY}&query={clean}", timeout=5)
            if data and data.get("results") and data["results"][0].get("id"):
                return str(data["results"][0]["id"])
    except:
        pass
    return None


def format_series_query(title: str, year: str, season: int, episode: int) -> Dict[str, str]:
    """Format series search queries for GDrive/GDTot/GDFlix trackers."""
    clean_title = re.sub(r"[^a-zA-Z0-9 ]", "", title)
    s_pad = str(season).zfill(2)
    e_pad = str(episode).zfill(2)
    return {
        "strict": f"{clean_title} S{s_pad}E{e_pad}",
        "season": f"{clean_title} Season {season}",
        "short": f"{clean_title} S{s_pad}",
        "fallback": f"{clean_title} {year}" if year else clean_title,
    }


def parse_stremio_id(raw_id: str) -> dict:
    if not raw_id:
        return {"imdb_id": None, "kitsu_id": None, "season": None, "episode": None}
    clean = raw_id.replace(".json", "")
    for prefix in ["kitsu", "mal", "tvdb", "tmdb"]:
        if clean.startswith(f"{prefix}:"):
            parts = clean[len(prefix) + 1:].split(":")
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
