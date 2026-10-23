const express = require('express');
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const { Readable } = require('stream');
const { sniffKind } = require('./sniff');
const zlib = require('zlib');

const app = express();
const PORT = process.env.PORT || 10000;
const PLAYLIST_FILES = [path.join(__dirname, 'public', 'playlist.m3u'), path.join(__dirname, 'playlist.m3u')];
const PLAYLIST_URL = process.env.PLAYLIST_URL || '';
const UA = 'Mozilla/5.0 (compatible; TamilIPTV/2.0)';

// Global CORS Middleware - Sabhi origins & DRM requests-ku support
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, Range, Custom-Header');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, X-Final-Url');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// Dynamic host allowance set
const allowed = new Set((process.env.ALLOWED_HOSTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
// External private JioTV host dynamic add
allowed.add('jiotv-private-5gu7.onrender.com');

let cache = { at: 0, list: [] };

const HEADER_NAMES = {
  'cookie': 'Cookie', 'http-cookie': 'Cookie', 'referer': 'Referer', 'referrer': 'Referer', 'http-referrer': 'Referer', 'http-referer': 'Referer',
  'user-agent': 'User-Agent', 'http-user-agent': 'User-Agent', 'origin': 'Origin', 'http-origin': 'Origin', 'authorization': 'Authorization'
};

function addHeader(ch, name, value) {
  const n = HEADER_NAMES[String(name).trim().toLowerCase()];
  if (!n || value === undefined || value === '') return;
  ch._h = ch._h || {};
  ch._h[n] = String(value).trim();
}

function parseM3U(text) {
  const out = [];
  let cur = null;
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const attr = k => (line.match(new RegExp(k + '="([^"]*)"', 'i')) || [])[1] || '';
      const q = line.lastIndexOf('"');
      const comma = line.indexOf(',', q + 1);
      const title = (comma >= 0 ? line.slice(comma + 1) : line.slice(line.lastIndexOf(',') + 1)).trim();
      cur = {
        name: title || attr('tvg-name') || 'Channel',
        tvg: attr('tvg-id'),
        tvgName: attr('tvg-name'),
        logo: attr('tvg-logo'),
        group: attr('group-title') || 'Others',
      };
    } else if (line.startsWith('#EXTHTTP:') && cur) {
      try {
        const j = JSON.parse(line.slice(9));
        for (const k of Object.keys(j)) addHeader(cur, k, j[k]);
      } catch {}
    } else if (line.startsWith('#EXTVLCOPT:') && cur) {
      const i = line.indexOf('=');
      if (i > 0) addHeader(cur, line.slice(11, i), line.slice(i + 1));
    } else if (line.startsWith('#KODIPROP:') && cur) {
      const [k, ...v] = line.slice(10).split('=');
      cur._k = cur._k || {};
      cur._k[k.trim()] = v.join('=').trim();
    } else if (!line.startsWith('#') && cur) {
      const bar = line.indexOf('|');
      cur.url = bar >= 0 ? line.slice(0, bar) : line;
      if (bar >= 0) for (const pair of line.slice(bar + 1).split('&')) {
        const i = pair.indexOf('=');
        if (i > 0) { let v = pair.slice(i + 1); try { v = decodeURIComponent(v); } catch {} addHeader(cur, pair.slice(0, i), v); }
      }
      if (cur._k) {
        const k = cur._k;
        if (k['inputstream.adaptive.license_key']) {
          cur.drm = { type: k['inputstream.adaptive.license_type'] || '', key: k['inputstream.adaptive.license_key'] };
        }
        const mt = (k['inputstream.adaptive.manifest_type'] || '').toLowerCase();
        if (mt === 'mpd' || mt === 'hls') cur.type = mt;
        for (const pair of (k['inputstream.adaptive.stream_headers'] || k['inputstream.adaptive.manifest_headers'] || '').split('&')) {
          const i = pair.indexOf('=');
          if (i > 0) { let v = pair.slice(i + 1); try { v = decodeURIComponent(v); } catch {} addHeader(cur, pair.slice(0, i), v); }
        }
      }
      delete cur._k;
      if (!/^https?:\/\//i.test(cur.url)) { cur = null; continue; }
      try {
        const u = new URL(cur.url);
        if (u.username || u.password) {
          addHeader(cur, 'authorization', 'Basic ' + Buffer.from(decodeURIComponent(u.username) + ':' + decodeURIComponent(u.password)).toString('base64'));
          u.username = ''; u.password = ''; cur.url = u.href;
        }
        allowed.add(u.hostname.toLowerCase());
      } catch { cur = null; continue; }
      if (out.some(o => o.url === cur.url && o.name === cur.name)) { cur = null; continue; }
      cur.proxy = true;
      cur.id = out.length;
      out.push(cur);
      cur = null;
    }
  }
  return out;
}

async function loadChannels(fresh) {
  if (!fresh && Date.now() - cache.at < 60_000 && cache.list.length) return cache.list;
  let text = '';
  if (PLAYLIST_URL) {
    const r = await fetch(PLAYLIST_URL, { headers: { 'User-Agent': UA } });
    if (!r.ok) throw new Error('PLAYLIST_URL returned ' + r.status);
    text = await r.text();
  } else {
    const f = PLAYLIST_FILES.find(x => fs.existsSync(x));
    if (!f) throw new Error('playlist.m3u not found (put it in public/playlist.m3u)');
    text = fs.readFileSync(f, 'utf8');
  }
  cache = { at: Date.now(), list: parseM3U(text) };
  playlistEpgUrls = epgUrlsFromPlaylist(text);
  rebuildEpgMap();
  return cache.list;
}

function isPrivate(ip) {
  ip = ip.replace(/^::ffff:/i, '');
  if (net.isIPv6(ip)) return ip === '::1' || ip === '::' || /^(fc|fd|fe[89ab])/i.test(ip);
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
         (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

const dnsOk = new Map();
async function assertPublic(url) {
  if (!/^https?:$/.test(url.protocol)) throw new Error('bad protocol');
  if (process.env.ALLOW_PRIVATE || url.hostname.includes('onrender.com')) return; // render servers Bypass
  const hit = dnsOk.get(url.hostname);
  if (hit && Date.now() - hit < 30_000) return;
  try {
    const addrs = await dns.lookup(url.hostname, { all: true });
    if (addrs.some(a => isPrivate(a.address))) throw new Error('private address blocked');
    dnsOk.set(url.hostname, Date.now());
  } catch (e) {
    if (e.message.includes('private address blocked')) throw e;
  }
  if (dnsOk.size > 500) dnsOk.clear();
}

const UPSTREAM_TIMEOUT = 20_000;

async function fetchFollow(start, headers, signal, init = {}) {
  let url = start, opts = init;
  for (let i = 0; i < 5; i++) {
    await assertPublic(url);
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    if (signal.aborted) ctl.abort(); else signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ctl.abort(), UPSTREAM_TIMEOUT);
    let r;
    try { r = await fetch(url, { headers, redirect: 'manual', signal: ctl.signal, ...opts }); }
    catch (e) { signal.removeEventListener('abort', onAbort); throw new Error(e.name === 'AbortError' ? 'upstream timeout' : e.message); }
    finally { clearTimeout(timer); }
    const loc = r.headers.get('location');
    if (r.status >= 300 && r.status < 400 && loc) {
      signal.removeEventListener('abort', onAbort);
      try { await r.body?.cancel(); } catch {}
      url = new URL(loc, url);
      allowed.add(url.hostname.toLowerCase());
      if (r.status !== 307 && r.status !== 308) opts = {};
      continue;
    }
    r.finalUrl = url.href;
    return r;
  }
  throw new Error('too many redirects');
}

const UA_POOL = [
  UA,
  'OTT Navigator/1.7.0.0 (Linux;Android 12) ExoPlayerLib/2.19.1',
  'VLC/3.0.20 LibVLC/3.0.20',
  'Lavf/60.16.100',
  'Dalvik/2.1.0 (Linux; U; Android 12; SM-G991B Build/SP1A.210812.016)',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
];
const uaByHost = new Map();
const refByHost = new Set();
const uaGaveUp = new Map();

async function fetchUA(url, headers, signal, init = {}, ownUA = '') {
  const host = url.hostname.toLowerCase(), key = url.origin + url.pathname;
  const remembered = uaByHost.get(host), refOk = refByHost.has(host);
  const uas = [...new Set((ownUA ? [ownUA] : [remembered, headers['User-Agent'] || UA]).concat(UA_POOL).filter(Boolean))].slice(0, 5);
  const tries = uas.map(ua => ({ ua, ref: refOk }));
  if (!refOk && !headers.Referer) tries.push({ ua: uas[0], ref: true }, { ua: UA_POOL[1], ref: true });
  const gaveUp = Date.now() - (uaGaveUp.get(key) || 0) < 60_000;
  const refused = st => [401, 403, 406, 451].includes(st);
  let last;
  for (let i = 0; i < tries.length; i++) {
    const { ua, ref } = tries[i];
    if (i >= uas.length && last && !refused(last.status)) break;
    const h = { ...headers, 'User-Agent': ua };
    if (ref && !h.Referer) { h.Referer = url.origin + '/'; if (!h.Origin) h.Origin = url.origin; }
    try {
      last = await fetchFollow(url, h, signal, init);
      last.ua = ua;
      if (last.status < 400) { uaByHost.set(host, ua); if (ref && !refOk && !headers.Referer) refByHost.add(host); uaGaveUp.delete(key); return last; }
      if (gaveUp || !(refused(last.status) || (!remembered && last.status !== 416))) return last;
      if (i < tries.length - 1) { try { await last.body?.cancel(); } catch {} }
    } catch (e) {
      if (i === tries.length - 1) throw e;
    }
  }
  uaGaveUp.set(key, Date.now());
  if (uaGaveUp.size > 500) uaGaveUp.clear();
  return last;
}

const httpReason = s =>
  s === 401 || s === 403 ? `The server refused the request (HTTP ${s}). The stream needs a login/token, a specific app, or blocks servers.` :
  s === 451 ? 'Blocked for legal / regional reasons (HTTP 451).' :
  s === 404 || s === 410 ? `Stream not found (HTTP ${s}). Link dead/expired.` :
  s === 429 ? 'Too many requests (HTTP 429).' :
  s >= 500 ? `Upstream JioTV Server Error (HTTP ${s}). Server restart dynamic retry active.` : `HTTP ${s}`;

const WARM_TTL_PL = 4_000, WARM_TTL_SEG = 30_000, WARM_MAX = 48 * 1024 * 1024, WARM_ITEM_MAX = 8 * 1024 * 1024;
const warm = new Map(), inflight = new Map(); let warmBytes = 0;
function warmGet(key) {
  const e = warm.get(key);
  if (!e) return null;
  if (Date.now() > e.exp) { warmBytes -= e.buf.length; warm.delete(key); return null; }
  return e;
}
function warmPut(key, buf, ct, finalUrl, ttl) {
  if (buf.length > WARM_ITEM_MAX) return;
  const old = warm.get(key); if (old) warmBytes -= old.buf.length;
  warm.set(key, { buf, ct, finalUrl, exp: Date.now() + ttl }); warmBytes += buf.length;
  while (warmBytes > WARM_MAX && warm.size) { const k = warm.keys().next().value; warmBytes -= warm.get(k).buf.length; warm.delete(k); }
}
function warmFetch(url, chan, ttl) {
  const key = url.href;
  if (warm.has(key) && warmGet(key) || inflight.has(key)) return;
  const p = (async () => {
    const ac = new AbortController(), timer = setTimeout(() => ac.abort(), 15_000);
    try {
      const headers = { 'User-Agent': UA, ...((chan && chan._h) || {}) };
      const up = await fetchUA(url, headers, ac.signal, {}, chan && chan._h && chan._h['User-Agent']);
      if (!up.ok) { try { await up.body?.cancel(); } catch {} return; }
      warmPut(key, Buffer.from(await up.arrayBuffer()), up.headers.get('content-type') || '', up.finalUrl, ttl);
    } catch {} finally { clearTimeout(timer); inflight.delete(key); }
  })();
  inflight.set(key, p);
}
function prefetchFrom(text, base, chan) {
  const lines = text.split(/\r?\n/).map(l => l.trim());
  const abs = u => { try { return new URL(u, base); } catch { return null; } };
  if (lines.some(l => l.startsWith('#EXT-X-STREAM-INF'))) {
    let best = null, bw = Infinity;
    lines.forEach((l, i) => {
      if (!l.startsWith('#EXT-X-STREAM-INF')) return;
      const b = +((l.match(/BANDWIDTH=(\d+)/i) || [])[1] || Infinity);
      const u = lines.slice(i + 1).find(x => x && !x.startsWith('#'));
      if (u && b <= bw) { bw = b; best = u; }
    });
    const u = best && abs(best); if (u) warmFetch(u, chan, WARM_TTL_PL);
  } else if (lines.some(l => l.startsWith('#EXTINF')) && !lines.includes('#EXT-X-ENDLIST')) {
    lines.filter(l => l && !l.startsWith('#')).slice(-4).forEach(sg => { const u = abs(sg); if (u) warmFetch(u, chan, WARM_TTL_SEG); });
  }
}

function rewriteM3U8(text, base, ch, nc, w) {
  const px = u => {
    const abs = new URL(u, base);
    allowed.add(abs.hostname.toLowerCase());
    return '/proxy?' + (ch != null ? 'ch=' + ch + '&' : '') + (nc ? 'nc=1&' : '') + (w ? 'w=1&' : '') + 'url=' + encodeURIComponent(abs.href);
  };
  return text.split(/\r?\n/).map(l => {
    if (!l.trim()) return l;
    if (l.startsWith('#')) {
      if (nc && l.startsWith('#EXT-X-STREAM-INF')) l = l.replace(/,CODECS="[^"]*"|CODECS="[^"]*",?/i, '');
      return l.replace(/URI="([^"]+)"/g, (m, u) => `URI="${px(u)}"`);
    }
    return px(l.trim());
  }).join('\n');
}

/* EPG MODULE */
const EPG_REFRESH_MS = Math.max(0.25, Number(process.env.EPG_REFRESH_HOURS) || 3) * 3_600_000;
const EPG_FILES = ['public/epg.xml', 'public/epg.xml.gz', 'epg.xml', 'epg.xml.gz'].map(f => path.join(__dirname, f));
const EPG_PAST_MS = 3 * 3_600_000, EPG_FUTURE_MS = 48 * 3_600_000;
let playlistEpgUrls = [];
const TVEPG = 'https://raw.githubusercontent.com/mitthu786/tvepg/main/';
const DEFAULT_EPG_URLS = [TVEPG + 'tataplay/epg.xml.gz', TVEPG + 'epg.xml.gz', TVEPG + 'jiotv/epg.xml.gz'];
const EPG_NUMERIC_IDS = process.env.EPG_MATCH_NUMERIC_IDS === '1';
const EPG_LANG = (process.env.EPG_PREFER_LANG === undefined ? 'tamil' : process.env.EPG_PREFER_LANG).trim().toLowerCase();
const EPG_ALIASES = new Map((process.env.EPG_ALIASES || '').split(';').map(s => s.split('=')).filter(a => a.length === 2 && a[0].trim() && a[1].trim())
  .map(([a, b]) => [a.trim().toLowerCase(), b.trim()]));
const epg = { updated: 0, error: '', sources: 0, programmes: 0, xmlChannels: 0, matched: 0,
              byId: new Map(), gidx: new Map(), unmatched: [], imgHosts: new Set(), map: new Map() };

function epgUrlsFromPlaylist(text) {
  const m = text.match(/^#EXTM3U[^\r\n]*?\b(?:url-tvg|x-tvg-url)\s*=\s*"([^"]+)"/im);
  return m ? m[1].split(',').map(s => s.trim()).filter(u => /^https?:\/\//i.test(u)) : [];
}

const LANGS = new Set(['tamil', 'hindi', 'telugu', 'malayalam', 'kannada', 'english', 'bengali', 'marathi', 'gujarati', 'punjabi', 'bhojpuri', 'odia', 'assamese']);
const SOFT = new Set([...LANGS, 'jio', 'jiotv', 'tata', 'tataplay', 'airtel', 'ott', 'official', 'stream']);
const NOISE = /^(hd|sd|uhd|fhd|4k|tv|channel|live|in|india|source|src|backup|\d{3,4}p)$/;
const nameToks = s => dropKids(String(s || '').toLowerCase()
  .replace(/\(([^)]*)\)|\[([^\]]*)\]/g, (m, a, b) => LANGS.has((a || b || '').trim()) ? ' ' + (a || b).trim() + ' ' : ' ')
  .replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(w => w && !NOISE.test(w)));
const dropKids = t => t.includes('yay') ? t.filter(w => w !== 'kids' && w !== 'kid') : t;
const nameKey = s => { const t = nameToks(s); return { k: t.join(''), t }; };

function nameScore(p, g) {
  if (!p.k || !g.k) return 0;
  if (p.k === g.k) return 70;
  const gs = new Set(g.t), ps = new Set(p.t);
  const inter = p.t.filter(w => gs.has(w));
  if (!inter.length) return 0;
  const pOnly = p.t.filter(w => !gs.has(w)), gOnly = g.t.filter(w => !ps.has(w));
  if (!pOnly.every(w => SOFT.has(w)) || !gOnly.every(w => SOFT.has(w))) return 0;
  if (pOnly.some(w => LANGS.has(w)) && gOnly.some(w => LANGS.has(w))) return 0;
  if (inter.length < 2 && inter[0].length < 6) return 0;
  return inter.length * 10 - pOnly.length - gOnly.length;
}

function playlistKeys(c) {
  const out = [], seen = new Set();
  const add = s => { const x = nameKey(s); if (x.k && !seen.has(x.k)) { seen.add(x.k); out.push(x); } };
  add(c.name); add(c.tvgName);
  if (c.tvg && /\p{L}/u.test(c.tvg)) add(c.tvg.replace(/\.[a-z]{2,3}$/i, ''));
  for (const s of [c.name, c.tvgName]) { const a = s && EPG_ALIASES.get(String(s).trim().toLowerCase()); if (a) add(a); }
  return out;
}

function bestGuide(keys) {
  let best = null, bs = -Infinity;
  for (const g of epg.gidx.values()) {
    const n = (epg.byId.get(g.id) || []).length;
    for (const p of keys) for (const gk of g.ks) {
      let s = nameScore(p, gk); if (!s) continue;
      if (EPG_LANG && gk.t.includes(EPG_LANG) && !p.t.some(w => LANGS.has(w) && w !== EPG_LANG)) s += 60;
      s += n ? Math.min(n, 500) / 1000 : -1000;
      if (s > bs) { best = g.id; bs = s; }
    }
  }
  return best;
}

function rebuildEpgMap() {
  epg.map.clear(); epg.unmatched = []; let n = 0;
  for (const c of cache.list) {
    let id = null;
    const numeric = /^\d+$/.test(c.tvg || '');
    if (c.tvg && !numeric && epg.byId.has(c.tvg)) id = c.tvg;
    if (!id) id = bestGuide(playlistKeys(c));
    if (!id && c.tvg && numeric && EPG_NUMERIC_IDS && epg.byId.has(c.tvg)) id = c.tvg;
    if (id) { epg.map.set(c.id, id); n++; } else epg.unmatched.push(c.name);
  }
  epg.matched = n;
}

const xmlDecode = s => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
    e = e.toLowerCase();
    if (e[0] === '#') { const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return String.fromCodePoint(cp); } catch { return ''; } }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e];
  }).trim();
