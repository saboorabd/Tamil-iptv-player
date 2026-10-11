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
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const allowed = new Set((process.env.ALLOWED_HOSTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
let cache = { at: 0, list: [] };

const HEADER_NAMES = {
  'cookie': 'Cookie', 'referer': 'Referer', 'referrer': 'Referer', 'http-referrer': 'Referer',
  'user-agent': 'User-Agent', 'http-user-agent': 'User-Agent', 'origin': 'Origin', 'authorization': 'Authorization'
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
  const cleanText = text.replace(/^\uFEFF/, '');
  for (const raw of cleanText.split(/\r?\n/)) {
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
      try { allowed.add(new URL(cur.url).hostname.toLowerCase()); } catch { cur = null; continue; }
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
  if (process.env.ALLOW_PRIVATE) return;
  const hit = dnsOk.get(url.hostname);
  if (hit && Date.now() - hit < 30_000) return;
  const addrs = await dns.lookup(url.hostname, { all: true });
  if (addrs.some(a => isPrivate(a.address))) throw new Error('private address blocked');
  dnsOk.set(url.hostname, Date.now());
  if (dnsOk.size > 500) dnsOk.clear();
}

const UPSTREAM_TIMEOUT = 25_000;

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
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
];
const uaByHost = new Map();
const uaGaveUp = new Map();

async function fetchUA(url, headers, signal, init = {}, ownUA = '') {
  const host = url.hostname.toLowerCase(), key = url.origin + url.pathname;
  const remembered = uaByHost.get(host);
  const order = [...new Set((ownUA ? [ownUA] : [remembered, headers['User-Agent'] || UA]).concat(UA_POOL).filter(Boolean))];
  const gaveUp = Date.now() - (uaGaveUp.get(key) || 0) < 60_000;
  let last;
  for (let i = 0; i < order.length && i < 5; i++) {
    last = await fetchFollow(url, { ...headers, 'User-Agent': order[i] }, signal, init);
    last.ua = order[i];
    if (last.status < 400) { uaByHost.set(host, order[i]); uaGaveUp.delete(key); return last; }
    const uaIssue = [401, 403, 406, 451].includes(last.status);
    if (gaveUp || !(uaIssue || (!remembered && last.status !== 416))) return last;
    if (i < order.length - 1 && i < 4) { try { await last.body?.cancel(); } catch {} }
  }
  uaGaveUp.set(key, Date.now());
  if (uaGaveUp.size > 500) uaGaveUp.clear();
  return last;
}

const httpReason = s =>
  s === 401 || s === 403 ? `Server refused (HTTP ${s}). Needs token or blocks cloud IPs.` :
  s === 404 || s === 410 ? `Stream not found (HTTP ${s}). Link expired.` : `Server answered HTTP ${s}.`;

function rewriteM3U8(text, base, ch) {
  const px = u => {
    const abs = new URL(u, base);
    allowed.add(abs.hostname.toLowerCase());
    return '/proxy?' + (ch != null ? 'ch=' + ch + '&' : '') + 'url=' + encodeURIComponent(abs.href);
  };
  return text.split(/\r?\n/).map(l => {
    if (!l.trim()) return l;
    if (l.startsWith('#')) return l.replace(/URI="([^"]+)"/g, (m, u) => `URI="${px(u)}"`);
    return px(l.trim());
  }).join('\n');
}

/* EPG Support */
const EPG_REFRESH_MS = 3 * 3_600_000;
const EPG_FILES = ['public/epg.xml', 'public/epg.xml.gz', 'epg.xml', 'epg.xml.gz'].map(f => path.join(__dirname, f));
const EPG_PAST_MS = 3 * 3_600_000, EPG_FUTURE_MS = 48 * 3_600_000;
let playlistEpgUrls = [];
const TVEPG = 'https://raw.githubusercontent.com/mitthu786/tvepg/main/';
const DEFAULT_EPG_URLS = [TVEPG + 'tataplay/epg.xml.gz', TVEPG + 'epg.xml.gz', TVEPG + 'jiotv/epg.xml.gz'];
const EPG_NUMERIC_IDS = process.env.EPG_MATCH_NUMERIC_IDS === '1';
const epg = { updated: 0, error: '', sources: 0, programmes: 0, xmlChannels: 0, matched: 0, byId: new Map(), names: new Map(), map: new Map() };

function epgUrlsFromPlaylist(text) {
  const m = text.match(/^#EXTM3U[^\r\n]*?\b(?:url-tvg|x-tvg-url)\s*=\s*"([^"]+)"/im);
  return m ? m[1].split(',').map(s => s.trim()).filter(u => /^https?:\/\//i.test(u)) : [];
}

const normName = s => String(s || '').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, ' ')
  .replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(w => w && !/^(hd|sd|uhd|fhd|tv|channel|live)$/.test(w)).join('');

function rebuildEpgMap() {
  epg.map.clear(); let n = 0;
  for (const c of cache.list) {
    let id = null;
    const numeric = /^\d+$/.test(c.tvg || '');
    if (c.tvg && !numeric && epg.byId.has(c.tvg)) id = c.tvg;
    for (const nm of [c.tvgName, c.name]) { if (!id && nm) id = epg.names.get(normName(nm)) || null; }
    if (!id && c.tvg && numeric && EPG_NUMERIC_IDS && epg.byId.has(c.tvg)) id = c.tvg;
    if (id) { epg.map.set(c.id, id); n++; }
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

let epgRunning = false;
async function refreshEpg() {
  if (epgRunning) return; epgRunning = true;
  const t0 = Date.now(), lo = t0 - EPG_PAST_MS, hi = t0 + EPG_FUTURE_MS;
  const byId = new Map(), names = new Map(), errors = []; let xmlChannels = 0, programmes = 0, ok = 0;
  try {
    if (!cache.list.length) await loadChannels().catch(() => {});
    const configured = [...new Set([...(process.env.EPG_URL || '').split(','), ...playlistEpgUrls].map(s => s.trim()).filter(Boolean))];
    const file = EPG_FILES.find(f => fs.existsSync(f));
    const urls = configured.length || file ? configured : DEFAULT_EPG_URLS;
    const sources = urls.map(u => ({ url: u }));
    if (file) sources.push({ file });

    const wantNames = new Set(), wantIds = new Set(), wanted = new Set();
    for (const c of cache.list) {
      for (const n of [c.name, c.tvgName]) { const k = normName(n); if (k) wantNames.add(k); }
      if (c.tvg && (!/^\d+$/.test(c.tvg) || EPG_NUMERIC_IDS)) wantIds.add(c.tvg);
    }
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
            const keys = [normName(id.replace(/\.[a-z]{2,3}$/i, ''))];
            for (const m of body.matchAll(/<display-name\b[^>]*>([\s\S]*?)<\/display-name>/g)) keys.push(normName(xmlDecode(m[1])));
            if (!(wantIds.has(id) || keys.some(k => k && wantNames.has(k)))) return;
            wanted.add(id);
            for (const k of keys) if (k && !names.has(k)) names.set(k, id);
          },
          (attrs, body) => {
            const ch = xmlAttr(attrs, 'channel'); if (!ch || !wanted.has(ch)) return;
            const s = xmltvTime(xmlAttr(attrs, 'start')), e = xmltvTime(xmlAttr(attrs, 'stop'));
            if (!(s < e) || e < lo || s > hi) return;
            const t = xmlText(body, 'title'); if (!t) return;
            let list = byId.get(ch); if (!list) byId.set(ch, list = []);
            list.push({ s, e, t, d: xmlText(body, 'desc').slice(0, 500) });
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
      epg.byId = byId; epg.names = names; epg.programmes = programmes; epg.xmlChannels = xmlChannels;
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
app.get('/api/epg/:id', async (req, res) => {
  if (!cache.list.length) await loadChannels().catch(() => {});
  const x = nowNext(Number(req.params.id));
  if (!x) return res.set('Cache-Control', 'no-store').json({ updated: epg.updated, list: [] });
  res.set('Cache-Control', 'no-store').json({ updated: epg.updated, list: x.list.slice(x.i, x.i + 12) });
});
setTimeout(() => refreshEpg(), 3000);
setInterval(() => refreshEpg(), EPG_REFRESH_MS).unref();

app.disable('x-powered-by');
app.get('/health', (req, res) => res.json({ ok: true, channels: cache.list.length }));

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
    res.json(out);
  } catch (e) {
    res.json({ ok: false, reason: 'Could not connect to the stream server' });
  } finally { clearTimeout(timer); }
});

app.get('/api/channels', async (req, res) => {
  try { res.json((await loadChannels(req.query.fresh === '1')).map(({ _h, ...c }) => c)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.options('/proxy', (req, res) => {
  res.set({ 
    'Access-Control-Allow-Origin': '*', 
    'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || 'Range, Content-Type, Authorization', 
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' 
  }).sendStatus(204);
});

const proxyHandler = async (req, res) => {
  let url;
  try { url = new URL(String(req.query.url || '')); } catch { return res.status(400).send('bad url'); }
  if (!cache.list.length) await loadChannels().catch(() => {});
  const known = !!cache.list[Number(req.query.ch)];
  if (!allowed.has(url.hostname.toLowerCase()) && (process.env.STRICT_HOSTS === '1' || !known)) return res.status(403).send('host not in playlist');

  const chan = cache.list[Number(req.query.ch)];
  const headers = { 'User-Agent': UA, ...((chan && chan._h) || {}) };
  if (req.headers.range) headers['Range'] = req.headers.range;
  if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];

  const init = { method: req.method };
  if (req.method === 'POST' && req.body) {
    init.body = Buffer.isBuffer(req.body) ? req.body : JSON.stringify(req.body);
  }

  const ac = new AbortController();
  req.on('close', () => ac.abort());

  try {
    const upstreamRes = await fetchUA(url, headers, ac.signal, init, chan && chan._h && chan._h['User-Agent']);
    
    const resHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'Content-Length, Content-Range, X-Final-Url',
      'X-Final-Url': upstreamRes.finalUrl || url.href
    };

    ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag'].forEach(h => {
      const v = upstreamRes.headers.get(h);
      if (v) resHeaders[h] = v;
    });

    const ct = upstreamRes.headers.get('content-type') || '';
    const looksPlaylist = /mpegurl/i.test(ct) || /\.m3u8?(\?|$)/i.test(url.pathname);

    if (looksPlaylist) {
      const text = await upstreamRes.text();
      const rewritten = rewriteM3U8(text, upstreamRes.finalUrl || url.href, chan ? chan.id : null);
      res.writeHead(upstreamRes.status, resHeaders);
      return res.end(rewritten);
    }

    res.writeHead(upstreamRes.status, resHeaders);
    if (upstreamRes.body) {
      const nodeStream = Readable.fromWeb(upstreamRes.body);
      nodeStream.on('error', () => {});
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    if (!res.headersSent) {
      res.status(502).set('Access-Control-Allow-Origin', '*').send('proxy error: ' + err.message);
    }
  }
};

app.get('/proxy', proxyHandler);
app.post('/proxy', express.raw({ type: () => true, limit: '2mb' }), proxyHandler);

try {
  require('./pulse')(app);
} catch {}

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '5m' }));
app.use((req, res) => res.status(404).send('Not found'));
process.on('unhandledRejection', e => console.error('unhandled:', e));

app.listen(PORT, '0.0.0.0', () => console.log('Tamil IPTV listening on ' + PORT));
