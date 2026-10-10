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

// Proxy only talks to hosts found in YOUR playlist (+ ALLOWED_HOSTS env).
const allowed = new Set((process.env.ALLOWED_HOSTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
let cache = { at: 0, list: [] };

const HEADER_NAMES = {
  'cookie': 'Cookie', 'referer': 'Referer', 'referrer': 'Referer', 'http-referrer': 'Referer', 'http-referer': 'Referer',
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
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const attr = k => (line.match(new RegExp(k + '="([^"]*)"', 'i')) || [])[1] || '';
      // channel name = text after the last comma that is NOT inside an attribute value
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
    } else if (line.startsWith('#EXTVLCOPT:') && cur) {          // #EXTVLCOPT:http-referrer=https://...
      const i = line.indexOf('=');
      if (i > 0) addHeader(cur, line.slice(11, i), line.slice(i + 1));
    } else if (line.startsWith('#KODIPROP:') && cur) {
      const [k, ...v] = line.slice(10).split('=');
      cur._k = cur._k || {};
      cur._k[k.trim()] = v.join('=').trim();
    } else if (!line.startsWith('#') && cur) {
      // Kodi-style "url|Header=Value&Header2=Value2" -> move the headers out of the URL
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
      if (!/^https?:\/\//i.test(cur.url)) { cur = null; continue; }   // skip rtmp:// etc. (not playable in a browser)
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
    if (!f) throw new Error('playlist.m3u not found (put it in public/playlist.m3u)');
    text = fs.readFileSync(f, 'utf8');
  }
  cache = { at: Date.now(), list: parseM3U(text) };
  playlistEpgUrls = epgUrlsFromPlaylist(text);
  rebuildEpgMap();
  return cache.list;
}

function isPrivate(ip) {
  ip = ip.replace(/^::ffff:/i, '');                       // IPv4-mapped IPv6 (::ffff:127.0.0.1)
  if (net.isIPv6(ip)) return ip === '::1' || ip === '::' || /^(fc|fd|fe[89ab])/i.test(ip);
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
         (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

const dnsOk = new Map();                                   // host -> time of last successful public-IP check
async function assertPublic(url) {
  if (!/^https?:$/.test(url.protocol)) throw new Error('bad protocol');
  if (process.env.ALLOW_PRIVATE) return;
  const hit = dnsOk.get(url.hostname);
  if (hit && Date.now() - hit < 30_000) return;           // avoid a DNS lookup for every single segment
  const addrs = await dns.lookup(url.hostname, { all: true });
  if (addrs.some(a => isPrivate(a.address))) throw new Error('private address blocked');
  dnsOk.set(url.hostname, Date.now());
  if (dnsOk.size > 500) dnsOk.clear();
}

const UPSTREAM_TIMEOUT = 20_000;                           // ms to wait for upstream response headers

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
      if (r.status !== 307 && r.status !== 308) opts = {};   // 301/302/303 -> plain GET
      continue;
    }
    r.finalUrl = url.href;
    return r;
  }
  throw new Error('too many redirects');
}

/* Many IPTV servers only answer certain apps (OTT Navigator, VLC, ExoPlayer ...) and refuse a browser-like or unknown
   User-Agent with 401/403/404. So when a request is refused we retry with other well-known player User-Agents, and
   remember the one that worked for that host (so segments do not need the retries again). A channel that sets its own
   User-Agent in the playlist (#EXTVLCOPT / #EXTHTTP / |User-Agent=) always gets that one first. */
const UA_POOL = [
  UA,
  'OTT Navigator/1.7.0.0 (Linux;Android 12) ExoPlayerLib/2.19.1',
  'VLC/3.0.20 LibVLC/3.0.20',
  'Lavf/60.16.100',
  'Dalvik/2.1.0 (Linux; U; Android 12; SM-G991B Build/SP1A.210812.016)',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
];
const uaByHost = new Map();       // hostname -> User-Agent that worked
const uaGaveUp = new Map();       // origin+path -> time we tried every User-Agent and all failed (do not hammer it again for 60 s)

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
    if (gaveUp || !(uaIssue || (!remembered && last.status !== 416))) return last;      // genuine error (e.g. expired segment): do not rotate
    if (i < order.length - 1 && i < 4) { try { await last.body?.cancel(); } catch {} }
  }
  uaGaveUp.set(key, Date.now());
  if (uaGaveUp.size > 500) uaGaveUp.clear();
  return last;
}