const xmlAttr = (attrs, name) => { const m = attrs.match(new RegExp('(?:^|\\s)' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')')); return m ? xmlDecode(m[1] ?? m[2]) : ''; };
const xmlText = (body, tag) => { const m = body.match(new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)</' + tag + '>')); return m ? xmlDecode(m[1]) : ''; };

function xmltvTime(v) {
  const m = String(v).trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?\s*([+-]\d{2}):?(\d{2})?/);
  if (!m) return NaN;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  if (!m[7]) return t;
  const off = (Math.abs(+m[7]) * 60 + +(m[8] || 0)) * (m[7][0] === '-' ? -1 : 1);
  return t - off * 60_000;
}

async function parseXmltv(stream, onChannel, onProgramme) {
  const dec = new TextDecoder('utf-8');
  const re = /<channel\b([^>]*)>([\s\S]*?)<\/channel>|<programme\b([^>]*)>([\s\S]*?)<\/programme>/g;
  let buf = '';
  const run = () => {
    let m, last = 0; re.lastIndex = 0;
    while ((m = re.exec(buf))) { m[1] !== undefined ? onChannel(m[1], m[2]) : onProgramme(m[3], m[4]); last = re.lastIndex; }
    buf = last ? buf.slice(last) : (buf.length > 5e6 ? buf.slice(-1e6) : buf);
  };
  for await (const chunk of stream) { buf += dec.decode(chunk, { stream: true }); run(); }
  buf += dec.decode(); run();
}

