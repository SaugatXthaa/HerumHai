"""
main.py — HerumHai Stremio Add-on (Python FastAPI + curl_cffi)

Architecture:
  - Pure HTTP using curl_cffi with impersonate="chrome" (bypasses Cloudflare TLS)
  - 3 primary sources (HdHub + PenguPlay + 111477 CDN) — always work
  - 104+ secondary sources — CF bypassed via curl_cffi
  - 80MB minimum file size filter
  - 6-hour cache for instant repeat requests
  - No browser, no Puppeteer — runs in <50MB RAM

Stremio protocol:
  GET /manifest.json — addon manifest
  GET /stream/{type}/{id}.json — stream list for a title
"""

import json
import time
import asyncio
from typing import Dict, List, Any
from concurrent.futures import ThreadPoolExecutor
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, HTMLResponse, FileResponse
from fastapi.middleware.cors import CORSMiddleware
import os

from utils.metadata import resolve_meta, parse_stremio_id
from utils.stream_filter import filter_streams
from sources.all_sources import (
    fetch_hdhub_streams,
    fetch_pengu_streams,
    fetch_cdn111477_streams,
    ALL_SECONDARY_SOURCES,
)

app = FastAPI(title="HerumHai", version="16.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory cache
stream_cache: Dict[str, dict] = {}
CACHE_TTL = 6 * 60 * 60 * 1000  # 6 hours in ms

# Thread pool for parallel scraping (low memory — pure HTTP)
_executor = ThreadPoolExecutor(max_workers=20)

# Path to public directory
PUBLIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "public")


@app.get("/manifest.json")
@app.get("/manifest")
async def manifest():
    """Stremio addon manifest."""
    return JSONResponse({
        "id": "com.herumhai.addon",
        "version": "16.0.0",
        "name": "HerumHai",
        "description": "107+ sources. Direct HTTPS streams via curl_cffi CF bypass. No debrid. 80MB+ files only.",
        "logo": "/logo.png",
        "resources": ["stream"],
        "types": ["movie", "series", "anime"],
        "idPrefixes": ["tt", "kitsu", "mal", "tvdb", "tmdb"],
        "catalogs": [],
        "behaviorHints": {"configurable": False, "configurationRequired": False},
    })


@app.get("/stream/{media_type}/{media_id}.json")
@app.get("/stream/{media_type}/{media_id}")
async def get_streams(media_type: str, media_id: str):
    """Stremio stream endpoint — synchronous with caching."""
    start = time.time()
    clean_id = media_id.replace(".json", "")
    cache_key = f"{media_type}:{clean_id}"

    # 1. Cache HIT
    cached = stream_cache.get(cache_key)
    if cached and cached.get("streams") and time.time() * 1000 - cached.get("scraped_at", 0) < CACHE_TTL:
        elapsed = int((time.time() - start) * 1000)
        print(f"[/stream] HIT {len(cached['streams'])} in {elapsed}ms")
        return JSONResponse({"streams": cached["streams"]})

    print(f"[/stream] MISS {media_type}/{clean_id}")

    try:
        # 2. Resolve title
        parsed = parse_stremio_id(clean_id)
        title = ""
        meta = resolve_meta(parsed.get("imdb_id") or f"kitsu:{parsed.get('kitsu_id')}", media_type)
        if meta:
            title = f"{meta.get('name', '')} {meta.get('year', '')}".strip()

        target = {"type": media_type, **parsed}

        # 3. Fetch primary sources (HdHub + PenguPlay + 111477 CDN) in parallel
        loop = asyncio.get_event_loop()
        hdhub_future = loop.run_in_executor(_executor, fetch_hdhub_streams, media_type, clean_id)
        pengu_future = loop.run_in_executor(_executor, fetch_pengu_streams, media_type, clean_id)
        cdn_future = loop.run_in_executor(_executor, fetch_cdn111477_streams, target, title)

        # 4. Fetch secondary sources in parallel (max 20 concurrent)
        secondary_futures = [
            loop.run_in_executor(_executor, s["scrape"], target, title)
            for s in ALL_SECONDARY_SOURCES
        ]

        # Wait for all
        hdhub = await hdhub_future
        pengu = await pengu_future
        cdn111 = await cdn_future

        # Collect secondary results (with 10s timeout)
        try:
            secondary_results = await asyncio.wait_for(
                asyncio.gather(*secondary_futures, return_exceptions=True),
                timeout=10.0
            )
        except asyncio.TimeoutError:
            secondary_results = [f.result() for f in secondary_futures if f.done()]

        # 5. Merge all streams
        all_streams = list(hdhub) + list(pengu) + list(cdn111)
        for result in secondary_results:
            if isinstance(result, list):
                all_streams.extend(result)

        # 6. Filter: remove <80MB, ads, trailers, torrents
        filtered = filter_streams(all_streams)

        # 7. Dedupe by URL
        seen = set()
        deduped = []
        for s in filtered:
            url = s.get("url")
            if url and url not in seen:
                seen.add(url)
                deduped.append(s)

        elapsed = int((time.time() - start) * 1000)
        print(f"[/stream] DONE {len(deduped)} in {elapsed}ms (hdhub:{len(hdhub)} pengu:{len(pengu)} cdn:{len(cdn111)})")

        # 8. Cache
        stream_cache[cache_key] = {"streams": deduped, "scraped_at": time.time() * 1000}

        return JSONResponse({"streams": deduped})

    except Exception as e:
        print(f"[/stream] ERROR: {e}")
        return JSONResponse({"streams": []})


@app.get("/health")
async def health():
    """Health check endpoint."""
    import psutil
    mem = psutil.Process().memory_info().rss
    return JSONResponse({
        "ok": True,
        "version": "16.0.0",
        "uptime": time.time(),
        "memory": {"rss": f"{mem // 1048576}MB"},
        "cache": {"size": len(stream_cache), "ttl_hours": 6},
        "sources": 3 + len(ALL_SECONDARY_SOURCES),
        "min_size_mb": 80,
        "cf_bypass": "curl_cffi (impersonate=chrome)",
    })


@app.get("/")
async def dashboard():
    """Serve dashboard."""
    index_path = os.path.join(PUBLIC_DIR, "index.html")
    if os.path.exists(index_path):
        return FileResponse(index_path)
    return HTMLResponse("<h1>HerumHai</h1><p>Stremio addon running. Visit /manifest.json</p>")


@app.get("/{path:path}")
async def catch_all(path: str):
    """Catch-all for static files."""
    if path.startswith(("stream", "health", "manifest")):
        return JSONResponse({"error": "Not found"}, status_code=404)

    file_path = os.path.join(PUBLIC_DIR, path)
    if os.path.exists(file_path) and os.path.isfile(file_path):
        return FileResponse(file_path)

    return await dashboard()


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 7000))
    uvicorn.run(app, host="0.0.0.0", port=port)
