// src/utils/http.js — HTTP utilities (quick fetch + optional CF bypass)
import axios from 'axios';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Quick single-request fetch (5s timeout) — for secondary sources
export async function fetchHtml(url, { timeout = 5000, headers = {} } = {}) {
  try {
    const res = await axios.get(url, {
      timeout,
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://google.com',
        ...headers,
      },
      maxRedirects: 3,
      validateStatus: () => true,
    });
    if (res.status === 200 && typeof res.data === 'string') return res.data;
    return null;
  } catch { return null; }
}

export async function fetchJson(url, { timeout = 5000, headers = {} } = {}) {
  try {
    const res = await axios.get(url, {
      timeout,
      headers: { 'User-Agent': UA, Accept: 'application/json', ...headers },
      maxRedirects: 3, validateStatus: () => true,
    });
    if (res.status >= 200 && res.status < 300 && res.data) return res.data;
    return null;
  } catch { return null; }
}

// CF bypass fetch (6s+5s wait) — only for specific sources that need it
export async function fetchHtmlWithCfBypass(url, { timeout = 8000, headers = {} } = {}) {
  const cookieJar = new Map();
  const getCookie = (u) => { try { return Object.entries(cookieJar.get(new URL(u).hostname) || {}).map(([k,v])=>`${k}=${v}`).join('; '); } catch { return ''; } };
  const setCookie = (u, h) => { if(!h) return; try { const hn=new URL(u).hostname; const c=cookieJar.get(hn)||{}; for(const s of (Array.isArray(h)?h:[h])) { const m=s.match(/^([^=]+)=([^;]*)/); if(m) c[m[1].trim()]=m[2].trim(); } cookieJar.set(hn,c); } catch {} };
  const isCF = (d) => !d || typeof d !== 'string' ? false : d.includes('Just a moment') || d.includes('cf-challenge') || d.includes('cdn-cgi/challenge-platform');

  const baseH = { 'User-Agent': UA, 'Accept': 'text/html,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9', 'Referer': 'https://google.com', ...headers };

  for (let i = 0; i < 3; i++) {
    try {
      const cs = getCookie(url);
      const res = await axios.get(url, { timeout, headers: { ...baseH, ...(cs && { Cookie: cs }) }, maxRedirects: 5, validateStatus: () => true });
      setCookie(url, res.headers['set-cookie']);
      if (res.status === 200 && res.data && !isCF(res.data)) return res.data;
    } catch {}
    if (i < 2) await new Promise(r => setTimeout(r, i === 0 ? 6000 : 5000));
  }
  return null;
}

export { UA };
