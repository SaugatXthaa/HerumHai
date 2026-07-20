-- ============================================================================
-- HerumHai Backend — PostgreSQL Schema
-- ----------------------------------------------------------------------------
-- Stores pre-scraped streams so the Vercel addon can serve them instantly.
-- Background scraper populates this every 6 hours for popular titles.
-- ============================================================================

-- Stream cache table
CREATE TABLE IF NOT EXISTS stream_cache (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type            VARCHAR(16) NOT NULL,         -- movie | series | anime
    imdb_id         VARCHAR(32),                  -- tt1375666
    tmdb_id         VARCHAR(32),                  -- tmdb:27205
    kitsu_id        VARCHAR(32),                  -- kitsu:41436
    season          INT,                          -- NULL for movies
    episode         INT,                          -- NULL for movies
    title           TEXT,
    streams_json    TEXT NOT NULL,                -- JSON array of Stremio streams
    source_count    INT NOT NULL DEFAULT 0,
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    expires_at      TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP + INTERVAL '24 hours',

    CONSTRAINT chk_ids CHECK (imdb_id IS NOT NULL OR tmdb_id IS NOT NULL OR kitsu_id IS NOT NULL)
);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_cache_imdb ON stream_cache (imdb_id, type, season, episode) WHERE imdb_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cache_tmdb ON stream_cache (tmdb_id, type, season, episode) WHERE tmdb_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cache_kitsu ON stream_cache (kitsu_id, type, episode) WHERE kitsu_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cache_expires ON stream_cache (expires_at);

-- Auto-update trigger
CREATE OR REPLACE FUNCTION update_modified_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_stream_cache_modtime ON stream_cache;
CREATE TRIGGER update_stream_cache_modtime
    BEFORE UPDATE ON stream_cache
    FOR EACH ROW
    EXECUTE FUNCTION update_modified_column();

-- Popular titles table (for background scraper)
CREATE TABLE IF NOT EXISTS popular_titles (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type            VARCHAR(16) NOT NULL,         -- movie | series
    imdb_id         VARCHAR(32),
    tmdb_id         VARCHAR(32),
    title           TEXT NOT NULL,
    priority        INT NOT NULL DEFAULT 0,       -- higher = scrape first
    last_scraped_at TIMESTAMP WITH TIME ZONE,
    scrape_count    INT NOT NULL DEFAULT 0,
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(type, imdb_id)
);

CREATE INDEX IF NOT EXISTS idx_popular_priority ON popular_titles (priority DESC, last_scraped_at ASC);

-- Scraper log table (for monitoring)
CREATE TABLE IF NOT EXISTS scraper_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scraper_name    VARCHAR(64) NOT NULL,
    target_id       VARCHAR(64),
    status          VARCHAR(16) NOT NULL,         -- ok | error | timeout
    stream_count    INT NOT NULL DEFAULT 0,
    duration_ms     INT NOT NULL DEFAULT 0,
    error_message   TEXT,
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_log_created ON scraper_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_log_scraper ON scraper_log (scraper_name, created_at DESC);