const httpReason = s =>
  s === 401 || s === 403 ? `The server refused the request (HTTP ${s}). The stream needs a login/token, a specific app, or blocks servers.` :
  s === 404 || s === 410 ? `Stream not found (HTTP ${s}). The link is dead or expired.` :
  s === 429 ? 'Too many requests (HTTP 429). The provider is rate-limiting.' :
  s >= 500 ? `The stream server is having problems (HTTP ${s}).` : `The server answered HTTP ${s}.`;

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

/* EPG BEGIN ------------------------------------------------------------------------------------------------
   Programme guide (XMLTV), refreshed automatically - like the EPG in OTT Navigator.
   Sources (all optional, merged together):
     - env EPG_URL        one or more XMLTV URLs, comma separated (.xml or .xml.gz)
     - playlist header    #EXTM3U url-tvg="https://.../guide.xml.gz"   (or x-tvg-url=)
     - local file         public/epg.xml  or  public/epg.xml.gz  (also ./epg.xml[.gz])
   env EPG_REFRESH_HOURS (default 6) controls how often the guide is re-downloaded.
   A playlist channel is matched to the guide by tvg-id first, then by (normalised) tvg-name / channel name. */
const EPG_REFRESH_MS = Math.max(0.25, Number(process.env.EPG_REFRESH_HOURS) || 6) * 3_600_000;
const EPG_FILES = ['public/epg.xml', 'public/epg.xml.gz', 'epg.xml', 'epg.xml.gz'].map(f => path.join(__dirname, f));
const EPG_PAST_MS = 3 * 3_600_000, EPG_FUTURE_MS = 48 * 3_600_000;       // only keep programmes in this window
let playlistEpgUrls = [];
// Used only when neither EPG_URL nor url-tvg is set. Free public XMLTV guides that cover Indian / Tamil channels.
const DEFAULT_EPG_URLS = [
  'https://epgshare01.online/epgshare01/epg_ripper_IN1.xml.gz',
  'https://iptv-epg.org/files/epg-in.xml',
];
const epg = { updated: 0, error: '', sources: 0, programmes: 0, xmlChannels: 0, matched: 0,
              byId: new Map(),      // xmltv channel id -> [{s,e,t,d}] sorted
              names: new Map(),     // normalised name  -> xmltv channel id
              map: new Map() };     // playlist channel id -> xmltv channel id

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
    const numeric = /^\d+$/.test(c.tvg || '');                     // numeric ids are often not the same across playlist and guide
    if (c.tvg && !numeric && epg.byId.has(c.tvg)) id = c.tvg;
    for (const nm of [c.tvgName, c.name]) { if (!id && nm) id = epg.names.get(normName(nm)) || null; }
    if (!id && c.tvg && numeric && epg.byId.has(c.tvg)) id = c.tvg;   // last resort
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

function xmltvTime(v) {                                      // "20261010153000 +0530" -> epoch ms
  const m = String(v).trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?\s*([+-]\d{2}):?(\d{2})?/);
  if (!m) return NaN;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  if (!m[7]) return t;
  const off = (Math.abs(+m[7]) * 60 + +(m[8] || 0)) * (m[7][0] === '-' ? -1 : 1);
  return t - off * 60_000;
}

// Streams an XMLTV document and calls onChannel / onProgramme for each element (memory stays small even for huge guides).
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

