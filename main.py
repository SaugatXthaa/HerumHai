"""
main.py — HerumHai Stremio Add-on (Python FastAPI + curl_cffi)
NO HdHub, NO PenguPlay — uses own sources only.
"""

import json
import time
import asyncio
from typing import Dict, List
from concurrent.futures import ThreadPoolExecutor
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, HTMLResponse, FileResponse
from fastapi.middleware.cors import CORSMiddleware
import os

from utils.metadata import resolve_meta, parse_stremio_id
from utils.stream_filter import filter_streams
from sources.all_sources import fetch_cdn111477_streams, ALL_SECONDARY_SOURCES, BROWSER_SOURCES
from sources.embed_providers import EMBED_SCRAPERS
from sources.browser_scraper import run_browser_scrapers

app = FastAPI(title="HerumHai", version="17.0.0")

app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_credentials=True,
    allow_methods=["*"], allow_headers=["*"],
)

stream_cache: Dict[str, dict] = {}
CACHE_TTL = 6 * 60 * 60 * 1000
_executor = ThreadPoolExecutor(max_workers=20)
PUBLIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "public")


@app.get("/manifest.json")
@app.get("/manifest")
async def manifest():
    return JSONResponse({
        "id": "com.herumhai.addon", "version": "17.0.0", "name": "HerumHai",
        "description": "100+ sources. Direct HTTPS streams via curl_cffi. No debrid. 80MB+ only.",
        "logo": "/logo.png", "resources": ["stream"],
        "types": ["movie", "series", "anime"],
        "idPrefixes": ["tt", "kitsu", "mal", "tvdb", "tmdb"], "catalogs": [],
        "behaviorHints": {"configurable": False, "configurationRequired": False},
    })


@app.get("/stream/{media_type}/{media_id}.json")
@app.get("/stream/{media_type}/{media_id}")
async def get_streams(media_type: str, media_id: str):
    start = time.time()
    clean_id = media_id.replace(".json", "")
    cache_key = f"{media_type}:{clean_id}"

    cached = stream_cache.get(cache_key)
    if cached and cached.get("streams") and time.time() * 1000 - cached.get("scraped_at", 0) < CACHE_TTL:
        print(f"[/stream] HIT {len(cached['streams'])} in {int((time.time()-start)*1000)}ms")
        return JSONResponse({"streams": cached["streams"]})

    print(f"[/stream] MISS {media_type}/{clean_id}")
    try:
        parsed = parse_stremio_id(clean_id)
        title = ""
        meta = resolve_meta(parsed.get("imdb_id") or f"kitsu:{parsed.get('kitsu_id')}", media_type)
        if meta:
            title = f"{meta.get('name', '')} {meta.get('year', '')}".strip()

        target = {"type": media_type, **parsed}
        loop = asyncio.get_event_loop()

        # Fetch 111477 CDN + embed providers + secondary sources in parallel
        cdn_future = loop.run_in_executor(_executor, fetch_cdn111477_streams, target, title)
        embed_futures = [
            loop.run_in_executor(_executor, s["scrape"], target, title)
            for s in EMBED_SCRAPERS
        ]
        secondary_futures = [
            loop.run_in_executor(_executor, s["scrape"], target, title)
            for s in ALL_SECONDARY_SOURCES
        ]

        cdn111 = await cdn_future
        try:
            all_futures = embed_futures + secondary_futures
            all_results = await asyncio.wait_for(
                asyncio.gather(*all_futures, return_exceptions=True), timeout=20.0
            )
        except asyncio.TimeoutError:
            all_results = [f.result() for f in all_futures if f.done()]

        all_streams = list(cdn111)

        # Run browser scrapers ASYNC (Playwright async API)
        # Sequential, max 3 sites, 15s timeout
        try:
            browser_sources = [
                {"id": s["id"], "name": s["name"], "base_url": s.get("base_url", ""), "search_path": s.get("search_path", "")}
                for s in BROWSER_SOURCES[:3]
            ]
            browser_results = await asyncio.wait_for(
                run_browser_scrapers(target, title, browser_sources),
                timeout=20.0
            )
            all_streams.extend(browser_results)
        except Exception as e:
            print(f"[browser] error: {str(e)[:50]}")

        for result in all_results:
            if isinstance(result, list):
                all_streams.extend(result)

        filtered = filter_streams(all_streams)
        seen = set()
        deduped = [s for s in filtered if s.get("url") and s["url"] not in seen and not seen.add(s["url"])]

        elapsed = int((time.time() - start) * 1000)
        b = {}
        for x in deduped:
            src = x.get("source", "?")
            b[src] = b.get(src, 0) + 1
        src_summary = ", ".join(f"{k}:{v}" for k, v in sorted(b.items(), key=lambda x: -x[1])[:5])
        print(f"[/stream] DONE {len(deduped)} in {elapsed}ms ({src_summary})")

        stream_cache[cache_key] = {"streams": deduped, "scraped_at": time.time() * 1000}
        return JSONResponse({"streams": deduped})
    except Exception as e:
        print(f"[/stream] ERROR: {e}")
        return JSONResponse({"streams": []})


@app.get("/health")
async def health():
    import psutil
    mem = psutil.Process().memory_info().rss
    return JSONResponse({
        "ok": True, "version": "17.0.0", "uptime": time.time(),
        "memory": {"rss": f"{mem // 1048576}MB"},
        "cache": {"size": len(stream_cache), "ttl_hours": 6},
        "sources": 1 + len(ALL_SECONDARY_SOURCES),
        "min_size_mb": 80, "cf_bypass": "curl_cffi (impersonate=chrome)",
    })


@app.get("/")
async def dashboard():
    index_path = os.path.join(PUBLIC_DIR, "index.html")
    if os.path.exists(index_path):
        return FileResponse(index_path)
    return HTMLResponse("<h1>HerumHai</h1>")


@app.get("/{path:path}")
async def catch_all(path: str):
    if path.startswith(("stream", "health", "manifest")):
        return JSONResponse({"error": "Not found"}, status_code=404)
    file_path = os.path.join(PUBLIC_DIR, path)
    if os.path.exists(file_path) and os.path.isfile(file_path):
        return FileResponse(file_path)
    return await dashboard()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 7000)))
