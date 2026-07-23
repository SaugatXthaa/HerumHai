// =============================================================================
// src/utils/http.js — Pure HTTP Utilities (No Browser)
// -----------------------------------------------------------------------------
// All requests use axios + randomized browser headers to mimic organic traffic.
// No Puppeteer, no FlareSolverr — pure HTTP only.
// =============================================================================

import axios from 'axios';
import { getRandomHeaders, getRandomUserAgent } from './headers.js';

// ---------------------------------------------------------------------------
// Fetch HTML (for WordPress sites, search pages)
// ---------------------------------------------------------------------------
export async function fetchHtml(url, { timeout = 8000, referer } = {}) {
  try {
    const headers = getRandomHeaders();
    if (referer) headers['Referer'] = referer;

    const res = await axios.get(url, {
      timeout,
      headers,
      maxRedirects: 5,
      validateStatus: () => true,
    });

    if (res.status === 200 && typeof res.data === 'string' && res.data.length > 200) {
      // Check for Cloudflare challenge
      if (res.data.includes('Just a moment') || res.data.includes('cf-challenge')) {
        console.log(`[http] CF challenge detected (pure HTTP can't bypass): ${url.slice(0, 60)}`);
        return null;
      }
      return res.data;
    }
    return null;
  } catch (err) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fetch JSON (for API endpoints)
// ---------------------------------------------------------------------------
export async function fetchJson(url, { timeout = 8000, referer, method = 'GET', body } = {}) {
  try {
    const headers = {
      'User-Agent': getRandomUserAgent(),
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': referer || 'https://google.com',
    };

    const config = {
      timeout,
      headers,
      maxRedirects: 5,
      validateStatus: () => true,
    };

    if (method === 'POST' && body) {
      config.method = 'POST';
      config.data = body;
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    const res = await axios(url, config);
    if (res.status >= 200 && res.status < 300 && res.data) {
      return res.data;
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Validate URL — returns true if URL returns video bytes (not HTML/403/404)
// Based on URL validation pattern
// ---------------------------------------------------------------------------
export async function validateUrl(url, { timeout = 5000, referer } = {}) {
  try {
    const headers = {
      'User-Agent': getRandomUserAgent(),
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Range': 'bytes=0-0', // Request 1 byte to check if seekable
      ...(referer && { Referer: referer }),
    };

    const res = await axios.get(url, {
      timeout,
      headers,
      maxRedirects: 3,
      responseType: 'arraybuffer',
      validateStatus: () => true,
    });

    // Only accept 200 and 206 (Partial Content)
    if (res.status !== 200 && res.status !== 206) return false;

    // Reject HTML/text content types (these are error pages, not video)
    const ct = (res.headers['content-type'] || '').toLowerCase();
    if (ct.includes('text/html') || ct.includes('text/plain') || ct.includes('text/xml')) {
      return false;
    }

    // Must have actual bytes
    if (res.data && res.data.byteLength > 0) return true;
    return false;
  } catch {
    return false;
  }
}