// Wraps a byte stream; transparently gunzips when the data starts with the gzip magic bytes.
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
    const urls = configured.length || file ? configured : DEFAULT_EPG_URLS;   // nothing configured at all -> free India guides
    const sources = urls.map(u => ({ url: u }));
    if (file) sources.push({ file });

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
            names.set(normName(id.replace(/\.[a-z]{2,3}$/i, '')), id);          // "Kalaignar.TV.in" -> kalaignar
            for (const m of body.matchAll(/<display-name\b[^>]*>([\s\S]*?)<\/display-name>/g)) {
              const k = normName(xmlDecode(m[1])); if (k && !names.has(k)) names.set(k, id);
            }
          },
          (attrs, body) => {
            const s = xmltvTime(xmlAttr(attrs, 'start')), e = xmltvTime(xmlAttr(attrs, 'stop'));
            if (!(s < e) || e < lo || s > hi) return;
            const ch = xmlAttr(attrs, 'channel'); if (!ch) return;
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
        byId.set(id, list.filter((p, i) => !i || p.s !== list[i - 1].s));            // drop duplicate start times
      }
      epg.byId = byId; epg.names = names; epg.programmes = programmes; epg.xmlChannels = xmlChannels;
      epg.sources = ok; epg.updated = Date.now(); rebuildEpgMap();
      console.log(`[epg] ${programmes} programmes, ${xmlChannels} guide channels, ${epg.matched}/${cache.list.length} playlist channels matched (${Date.now() - t0} ms)`);
    }
    epg.error = errors.join(' | ');
    if (errors.length) console.warn('[epg] ' + epg.error);
  } catch (e) { epg.error = e.message; console.warn('[epg] failed:', e.message); }
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

app.get('/api/epg', async (req, res) => {                  // now/next for every channel (small, polled by the page every minute)
  if (!cache.list.length) await loadChannels().catch(() => {});
  const ch = {};
  for (const c of cache.list) { const x = nowNext(c.id); if (x) ch[c.id] = { n: short(x.now), x: short(x.next) }; }
  res.set('Cache-Control', 'no-store').json({ updated: epg.updated, ch });
});
app.get('/api/epg/:id', async (req, res) => {              // upcoming schedule for one channel (with descriptions)
  if (!cache.list.length) await loadChannels().catch(() => {});
  const x = nowNext(Number(req.params.id));
  if (!x) return res.set('Cache-Control', 'no-store').json({ updated: epg.updated, list: [] });
  res.set('Cache-Control', 'no-store').json({ updated: epg.updated, list: x.list.slice(x.i, x.i + 12) });
});
setTimeout(() => refreshEpg(), 3000);
setInterval(() => refreshEpg(), EPG_REFRESH_MS).unref();
/* EPG END ---------------------------------------------------------------------------------------------------- */

app.disable('x-powered-by');
app.get('/health', (req, res) => res.json({ ok: true, channels: cache.list.length,
  epg: { updated: epg.updated, programmes: epg.programmes, matched: epg.matched, sources: epg.sources, error: epg.error } }));

// What does this channel's URL really deliver (HLS / DASH / raw TS / web page / error)?  Used by the player when a
// stream fails, so it can switch player type and show the real reason instead of a vague error.
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
    if (out.kind === 'html') out.reason = 'The server returned a web page (login / blocked / expired link), not a video stream.';
    else if (out.kind === 'empty') out.reason = 'The server connected but sent no data.';
    else if (out.kind === 'unknown') out.reason = 'The server sent data that is not a recognised video format.';
    res.json(out);
  } catch (e) {
    res.json({ ok: false, reason: ac.signal.aborted ? 'Timed out waiting for the stream server.' : 'Could not connect to the stream server: ' + e.message });
  } finally { clearTimeout(timer); }
});

