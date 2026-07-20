// ============================================================================
// api/health.js — HerumHai Health check endpoint
// ============================================================================

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  return res.status(200).json({
    ok: true,
    name: 'HerumHai',
    version: '1.0.0',
    ts: new Date().toISOString(),
    runtime: 'vercel-serverless',
    browser: 'chromium (@sparticuz/chromium)',
    scraper: 'puppeteer-core',
    min_mp4_size_mb: 50,
    indexers: ['vidsrc', '2embed', 'multiembed', 'vidsrcme', 'gomo', 'databasegdriveco'],
  });
}