async function openXml(readable) {
  const it = readable[Symbol.asyncIterator]();
  const first = await it.next();
  if (first.done) return Readable.from([]);
  const src = Readable.from((async function* () { yield first.value; for (;;) { const n = await it.next(); if (n.done) return; yield n.value; } })());
  if (first.value[0] === 0x1f && first.value[1] === 0x8b) {
    const gz = zlib.createGunzip(); src.on('error', e => gz.destroy(e)); return src.pipe(gz);
  }
  return src;
}

const titleKey = t => String(t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
function borrowPictures(byId, gidx, oldPics) {
  const byKey = new Map();
  for (const g of gidx.values()) for (const x of g.ks) { if (!byKey.has(x.k)) byKey.set(x.k, new Set()); byKey.get(x.k).add(g.id); }
  let n = 0;
  for (const g of gidx.values()) {
    const mine = byId.get(g.id); if (!mine || mine.every(p => p.i)) continue;
    const sibs = new Set(); for (const x of g.ks) for (const id of byKey.get(x.k) || []) if (id !== g.id) sibs.add(id);
    const pics = [...sibs].flatMap(id => (byId.get(id) || []).filter(p => p.i));
    const byTitle = new Map();
    for (const q of pics) { const k = titleKey(q.t); if (k && !byTitle.has(k)) byTitle.set(k, q.i); }
    for (const id of sibs) for (const [k, img] of (oldPics && oldPics.get(id)) || []) { if (!byTitle.has(k)) byTitle.set(k, img); }
    if (!pics.length && !byTitle.size) continue;
    for (const p of mine) {
      if (p.i) continue;
      const half = (p.e - p.s) / 2;
      const q = pics.find(q => Math.min(p.e, q.e) - Math.max(p.s, q.s) >= half);
      const img = (q && q.i) || byTitle.get(titleKey(p.t));
      if (img) { p.i = img; n++; }
    }
  }
  return n;
}

let epgRunning = false;
async function refreshEpg() {
  if (epgRunning) return; epgRunning = true;
  const t0 = Date.now(), lo = t0 - EPG_PAST_MS, hi = t0 + EPG_FUTURE_MS;
  const byId = new Map(), gidx = new Map(), imgHosts = new Set(), oldPics = new Map(), errors = []; let xmlChannels = 0, programmes = 0, ok = 0;
  try {
    if (!cache.list.length) await loadChannels().catch(() => {});
    const configured = [...new Set([...(process.env.EPG_URL || '').split(','), ...playlistEpgUrls].map(s => s.trim()).filter(Boolean))];
    const file = EPG_FILES.find(f => fs.existsSync(f));
    const urls = configured.length || file ? configured : DEFAULT_EPG_URLS;
    const sources = urls.map(u => ({ url: u }));
    if (file) sources.push({ file });

    const wantIds = new Set(), wanted = new Set();
    const byTok = new Map();
    for (const c of cache.list) {
      for (const p of playlistKeys(c)) for (const w of new Set([...p.t, p.k])) { if (!byTok.has(w)) byTok.set(w, []); byTok.get(w).push(p); }
      if (c.tvg && (!/^\d+$/.test(c.tvg) || EPG_NUMERIC_IDS)) wantIds.add(c.tvg);
    }
    const looksLikeOurs = gk => { for (const w of new Set([...gk.t, gk.k])) for (const p of byTok.get(w) || []) if (nameScore(p, gk)) return true; return false; };
    for (const src of sources) {
      const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), 5 * 60_000);
      try {
        let raw;
        if (src.file) raw = fs.createReadStream(src.file);
        else {
          const up = await fetchUA(new URL(src.url), { 'Accept-Encoding': 'identity' }, ac.signal);
          if (!up.ok) throw new Error('HTTP ' + up.status);
          raw = Readable.fromWeb(up.body);
        }
        await parseXmltv(await openXml(raw),
          (attrs, body) => {
            const id = xmlAttr(attrs, 'id'); if (!id) return;
            xmlChannels++;
            const names = [...body.matchAll(/<display-name\b[^>]*>([\s\S]*?)<\/display-name>/g)].map(m => xmlDecode(m[1]));
            if (/\p{L}/u.test(id)) names.push(id.replace(/\.[a-z]{2,3}$/i, ''));
            const ks = [], seen = new Set();
            for (const n of names) { const x = nameKey(n); if (x.k && !seen.has(x.k)) { seen.add(x.k); ks.push(x); } }
            if (!(wantIds.has(id) || ks.some(looksLikeOurs))) return;
            wanted.add(id);
            const old = gidx.get(id);
            if (old) { for (const x of ks) if (!old.ks.some(y => y.k === x.k)) old.ks.push(x); }
            else gidx.set(id, { id, name: names[0] || id, ks });
          },
          (attrs, body) => {
            const ch = xmlAttr(attrs, 'channel'); if (!ch || !wanted.has(ch)) return;
            const s = xmltvTime(xmlAttr(attrs, 'start')), e = xmltvTime(xmlAttr(attrs, 'stop'));
            if (!(s < e)) return;
            const ic = (body.match(/<icon\b[^>]*?\bsrc\s*=\s*"([^"]+)"/) || [])[1];
            if (e < lo || s > hi) {
              if (ic && /^https:\/\//i.test(ic)) { const k = titleKey(xmlText(body, 'title')); if (k) { let m = oldPics.get(ch); if (!m) oldPics.set(ch, m = new Map()); m.set(k, xmlDecode(ic)); try { imgHosts.add(new URL(xmlDecode(ic)).hostname.toLowerCase()); } catch {} } }
              return;
            }
            const t = xmlText(body, 'title'); if (!t) return;
            let list = byId.get(ch); if (!list) byId.set(ch, list = []);
            const img = ic ? xmlDecode(ic) : '';
            let host = ''; if (/^https:\/\//i.test(img)) { try { host = new URL(img).hostname.toLowerCase(); } catch {} }
            if (host) imgHosts.add(host);
            list.push({ s, e, t, d: xmlText(body, 'desc').slice(0, 500), ...(host ? { i: img } : {}) });
            programmes++;
          });
        ok++;
      } catch (e) { errors.push((src.file ? 'file' : src.url) + ': ' + e.message); }
      finally { clearTimeout(timer); }
    }
    if (ok) {
      for (const [id, list] of byId) {
        list.sort((a, b) => a.s - b.s);
        byId.set(id, list.filter((p, i) => !i || p.s !== list[i - 1].s));
      }
      borrowPictures(byId, gidx, oldPics);
      epg.byId = byId; epg.gidx = gidx; epg.imgHosts = imgHosts; epg.programmes = programmes; epg.xmlChannels = xmlChannels;
      epg.sources = ok; epg.updated = Date.now(); rebuildEpgMap();
    }
    epg.error = errors.join(' | ');
  } catch (e) { epg.error = e.message; }
  finally { epgRunning = false; }
}

function nowNext(chId, t = Date.now()) {
  const list = epg.byId.get(epg.map.get(chId));
  if (!list) return null;
  const i = list.findIndex(p => p.e > t);
  if (i < 0) return null;
  const now = list[i].s <= t ? list[i] : null;
  return { now, next: (now ? list[i + 1] : list[i]) || null, list, i };
}
const short = p => p && { t: p.t, s: p.s, e: p.e };

app.get('/api/epg', async (req, res) => {
  if (!cache.list.length) await loadChannels().catch(() => {});
  const ch = {};
  for (const c of cache.list) { const x = nowNext(c.id); if (x) ch[c.id] = { n: short(x.now), x: short(x.next) }; }
  res.set('Cache-Control', 'no-store').json({ updated: epg.updated, ch });
});

app.get('/api/epg/guide', async (req, res) => {
  if (!cache.list.length) await loadChannels().catch(() => {});
  const DAY = 24 * 3_600_000;
  const from = Number(req.query.from) || Date.now() - 3_600_000;
  let to = Number(req.query.to); if (!(to > from)) to = from + DAY;
  to = Math.min(to, from + 36 * 3_600_000);
  const groups = new Map();
  for (const c of cache.list) {
    const g = epg.map.get(c.id); if (!g) continue;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(c.id);
  }
  const rows = [], pics = [], pidx = new Map();
  const pic = u => { let n = pidx.get(u); if (n === undefined) { n = pics.length; pics.push(u); pidx.set(u, n); } return n; };
  for (const [g, ids] of groups) {
    const p = (epg.byId.get(g) || []).filter(x => x.e > from && x.s < to).map(x => x.i ? [x.s, x.e, x.t, pic(x.i)] : [x.s, x.e, x.t]);
    if (p.length) rows.push({ ids, p });
  }
  res.set('Cache-Control', 'no-store').json({ updated: epg.updated, from, to, rows, pics });
});

app.get('/api/epg/img', async (req, res) => {
  let u; try { u = new URL(String(req.query.u || '')); } catch { return res.sendStatus(400); }
  if (u.protocol !== 'https:' || !(epg.imgHosts.has(u.hostname.toLowerCase()) || posterHosts.has(u.hostname.toLowerCase()))) return res.sendStatus(403);
  const ac = new AbortController(); res.on('close', () => ac.abort());
  try {
    const up = await fetchFollow(u, { 'User-Agent': UA, Accept: 'image/*' }, ac.signal);
    const ct = up.headers.get('content-type') || '';
    if (!up.ok || !/^image\//i.test(ct)) { try { await up.body?.cancel(); } catch {} return res.sendStatus(404); }
    const buf = Buffer.from(await up.arrayBuffer());
    if (buf.length > 3_000_000) return res.sendStatus(413);
    res.set({ 'Content-Type': ct, 'Cache-Control': 'public, max-age=86400' }).send(buf);
  } catch { if (!res.headersSent) res.sendStatus(502); }
});

/* POSTERS MODULE */
const TMDB_KEY = (process.env.TMDB_API_KEY || '').trim();
const POSTER_FILE = path.join(require('os').tmpdir(), 'tamil-iptv-posters.json');
const posters = new Map();
const posterHosts = new Set();
const POSTER_OK_MS = 14 * 24 * 3_600_000, POSTER_NO_MS = 24 * 3_600_000;
const posterHost = u => { try { const x = new URL(u); if (x.protocol === 'https:') posterHosts.add(x.hostname.toLowerCase()); } catch {} };
try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(POSTER_FILE, 'utf8')))) { posters.set(k, v); if (v.u) posterHost(v.u); } } catch {}
let posterSave = 0;
const savePosters = () => { clearTimeout(posterSave); posterSave = setTimeout(() => { try { fs.writeFileSync(POSTER_FILE, JSON.stringify(Object.fromEntries(posters))); } catch {} }, 5000); if (posterSave.unref) posterSave.unref(); };

