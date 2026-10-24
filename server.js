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

// Global CORS Middleware
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, X-Final-Url');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

const allowed = new Set((process.env.ALLOWED_HOSTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
let cache = { at: 0, list: [] };

const HEADER_NAMES = {
  'cookie': 'Cookie', 'http-cookie': 'Cookie', 'referer': 'Referer', 'referrer': 'Referer', 'http-referrer': 'Referer',
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
      cur.proxy = !!(cur._h && Object.keys(cur._h).length);
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
    if (!f) throw new Error('playlist.m3u not found');
    text = fs.readFileSync(f, 'utf8');
  }
  cache = { at: Date.now(), list: parseM3U(text) };
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
  if (process.env.ALLOW_PRIVATE || url.hostname.includes('onrender.com')) return;
  try {
    const hit = dnsOk.get(url.hostname);
    if (hit && Date.now() - hit < 30_000) return;
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
  s === 401 || s === 403 ? `Server refused request (HTTP ${s}).` :
  s === 451 ? 'Blocked for legal/regional reasons (HTTP 451).' :
  s === 404 || s === 410 ? `Stream not found (HTTP ${s}).` :
  s === 429 ? 'Rate limited (HTTP 429).' :
  s >= 500 ? `Upstream server error (HTTP ${s}).` : `HTTP ${s}`;

app.disable('x-powered-by');
app.get('/health', (req, res) => res.json({ ok: true, channels: cache.list.length }));

app.get('/api/channels', async (req, res) => {
  try { res.json((await loadChannels(req.query.fresh === '1')).map(({ _h, ...c }) => c)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

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
        if (!/^(host|connection|content-length|origin|referer|cookie|accept-encoding|accept-language|user-agent|upgrade|sec-|range|if-|x-forwarded)/.test(k)) headers[k] = v;
      }
    }
    
    let up = await fetchUA(url, headers, ac.signal, init, chan && chan._h && chan._h['User-Agent']);
    
    res.status(up.status).set({ 
      'Access-Control-Allow-Origin': '*', 
      'Access-Control-Expose-Headers': 'Content-Length, Content-Range, X-Final-Url', 
      'X-Final-Url': up.finalUrl 
    });

    if (!up.body) return res.end();
    const reader = Readable.fromWeb(up.body);
    for (const h of ['content-type', 'content-range', 'accept-ranges']) {
      const v = up.headers.get(h);
      if (v) res.set(h, v);
    }
    reader.on('error', () => res.end()).pipe(res);
  } catch (e) {
    if (!res.headersSent) res.status(502).set('Access-Control-Allow-Origin', '*').send('Proxy error: ' + e.message);
  }
};

app.get('/proxy', proxyHandler);
app.post('/proxy', express.raw({ type: () => true, limit: '1mb' }), proxyHandler);

try { require('./diag')(app, { list: () => cache.list, load: loadChannels, fetchUA, UA, sniffKind, httpReason }); } catch {}
try { require('./pulse')(app); } catch {}

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '5m' }));
app.use((req, res) => res.status(404).send('Not found'));

process.on('unhandledRejection', e => console.error('unhandled:', e));
process.on('uncaughtException', e => console.error('uncaught:', e));

app.listen(PORT, '0.0.0.0', () => console.log('Tamil IPTV listening on ' + PORT));
