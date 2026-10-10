const express = require('express');
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const { Readable } = require('stream');

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

app.disable('x-powered-by');
app.get('/health', (req, res) => res.json({ ok: true, channels: cache.list.length }));

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
    const up = await fetchFollow(url, headers, ac.signal, init);
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
    res.set('Cache-Control', req.method === 'POST' ? 'no-store' : 'public, max-age=5');
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