const cleanTitle = t => String(t || '').replace(/\(.*?\)|\[.*?\]/g, ' ')
  .replace(/\b(?:ep(?:isode)?\.?\s*#?\d+|e\d+|s\d+\s*e\d+|part\s*\d+|season\s*\d+|s\d+)\b/gi, ' ')
  .replace(/\s*[-–:|]\s*(?:live|special|new|repeat|re-?telecast)\b.*$/i, ' ')
  .replace(/\s+(?:special|spl)$/i, ' ').replace(/\s+(?!(?:19|20)\d\d$)\d{2,4}$/, ' ').replace(/\s+/g, ' ').trim();
const GENERIC = new Set(['news', 'songs', 'song', 'hits', 'hit', 'movie', 'movies', 'film', 'music', 'video', 'videos', 'top', 'tamil', 'serial', 'show', 'shows', 'live', 'special', 'comedy', 'kitchen', 'weather', 'headlines', 'bulletin', 'devotional', 'slot', 'programme', 'program', 'telecast', 'repeat', 'welcome', 'cartoon', 'kids', 'day', 'night', 'morning', 'evening', 'time', 'best', 'of', 'the', 'and', 'in']);
const posterUsable = t => { const w = t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean); return titleKey(t).length >= 4 && w.some(x => !GENERIC.has(x)); };
const similar = (a, b) => {
  const x = titleKey(a), y = titleKey(b); if (!x || !y) return false;
  if (x === y) return true;
  const [s, l] = x.length <= y.length ? [x, y] : [y, x];
  return s.length >= 6 && l.startsWith(s) && s.length / l.length >= 0.6;
};
async function jget(url, headers) {
  const ac = new AbortController(), timer = setTimeout(() => ac.abort(), 6000);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': UA, Accept: 'application/json', ...headers } });
    return r.ok ? await r.json() : null;
  } catch { return null; } finally { clearTimeout(timer); }
}
const enc = encodeURIComponent;
const POSTER_SOURCES = [
  ['tmdb', async q => {
    if (!TMDB_KEY) return '';
    const bearer = TMDB_KEY.length > 40;
    const d = await jget(`https://api.themoviedb.org/3/search/multi?query=${enc(q)}&include_adult=false${bearer ? '' : '&api_key=' + enc(TMDB_KEY)}`, bearer ? { Authorization: 'Bearer ' + TMDB_KEY } : {});
    const hits = ((d && d.results) || []).filter(r => (r.media_type === 'movie' || r.media_type === 'tv') && r.poster_path &&
      [r.title, r.name, r.original_title, r.original_name].some(n => n && similar(n, q)));
    hits.sort((a, b) => (b.original_language === 'ta') - (a.original_language === 'ta') || (b.popularity || 0) - (a.popularity || 0));
    return hits[0] ? 'https://image.tmdb.org/t/p/w342' + hits[0].poster_path : '';
  }],
  ['tvmaze', async q => {
    const d = await jget(`https://api.tvmaze.com/search/shows?q=${enc(q)}`);
    const hits = (Array.isArray(d) ? d : []).map(x => x.show).filter(s => s && s.image && s.image.medium && similar(s.name, q));
    hits.sort((a, b) => (b.language === 'Tamil') - (a.language === 'Tamil'));
    return hits[0] ? hits[0].image.medium.replace(/^http:/, 'https:') : '';
  }],
  ['itunes', async q => {
    const d = await jget(`https://itunes.apple.com/search?term=${enc(q)}&media=movie&country=in&limit=6`);
    const hit = ((d && d.results) || []).find(r => r.artworkUrl100 && similar(r.trackName, q));
    return hit ? hit.artworkUrl100.replace(/\/\d+x\d+bb\./, '/300x450bb.') : '';
  }],
  ['wikipedia', async q => {
    const d = await jget(`https://en.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${enc(q + ' tamil')}&gsrlimit=4&prop=pageimages&piprop=thumbnail&pithumbsize=400&format=json`);
    const pages = Object.values((d && d.query && d.query.pages) || {}).sort((a, b) => a.index - b.index);
    const hit = pages.find(p => p.thumbnail && p.thumbnail.source && similar(String(p.title).replace(/\s*\((?:[^)]*(?:film|series|TV|show|serial)[^)]*)\)\s*$/i, ''), q));
    return hit ? hit.thumbnail.source : '';
  }],
];
const posterBusy = new Map(); let posterRunning = 0; const posterQueue = [];
async function posterFor(title) {
  const q = cleanTitle(title), key = titleKey(q);
  if (!posterUsable(q)) return null;
  const hit = posters.get(key);
  if (hit && Date.now() - hit.at < (hit.u ? POSTER_OK_MS : POSTER_NO_MS)) return hit.u ? hit : null;
  if (posterBusy.has(key)) return posterBusy.get(key);
  const p = (async () => {
    while (posterRunning >= 3) await new Promise(r => posterQueue.push(r));
    posterRunning++;
    try {
      let found = { u: '', s: '', at: Date.now() };
      for (const [name, fn] of POSTER_SOURCES) {
        let u = ''; try { u = await fn(q); } catch {}
        if (u && /^https:\/\//i.test(u)) { found = { u, s: name, at: Date.now() }; break; }
      }
      posters.set(key, found); if (found.u) posterHost(found.u);
      if (posters.size > 5000) posters.delete(posters.keys().next().value);
      savePosters();
      return found.u ? found : null;
    } finally { posterRunning--; const n = posterQueue.shift(); if (n) n(); posterBusy.delete(key); }
  })();
  posterBusy.set(key, p);
  return p;
}

app.get('/api/epg/poster', async (req, res) => {
  const r = await posterFor(String(req.query.t || '').slice(0, 200)).catch(() => null);
  res.set('Cache-Control', 'public, max-age=3600').json(r ? { u: '/api/epg/img?u=' + enc(r.u), s: r.s } : { u: '', s: '' });
});

app.get('/api/epg/match', async (req, res) => {
  if (!cache.list.length) await loadChannels().catch(() => {});
  const q = String(req.query.q || '').toLowerCase();
  const rows = cache.list.filter(c => !q || c.name.toLowerCase().includes(q)).slice(0, 200).map(c => {
    const g = epg.map.get(c.id), x = g && epg.gidx.get(g);
    return { id: c.id, channel: c.name, guide: g ? { id: g, name: x ? x.name : g, programmes: (epg.byId.get(g) || []).length } : null };
  });
  res.set('Cache-Control', 'no-store').json({ updated: epg.updated, matched: epg.matched, total: cache.list.length, unmatched: epg.unmatched, rows });
});

app.get('/api/epg/:id', async (req, res) => {
  if (!cache.list.length) await loadChannels().catch(() => {});
  const x = nowNext(Number(req.params.id));
  if (!x) return res.set('Cache-Control', 'no-store').json({ updated: epg.updated, list: [] });
  res.set('Cache-Control', 'no-store').json({ updated: epg.updated, list: req.query.full === '1' ? x.list : x.list.slice(x.i, x.i + 12) });
});

setTimeout(() => refreshEpg(), 3000);
setInterval(() => refreshEpg(), EPG_REFRESH_MS).unref();

app.disable('x-powered-by');
app.get('/health', (req, res) => res.json({ ok: true, channels: cache.list.length,
  epg: { updated: epg.updated, programmes: epg.programmes, matched: epg.matched, sources: epg.sources, error: epg.error, unmatched: epg.unmatched.slice(0, 40) } }));

app.get('/api/sniff', async (req, res) => {
  if (!cache.list.length) await loadChannels().catch(() => {});
  const chan = cache.list[Number(req.query.ch)];
  res.set('Cache-Control', 'no-store');
  if (!chan) return res.status(404).json({ ok: false, reason: 'Unknown channel' });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15_000);
  res.on('close', () => ac.abort());
  try {
    const up = await fetchUA(new URL(chan.url), { 'User-Agent': UA, ...(chan._h || {}) }, ac.signal, {}, chan._h && chan._h['User-Agent']);
    const out = { ok: up.ok, status: up.status, ct: up.headers.get('content-type') || '', ua: up.ua, host: new URL(chan.url).hostname };
    if (!up.ok) { try { await up.body?.cancel(); } catch {} out.reason = httpReason(up.status); return res.json(out); }
    const reader = up.body.getReader(), parts = []; let n = 0;
    while (n < 4096) { const { value, done } = await reader.read(); if (done) break; parts.push(Buffer.from(value)); n += value.length; }
    reader.cancel().catch(() => {});
    out.kind = sniffKind(Buffer.concat(parts));
    if (out.kind === 'html') out.reason = 'Web page returned instead of stream.';
    else if (out.kind === 'empty') out.reason = 'Server sent no data.';
    else if (out.kind === 'unknown') out.reason = 'Unrecognised format.';
    res.json(out);
  } catch (e) {
    res.json({ ok: false, reason: ac.signal.aborted ? 'Timeout.' : 'Connection error: ' + e.message });
  } finally { clearTimeout(timer); }
});