app.get('/api/channels', async (req, res) => {
  try { res.json((await loadChannels(req.query.fresh === '1')).map(({ _h, ...c }) => c)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.options('/proxy', (req, res) => {
  res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || 'Range, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' }).sendStatus(204);
});

const proxyHandler = async (req, res) => {
  let url;
  try { url = new URL(String(req.query.url || '')); } catch { return res.status(400).send('bad url'); }
  if (!cache.list.length) await loadChannels().catch(() => {});
  // A request that carries a valid channel id (?ch=) may reach any PUBLIC host: DASH manifests reference segment
  // hosts that never appear in the playlist. Set STRICT_HOSTS=1 to only allow hosts found in the playlist.
  const known = !!cache.list[Number(req.query.ch)];
  if (!allowed.has(url.hostname.toLowerCase()) && (process.env.STRICT_HOSTS === '1' || !known)) return res.status(403).send('host not in playlist');

  const ac = new AbortController();
  res.on('close', () => ac.abort());
  try {
    const chan = cache.list[Number(req.query.ch)];
    const headers = { 'User-Agent': UA, ...((chan && chan._h) || {}) };
    if (req.headers.range) headers.Range = req.headers.range;
    const init = {};
    if (req.method === 'POST') {                            // DRM license requests (so the browser never talks to the license server directly)
      init.method = 'POST';
      if (Buffer.isBuffer(req.body) && req.body.length) init.body = req.body;
      for (const [k, v] of Object.entries(req.headers)) {
        if (!/^(host|connection|content-length|origin|referer|cookie|accept-encoding|accept-language|user-agent|upgrade|sec-|priority|range|if-|x-forwarded|x-real-ip|x-render|x-request-id|x-final-url|cf-|cdn-loop|true-client-ip|rndr-)/.test(k)) headers[k] = v;
      }
    }
    const up = await fetchUA(url, headers, ac.signal, init, chan && chan._h && chan._h['User-Agent']);
    res.status(up.status).set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Length, Content-Range, X-Final-Url', 'X-Final-Url': up.finalUrl });
    const ct = up.headers.get('content-type') || '';
    const looksPlaylist = /mpegurl/i.test(ct) || /\.m3u8?(\?|$)/i.test(url.pathname);
    const maybePlaylist = req.method === 'GET' && !looksPlaylist && /^(text\/|application\/(octet-stream|x-?unknown)|$)/i.test(ct) && !req.headers.range;
    const sendPlaylist = text => res.type('application/vnd.apple.mpegurl').set('Cache-Control', 'no-store')
      .send(rewriteM3U8(text, up.finalUrl, chan ? chan.id : null));

    if (looksPlaylist) {
      const text = await up.text();
      if (up.ok && !/^\s*#EXTM3U/.test(text)) return res.status(502).send('upstream did not return a valid playlist');
      return up.ok ? sendPlaylist(text) : res.send(text);
    }
    if (!up.body) return res.end();
    const reader = Readable.fromWeb(up.body);
    if (maybePlaylist) {                       // playlist served without a proper content-type (e.g. /?id=812)
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
    // fetch() already decoded gzip/br, so the upstream length/encoding no longer match the bytes we send
    for (const h of ['content-type', 'content-range', 'accept-ranges']) {
      const v = up.headers.get(h);
      if (v) res.set(h, v);
    }
    if (!up.headers.get('content-encoding')) { const l = up.headers.get('content-length'); if (l) res.set('content-length', l); }
    res.set('Cache-Control', req.method === 'POST' || !up.headers.get('content-length') ? 'no-store' : 'public, max-age=5');
    reader.on('error', () => res.end()).pipe(res);
  } catch (e) {
    if (!res.headersSent) res.status(502).set('Access-Control-Allow-Origin', '*').send('upstream error: ' + e.message);
  }
};
app.get('/proxy', proxyHandler);
app.post('/proxy', express.raw({ type: () => true, limit: '1mb' }), proxyHandler);

require('./pulse')(app);   // PULSE: health radar + smart failover + live viewers
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '5m' }));
app.use((req, res) => res.status(404).send('Not found'));
process.on('unhandledRejection', e => console.error('unhandled:', e));

app.listen(PORT, '0.0.0.0', () => console.log('Tamil IPTV listening on ' + PORT));
