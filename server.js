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
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
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
    const file =