app.get('/api/channels', async (req, res) => {
  try { res.json((await loadChannels(req.query.fresh === '1')).map(({ _h, ...c }) => c)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Proxy Handler - Updated to eliminate HTTP 500 crashes and relay DRM headers smoothly
const proxyHandler = async (req, res) => {
  let url;
  try { url = new URL(String(req.query.url || '')); } catch { return res.status(400).send('bad url'); }
  if (!cache.list.length) await loadChannels().catch(() => {});
  
  const chan = cache.list[Number(req.query.ch)];
  allowed.add(url.hostname.toLowerCase());

  const ac = new AbortController();
  res.on('close', () => ac.abort());
  try {
    const headers = { 'User-Agent': UA, ...((chan && chan._h) || {}) };
    if (req.headers.range) headers.Range = req.headers.range;
    const init = {};
    
    if (req.method === 'POST') {
      init.method = 'POST';
      if (Buffer.isBuffer(req.body) && req.body.length) init.body = req.body;
      for (const [k, v] of Object.entries(req.headers)) {
        if (!/^(host|connection|content-length|origin|referer|cookie|accept-encoding|accept-language|user-agent|upgrade|sec-|priority|range|if-|x-forwarded|x-real-ip|x-render|x-request-id|x-final-url|cf-|cdn-loop|true-client-ip|rndr-)/.test(k)) headers[k] = v;
      }
    }
    
    let up;
    if (req.method === 'GET' && !req.headers.range) {
      const pend = inflight.get(url.href); if (pend) await pend;
      const hit = warmGet(url.href);
      if (hit) {
        up = new Response(hit.buf, { status: 200, headers: { 'content-length': String(hit.buf.length), ...(hit.ct ? { 'content-type': hit.ct } : {}) } });
        up.finalUrl = hit.finalUrl;
      }
    }
    
    if (!up) {
      try {
        up = await fetchUA(url, headers, ac.signal, init, chan && chan._h && chan._h['User-Agent']);
      } catch (err) {
        // Handle render 500 error & connection drops smoothly
        return res.status(502).set('Access-Control-Allow-Origin', '*').send('Upstream connection error: ' + err.message);
      }
    }

    if (up.status >= 500) {
      return res.status(502).set('Access-Control-Allow-Origin', '*').send(`Upstream JioTV Server Error: HTTP ${up.status}`);
    }

    res.status(up.status).set({ 
      'Access-Control-Allow-Origin': '*', 
      'Access-Control-Expose-Headers': 'Content-Length, Content-Range, X-Final-Url', 
      'X-Final-Url': up.finalUrl 
    });

    const ct = up.headers.get('content-type') || '';
    const looksPlaylist = /mpegurl/i.test(ct) || /\.m3u8?(\?|$)/i.test(url.pathname);
    const maybePlaylist = req.method === 'GET' && !looksPlaylist && /^(text\/|application\/(octet-stream|x-?unknown)|$)/i.test(ct) && !req.headers.range;
    
    const sendPlaylist = text => {
      const w = req.query.w === '1';
      if (w) { try { prefetchFrom(text, up.finalUrl, chan); } catch {} }
      return res.type('application/vnd.apple.mpegurl').set('Cache-Control', 'no-store')
        .send(rewriteM3U8(text, up.finalUrl, chan ? chan.id : null, req.query.nc === '1', w));
    };

    if (looksPlaylist) {
      const text = await up.text();
      if (up.ok && !/^\s*#EXTM3U/.test(text)) return res.status(502).send('upstream did not return a valid playlist');
      return up.ok ? sendPlaylist(text) : res.send(text);
    }
    if (!up.body) return res.end();
    
    const reader = Readable.fromWeb(up.body);
    if (maybePlaylist) {
      const first = await new Promise((ok, no) => {
        reader.once('readable', () => ok(reader.read() || Buffer.alloc(0)));
        reader.once('end', () => ok(Buffer.alloc(0))); reader.once('error', no);
      });
      if (first.slice(0, 64).toString('utf8').replace(/^\uFEFF/, '').trimStart().startsWith('#EXTM3U')) {
        const chunks = [first]; for await (const c of reader) chunks.push(c);
        return sendPlaylist(Buffer.concat(chunks).toString('utf8'));
      }
      reader.unshift(first);
    }
    
    for (const h of ['content-type', 'content-range', 'accept-ranges']) {
      const v = up.headers.get(h);
      if (v) res.set(h, v);
    }
    if (!up.headers.get('content-encoding')) { const l = up.headers.get('content-length'); if (l) res.set('content-length', l); }
    res.set('Cache-Control', req.method === 'POST' || !up.headers.get('content-length') ? 'no-store' : 'public, max-age=5');
    reader.on('error', () => res.end()).pipe(res);
  } catch (e) {
    if (!res.headersSent) res.status(502).set('Access-Control-Allow-Origin', '*').send('Proxy handling error: ' + e.message);
  }
};

app.get('/proxy', proxyHandler);
app.post('/proxy', express.raw({ type: () => true, limit: '1mb' }), proxyHandler);

require('./diag')(app, { list: () => cache.list, load: loadChannels, fetchUA, UA, sniffKind, httpReason });
require('./pulse')(app);
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '5m' }));
app.use((req, res) => res.status(404).send('Not found'));
process.on('unhandledRejection', e => console.error('unhandled:', e));

app.listen(PORT, '0.0.0.0', () => console.log('Tamil IPTV listening on ' + PORT));
