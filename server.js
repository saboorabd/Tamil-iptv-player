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

function parseM3U(text) {
  const out = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const attr = k => (line.match(new RegExp(k + '="([^"]*)"', 'i')) || [])[1] || '';
      cur = {
        name: line.slice(line.lastIndexOf(',') + 1).trim() || attr('tvg-name') || 'Channel',
        logo: attr('tvg-logo'),
        group: attr('group-title') || 'Others',
      };
    } else if (line.startsWith('#EXTHTTP:') && cur) {
      try {
        const j = JSON.parse(line.slice(9));
        cur._h = {};
        for (const k of Object.keys(j)) {
          const n = k.toLowerCase();
          if (n === 'cookie') cur._h.Cookie = String(j[k]);
          else if (n === 'referer' || n === 'referrer') cur._h.Referer = String(j[k]);
          else if (n === 'user-agent') cur._h['User-Agent'] = String(j[k]);
        }
      } catch {}
    } else if (line.startsWith('#KODIPROP:') && cur) {
      const [k, ...v] = line.slice(10).split('=');
      cur._k = cur._k || {};
      cur._k[k.trim()] = v.join('=').trim();
    } else if (!line.startsWith('#') && cur) {
      cur.url = line;
      if (cur._k && cur._k['inputstream.adaptive.license_key']) {
        cur.drm = { type: cur._k['inputstream.adaptive.license_type'] || '', key: cur._k['inputstream.adaptive.license_key'] };
      }
      delete cur._k;
      try { allowed.add(new URL(cur.url).hostname.toLowerCase()); } catch {}
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
  if (net.isIPv6(ip)) return ip === '::1' || /^(fc|fd|fe80)/i.test(ip);
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

async function assertPublic(url) {
  if (!/^https?:$/.test(url.protocol)) throw new Error('bad protocol');
  const addrs = await dns.lookup(url.hostname, { all: true });
  if (addrs.some(a => isPrivate(a.address))) throw new Error('private address blocked');
}

async function fetchFollow(start, headers, signal) {
  let url = start;
  for (let i = 0; i < 5; i++) {
    await assertPublic(url);
    const r = await fetch(url, { headers, redirect: 'manual', signal });
    const loc = r.headers.get('location');
    if (r.status >= 300 && r.status < 400 && loc) {
      url = new URL(loc, url);
      allowed.add(url.hostname.toLowerCase());
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
  res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Range' }).sendStatus(204);
});

app.get('/proxy', async (req, res) => {
  let url;
  try { url = new URL(String(req.query.url || '')); } catch { return res.status(400).send('bad url'); }
  if (!cache.list.length) await loadChannels().catch(() => {});
  if (!allowed.has(url.hostname.toLowerCase())) return res.status(403).send('host not in playlist');

  const ac = new AbortController();
  res.on('close', () => ac.abort());
  try {
    const chan = cache.list[Number(req.query.ch)];
    const headers = { 'User-Agent': UA, ...((chan && chan._h) || {}) };
    if (req.headers.range) headers.Range = req.headers.range;
    const up = await fetchFollow(url, headers, ac.signal);
    res.status(up.status).set('Access-Control-Allow-Origin', '*');
    const ct = up.headers.get('content-type') || '';
    if (/mpegurl/i.test(ct) || /\.m3u8(\?|$)/i.test(url.pathname)) {
      const body = rewriteM3U8(await up.text(), up.finalUrl, chan ? chan.id : null);
      return res.type('application/vnd.apple.mpegurl').set('Cache-Control', 'no-store').send(body);
    }
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const v = up.headers.get(h);
      if (v) res.set(h, v);
    }
    res.set('Cache-Control', 'public, max-age=5');
    if (!up.body) return res.end();
    Readable.fromWeb(up.body).on('error', () => res.end()).pipe(res);
  } catch (e) {
    if (!res.headersSent) res.status(502).send('upstream error: ' + e.message);
  }
});

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '5m' }));
app.use((req, res) => res.status(404).send('Not found'));
process.on('unhandledRejection', e => console.error('unhandled:', e));

app.listen(PORT, '0.0.0.0', () => console.log('Tamil IPTV listening on ' + PORT));
