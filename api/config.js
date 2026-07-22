// ============================================================================
// api/config.js — HerumHai Formatter Config Storage
// ----------------------------------------------------------------------------
// Solves the URL-length-limit problem: the user's full formatter JSON is
// ~24KB, but Vercel only allows ~8KB in query strings. So when the user
// installs the addon with their full formatter, the URL gets truncated and
// the formatter is silently broken.
//
// Solution: store the formatter server-side keyed by a short hash ID. The
// install URL becomes /manifest.json?config=<8-char-id> instead of
// ?nameTemplate=<24KB>&descriptionTemplate=<24KB>.
//
// Endpoints:
//   POST /api/config        { nameTemplate, descriptionTemplate }
//                            → { id: "abc12345", configShortUrl: "..." }
//   GET  /api/config?id=X   → { nameTemplate, descriptionTemplate }
// ============================================================================

// In-memory cache (per-instance — survives warm calls within the same Vercel
// serverless instance). Persisted to Upstash Redis when available so configs
// survive across instances / cold starts.
const memoryCache = new Map();
const MAX_MEMORY_ENTRIES = 500; // LRU cap

// ---------------------------------------------------------------------------
// Upstash Redis helpers (reuse the same env vars as stream.js)
// ---------------------------------------------------------------------------
async function redisGet(key) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const res = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.result) return data.result;
    return null;
  } catch {
    return null;
  }
}

async function redisSet(key, value, ttlSeconds) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return false;
  try {
    // Upstash REST API: POST /set/<key>/<value>?EX=<ttl>
    const setUrl = `${url}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}?EX=${ttlSeconds}`;
    const res = await fetch(setUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Hash function (djb2) — produces a short, stable ID from the formatter content
// ---------------------------------------------------------------------------
function hashId(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0; // unsigned
  }
  return hash.toString(36);
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(204).end();

  // --- GET: retrieve config by ID ---
  if (req.method === 'GET') {
    const id = req.query?.id;
    if (!id) {
      return res.status(400).json({ error: 'Missing id parameter' });
    }

    // 1) Check memory cache first
    const cached = memoryCache.get(id);
    if (cached) {
      // Move to end (LRU)
      memoryCache.delete(id);
      memoryCache.set(id, cached);
      return res.status(200).json({ id, ...cached });
    }

    // 2) Check Redis
    const redisKey = `herumhai:config:${id}`;
    const redisVal = await redisGet(redisKey);
    if (redisVal) {
      try {
        const parsed = JSON.parse(redisVal);
        // Populate memory cache
        memoryCache.set(id, parsed);
        if (memoryCache.size > MAX_MEMORY_ENTRIES) {
          // Evict oldest entry
          const firstKey = memoryCache.keys().next().value;
          memoryCache.delete(firstKey);
        }
        return res.status(200).json({ id, ...parsed });
      } catch {}
    }

    return res.status(404).json({ error: 'Config not found' });
  }

  // --- POST: store config, return ID ---
  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch {
        return res.status(400).json({ error: 'Invalid JSON body' });
      }
    }
    if (!body || (!body.nameTemplate && !body.descriptionTemplate)) {
      return res.status(400).json({ error: 'Missing nameTemplate or descriptionTemplate' });
    }

    const nameTemplate = body.nameTemplate || '';
    const descriptionTemplate = body.descriptionTemplate || '';

    // Generate stable ID from content (same formatter → same ID, dedupes storage)
    const id = hashId(nameTemplate + '||' + descriptionTemplate);
    const config = { nameTemplate, descriptionTemplate };

    // Store in memory cache
    memoryCache.set(id, config);
    if (memoryCache.size > MAX_MEMORY_ENTRIES) {
      const firstKey = memoryCache.keys().next().value;
      memoryCache.delete(firstKey);
    }

    // Persist to Redis (TTL: 365 days)
    await redisSet(`herumhai:config:${id}`, JSON.stringify(config), 365 * 24 * 60 * 60);

    return res.status(200).json({
      id,
      configShortUrl: `config=${id}`,
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
