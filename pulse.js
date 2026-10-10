'use strict';
/**
 * PULSE — channel health radar, smart failover & live viewers
 * ------------------------------------------------------------
 * One drop-in file for Tamil IPTV Player. Adds:
 *
 *   1. Health radar     – a background prober checks every channel through your
 *                         own /proxy: manifest -> variant -> newest segment.
 *                         Each channel gets UP / SLOW / STALE / DOWN + a 0-100 score.
 *   2. Frozen-stream    – if #EXT-X-MEDIA-SEQUENCE stops moving on a live channel,
 *      detection          it is flagged STALE even though the URL still answers 200.
 *   3. Smart failover   – clicking a dead channel auto-switches to the healthiest
 *                         sibling source (same tvg-id / same base name).
 *   4. Live viewers     – anonymous heartbeats give "watching now" + Trending chips.
 *   5. Zero-edit UI     – the page is patched on the fly (status dots, summary bar,
 *                         Hide-dead toggle, toast). index.html / app.js stay untouched.
 *
 * Install (server.js, BEFORE the express.static line):
 *     require('./pulse')(app);
 *
 * Optional env vars:
 *   PULSE_INTERVAL_MIN  minutes between probe rounds        (default 10)
 *   PULSE_IDLE_MIN      stop probing if nobody visited for  (default 30)
 *   PULSE_CONCURRENCY   parallel probes                     (default 4)
 *   PULSE_DISABLE=1     turn the whole module off
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sniffKind } = require('./sniff');

module.exports = function pulse(app, opts = {}) {
  if (process.env.PULSE_DISABLE === '1') return;

  const PORT = opts.port || process.env.PORT || 10000;
  const BASE = `http://127.0.0.1:${PORT}`;
  const INTERVAL = Math.max(1, +(process.env.PULSE_INTERVAL_MIN || 10)) * 60_000;
  const IDLE_LIMIT = Math.max(1, +(process.env.PULSE_IDLE_MIN || 30)) * 60_000;
  const CONCURRENCY = Math.min(8, Math.max(1, +(process.env.PULSE_CONCURRENCY || 4)));
  const TIMEOUT = opts.timeout || 8000;
  const SLOW_MANIFEST = 3000, SLOW_SEGMENT = 4000;
  const STALE_AFTER = opts.staleAfter || 90_000;   // same media-sequence for this long => frozen
  const HISTORY = 24;
  const CACHE_FILE = path.join(os.tmpdir(), 'tamil-iptv-pulse.json');
  const INDEX = path.join(__dirname, 'public', 'index.html');

  /* ---------------- state ---------------- */
  let channels = [];                 // last list from /api/channels
  const byUrl = new Map();           // url -> result (survives playlist reordering)
  const viewers = new Map();         // client id -> { ch, at }
  const cooldown = new Map();        // ch -> last manual probe time
  let running = false, lastRound = 0, lastSeen = Date.now(), roundAt = 0;

  try {
    const saved = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    for (const [u, r] of Object.entries(saved)) byUrl.set(u, r);
  } catch {}
  const persist = () => {
    try { fs.writeFileSync(CACHE_FILE, JSON.stringify(Object.fromEntries(byUrl))); } catch {}
  };

  /* ---------------- probing ---------------- */
  const proxyUrl = (ch, u) => `${BASE}/proxy?ch=${ch.id}&url=${encodeURIComponent(u)}`;
  const abs = u => (u.startsWith('http') ? u : BASE + u);   // rewritten manifests use /proxy?... paths

  async function timed(url, headers) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT);
    const t0 = Date.now();
    try {
      const r = await fetch(url, { headers, signal: ac.signal });
      return { r, t0, timer, ac };
    } catch (e) {
      clearTimeout(timer);
      throw new Error(e.name === 'AbortError' ? 'timeout' : 'network');
    }
  }

  async function getText(url) {
    const { r, t0, timer } = await timed(url);
    try {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const text = await r.text();
      return { text, ms: Date.now() - t0 };
    } catch (e) {
      throw new Error(e.name === 'AbortError' ? 'timeout' : e.message);
    } finally { clearTimeout(timer); }
  }

  // reads only the first bytes of a stream (a raw MPEG-TS stream never ends, so it can not be read as text)
  async function peek(url, max = 4096) {
    const { r, t0, timer, ac } = await timed(url);
    try {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const reader = r.body.getReader(), parts = []; let n = 0;
      while (n < max) { const { value, done } = await reader.read(); if (done) break; parts.push(Buffer.from(value)); n += value.length; }
      return { ms: Date.now() - t0, buf: Buffer.concat(parts) };
    } catch (e) {
      throw new Error(e.name === 'AbortError' ? 'timeout' : e.message);
    } finally { clearTimeout(timer); ac.abort(); }
  }

  async function getBytes(url) {                      // first KB only
    const { r, t0, timer, ac } = await timed(url, { Range: 'bytes=0-1023' });
    try {
      if (!(r.status === 200 || r.status === 206)) throw new Error('segment HTTP ' + r.status);
      const reader = r.body.getReader();
      const { value } = await reader.read();
      if (!value || !value.length) throw new Error('empty segment');
      return Date.now() - t0;
    } catch (e) {
      throw new Error(e.name === 'AbortError' ? 'timeout' : e.message);
    } finally { clearTimeout(timer); ac.abort(); }
  }

  const firstUri = (text, afterTag) => {
    const lines = text.split(/\r?\n/).map(l => l.trim());
    let i = afterTag ? lines.findIndex(l => l.startsWith(afterTag)) : 0;
    if (i < 0) return null;
    for (i += afterTag ? 1 : 0; i < lines.length; i++) if (lines[i] && !lines[i].startsWith('#')) return lines[i];
    return null;
  };
  const lastUri = text => {
    const l = text.split(/\r?\n/).map(x => x.trim()).filter(x => x && !x.startsWith('#'));
    return l[l.length - 1] || null;
  };

  async function check(ch) {
    const out = { ms: 0, seg: 0, err: '', seq: null, vod: false };
    try {
      const head = await peek(proxyUrl(ch, ch.url));
      out.ms = head.ms;
      const kind = sniffKind(head.buf);
      // not HLS: raw MPEG-TS / FLV / MP4 / radio streams are fine as soon as data flows; DASH: reachable manifest is all we can verify
      if (kind === 'ts' || kind === 'flv' || kind === 'mp4' || kind === 'audio') { out.seg = head.ms; return out; }
      if (kind === 'dash') return out;
      if (kind === 'html') throw new Error('web page instead of a stream');
      if (kind === 'empty') throw new Error('no data');
      if (kind !== 'hls') throw new Error('unrecognised stream');
      const m = await getText(proxyUrl(ch, ch.url));
      out.ms = Math.max(out.ms, m.ms);
      if (/<MPD[\s>]/.test(m.text)) return out;
      if (!/^\s*#EXTM3U/.test(m.text)) throw new Error('not a playlist');

      let media = m.text;
      if (/#EXT-X-STREAM-INF/.test(media)) {                        // master -> first variant
        const v = firstUri(media, '#EXT-X-STREAM-INF');
        if (!v) throw new Error('empty master');
        const vm = await getText(abs(v));
        out.ms = Math.max(out.ms, vm.ms);
        media = vm.text;
      }
      const seq = media.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/);
      out.seq = seq ? +seq[1] : null;
      out.vod = /#EXT-X-ENDLIST/.test(media);
      const segUri = lastUri(media);
      if (!segUri) throw new Error('no segments');
      out.seg = await getBytes(abs(segUri));
    } catch (e) { out.err = e.message; }
    return out;
  }

  function classify(ch, res) {
    const prev = byUrl.get(ch.url) || {};
    const now = Date.now();
    const hist = (prev.h || []).slice(-(HISTORY - 1));
    let s = 'up';
    if (res.err) s = 'down';
    else if (res.ms > SLOW_MANIFEST || res.seg > SLOW_SEGMENT) s = 'slow';

    // frozen live stream: media-sequence has not advanced for STALE_AFTER
    let seqAt = now;
    if (res.seq != null && !res.vod && prev.seq === res.seq) seqAt = prev.seqAt || now;
    if (s !== 'down' && res.seq != null && !res.vod && now - seqAt > STALE_AFTER) s = 'stale';

    hist.push(s === 'up' || s === 'slow' ? 1 : 0);
    const uptime = Math.round((hist.reduce((a, b) => a + b, 0) / hist.length) * 100);
    const lat = Math.max(0, Math.min(100, 100 - Math.max(res.ms, res.seg) / 60));
    const score = s === 'down' || s === 'stale' ? 0 : Math.round(uptime * 0.6 + lat * 0.4);
    const entry = { n: ch.name, s, ms: res.ms, seg: res.seg, err: res.err, seq: res.seq, seqAt, h: hist, up: uptime, score, at: now };
    byUrl.set(ch.url, entry);
    return entry;
  }

  async function refreshChannels() {
    const r = await fetch(BASE + '/api/channels');
    if (!r.ok) throw new Error('channels ' + r.status);
    channels = await r.json();
    return channels;
  }

  async function round() {
    if (running) return;
    running = true; roundAt = Date.now();
    try {
      const list = await refreshChannels();
      const seen = new Set(list.map(c => c.url));
      for (const u of byUrl.keys()) if (!seen.has(u)) byUrl.delete(u);   // forget removed channels
      const queue = [...list];
      await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
        while (queue.length) {
          const ch = queue.shift();
          classify(ch, await check(ch));
        }
      }));
      lastRound = Date.now();
      persist();
    } catch (e) {
      console.error('[pulse] round failed:', e.message);
    } finally { running = false; }
  }

  const tick = () => {
    if (Date.now() - lastSeen > IDLE_LIMIT) return;          // nobody around -> save bandwidth
    round();
  };
  setTimeout(tick, 4000).unref();
  setInterval(tick, INTERVAL).unref();

  /* ---------------- viewers ---------------- */
  const pruneViewers = () => {
    const cut = Date.now() - 60_000;
    for (const [k, v] of viewers) if (v.at < cut) viewers.delete(k);
  };
  setInterval(pruneViewers, 30_000).unref();

  /* ---------------- API ---------------- */
  const noStore = (res) => res.set('Cache-Control', 'no-store');

  function snapshot() {
    pruneViewers();
    const per = new Map();
    for (const v of viewers.values()) if (v.ch >= 0) per.set(v.ch, (per.get(v.ch) || 0) + 1);
    const out = {}, sum = { up: 0, slow: 0, stale: 0, down: 0, total: channels.length };
    channels.forEach(c => {
      const e = byUrl.get(c.url);
      if (!e) return;
      sum[e.s]++;
      out[c.id] = { s: e.s, ms: e.ms, seg: e.seg, up: e.up, score: e.score, at: e.at, err: e.err, w: per.get(c.id) || 0 };
    });
    const trending = [...per.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, w]) => ({ id, w }));
    const watching = [...viewers.values()].filter(v => v.ch >= 0).length;
    return { at: lastRound, probing: running, summary: sum, watching, trending, channels: out };
  }

  app.get('/api/pulse', async (req, res) => {
    lastSeen = Date.now();
    if (!channels.length) await refreshChannels().catch(() => {});
    if (!running && Date.now() - lastRound > INTERVAL) round();   // wake after idle / cold start
    noStore(res).json(snapshot());
  });

  app.post('/api/pulse/hb', (req, res) => {
    lastSeen = Date.now();
    const cid = String(req.query.cid || ''), ch = parseInt(req.query.ch, 10);
    if (!/^[a-z0-9]{6,32}$/i.test(cid) || !Number.isInteger(ch) || ch < -1 || ch >= channels.length)
      return res.sendStatus(400);
    if (viewers.size > 5000 && !viewers.has(cid)) return res.sendStatus(429);
    viewers.set(cid, { ch, at: Date.now() });
    res.sendStatus(204);
  });

  app.post('/api/pulse/probe', async (req, res) => {
    lastSeen = Date.now();
    const id = parseInt(req.query.ch, 10);
    const ch = channels[id];
    if (!ch) return res.sendStatus(404);
    const now = Date.now();
    if (now - (cooldown.get(id) || 0) < 20_000) return res.sendStatus(429);
    cooldown.set(id, now);
    const e = classify(ch, await check(ch));
    noStore(res).json({ id, s: e.s, ms: e.ms, seg: e.seg, up: e.up, score: e.score, at: e.at, err: e.err });
  });

  app.get('/pulse.js', (req, res) => res.type('application/javascript').set('Cache-Control', 'no-cache').send(CLIENT));

  // patch the page on the fly so index.html never has to change
  app.get(['/', '/index.html'], (req, res, next) => {
    fs.readFile(INDEX, 'utf8', (err, html) => {
      if (err) return next();
      const tag = '<script defer src="/pulse.js"></script>';
      res.type('html').set('Cache-Control', 'no-cache')
        .send(html.includes('/pulse.js') ? html : html.replace('</body>', tag + '\n</body>'));
    });
  });

  console.log(`[pulse] radar on — every ${INTERVAL / 60000} min, ${CONCURRENCY} parallel`);
};

/* =====================================================================
   Browser side. Serialised with Function#toString, so it is plain JS
   here (no escaping) and runs after app.js (both are deferred).
   ===================================================================== */
function clientMain() {
  const $ = id => document.getElementById(id);
  if (!$('channels') || typeof channels === 'undefined') return;

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let data = { channels: {}, summary: null, trending: [], watching: 0 };
  let hideDead = false;
  try { hideDead = localStorage.getItem('pulse-hide') === '1'; } catch {}
  let cid = '';
  try { cid = localStorage.getItem('pulse-cid') || ''; } catch {}
  if (!cid) {
    cid = Array.from(crypto.getRandomValues(new Uint8Array(12)), b => (b % 36).toString(36)).join('');
    try { localStorage.setItem('pulse-cid', cid); } catch {}
  }

  /* ---- styles ---- */
  const css = document.createElement('style');
  css.textContent = `
  #pulseBar{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;padding:0 14px 10px;font-size:12px;color:var(--mute)}
  #pulseBar b{color:var(--text);font-weight:700}
  #pulseBar button{padding:3px 10px;font-size:12px;border-radius:999px}
  #pulseBar button.on{border-color:var(--acc);color:var(--acc)}
  #pulseTrend{display:flex;flex-wrap:wrap;gap:6px;padding:0 14px 10px}
  #pulseTrend button{padding:3px 10px;font-size:12px;border-radius:999px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .pdot{display:inline-block;width:9px;height:9px;margin-left:8px;border-radius:50%;vertical-align:middle;cursor:pointer;background:#5b6b86;flex:none}
  .pdot.s-up{background:#36d399;box-shadow:0 0 8px #36d399}
  .pdot.s-slow{background:#f5b042;box-shadow:0 0 8px #f5b042}
  .pdot.s-stale{background:#b57cff;box-shadow:0 0 8px #b57cff}
  .pdot.s-down{background:#ff5d6c;box-shadow:0 0 8px #ff5d6c}
  .pdot.busy{animation:pulse 0.7s ease-in-out infinite}
  .hide-dead .ch[data-s="down"],.hide-dead .ch[data-s="stale"]{display:none}
  #pulseToast{position:fixed;left:50%;bottom:22px;transform:translate(-50%,20px);opacity:0;z-index:50;pointer-events:none;
    padding:9px 16px;border-radius:999px;background:rgba(10,16,32,.92);border:1px solid var(--line-strong);color:var(--text);
    font-size:13px;transition:.3s;max-width:90vw;text-align:center}
  #pulseToast.show{opacity:1;transform:translate(-50%,0)}

  /* ---- player skin: LIVE badge, in-video quality menu, enhance ---- */
  #latency,#quality,.player-controls label:has(#qualitySelect){display:none!important}
  #pulseLive{font-weight:800;letter-spacing:.9px;color:#fff;pointer-events:none}
  #pulseLive::before{content:"";display:inline-block;width:8px;height:8px;margin-right:7px;border-radius:50%;
    background:#ff3b4a;box-shadow:0 0 9px #ff3b4a;vertical-align:middle;animation:pulse 1.4s ease-in-out infinite}
  #pulseLive.behind{pointer-events:auto;cursor:pointer;color:var(--acc)}
  #pulseLive.behind::before{background:var(--mute);box-shadow:none;animation:none}
  #pulseTools{position:absolute;right:12px;bottom:62px;z-index:5;display:flex;gap:8px;align-items:center;transition:opacity .25s}
  .pulse-idle #pulseTools{opacity:0;pointer-events:none}
  #pulseTools button{padding:6px 12px;font-size:13px;font-weight:700;border-radius:999px;color:#fff;cursor:pointer;
    background:rgba(8,14,28,.62);border:1px solid rgba(255,255,255,.16);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)}
  #pulseTools button:hover{border-color:var(--acc);color:var(--acc)}
  #pulseMenu{position:absolute;right:12px;bottom:106px;z-index:6;width:210px;max-height:68%;overflow:auto;padding:8px;
    border-radius:14px;background:rgba(10,16,32,.95);border:1px solid var(--line-strong);box-shadow:var(--shadow);display:none}
  #pulseMenu.open{display:block}
  #pulseMenu h4{margin:6px 8px 4px;font-size:11px;letter-spacing:.8px;text-transform:uppercase;color:var(--mute);font-weight:700}
  #pulseMenu button{display:flex;justify-content:space-between;width:100%;padding:8px 10px;margin:1px 0;border:0;border-radius:9px;
    background:transparent;color:var(--text);font-size:14px;text-align:left;cursor:pointer}
  #pulseMenu button:hover{background:rgba(245,176,66,.14)}
  #pulseMenu button.sel{color:var(--acc);font-weight:700}
  #pulseMenu button.sel::after{content:"✓"}
  #pulseMenu .enh{display:flex;gap:6px;padding:2px 4px 4px}
  #pulseMenu .enh button{justify-content:center;border:1px solid var(--line);margin:0}
  #pulseMenu .enh button.sel{border-color:var(--acc)}
  #pulseMenu .enh button.sel::after{content:""}
  #pulseMenu small{display:block;margin:4px 8px 2px;color:var(--mute);font-size:11px;line-height:1.35}
  .video-wrapper:fullscreen{max-height:none;aspect-ratio:auto;border-radius:0;border:0;width:100%;height:100%}
  `;
  document.head.appendChild(css);

  /* ---- UI shells ---- */
  const bar = document.createElement('div'); bar.id = 'pulseBar';
  const trend = document.createElement('div'); trend.id = 'pulseTrend';
  const ctrl = document.querySelector('.controls');
  ctrl.after(bar); bar.after(trend);
  const toast = document.createElement('div'); toast.id = 'pulseToast'; document.body.appendChild(toast);
  const viewersEl = document.createElement('span'); viewersEl.id = 'pulseViewers';
  const overlay = document.querySelector('.player-overlay');
  if (overlay) overlay.appendChild(viewersEl);

  let toastT;
  const say = t => { toast.textContent = t; toast.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => toast.classList.remove('show'), 3500); };

  const label = { up: 'Live', slow: 'Slow', stale: 'Frozen', down: 'Down' };
  const tip = (e) => e ? `${label[e.s]} · ${e.ms}ms · seg ${e.seg}ms · uptime ${e.up}% · score ${e.score}${e.err ? ' · ' + e.err : ''}\n(click to re-test)` : 'Not checked yet';

  /* ---- decorate channel rows (render() rewrites innerHTML, so observe it) ---- */
  const list = $('channels');
  const mo = new MutationObserver(decorate);
  function decorate() {
    mo.disconnect();
    list.classList.toggle('hide-dead', hideDead);
    list.querySelectorAll('.ch').forEach(b => {
      const e = data.channels[b.dataset.id];
      b.dataset.s = e ? e.s : 'new';
      let d = b.querySelector('.pdot');
      if (!d) { d = document.createElement('i'); d.className = 'pdot'; (b.querySelector('.t b') || b).appendChild(d); }
      d.className = 'pdot' + (e ? ' s-' + e.s : '');
      d.title = tip(e);
      d.dataset.id = b.dataset.id;
    });
    mo.observe(list, { childList: true });
  }

  list.addEventListener('click', async ev => {
    const d = ev.target.closest('.pdot');
    if (!d) return;
    ev.stopPropagation(); ev.preventDefault();
    d.classList.add('busy');
    try {
      const r = await fetch('/api/pulse/probe?ch=' + d.dataset.id, { method: 'POST' });
      if (r.status === 429) say('Please wait a moment before re-testing');
      else if (r.ok) { const e = await r.json(); data.channels[e.id] = Object.assign(data.channels[e.id] || {}, e); say(`${label[e.s]} · ${e.ms}ms`); }
    } catch {}
    d.classList.remove('busy'); paint();
  }, true);

  /* ---- summary bar + trending ---- */
  function paint() {
    const s = data.summary;
    if (s) {
      bar.innerHTML = `<span>🟢 <b>${s.up}</b></span><span>🟡 <b>${s.slow}</b></span>` +
        (s.stale ? `<span>🟣 <b>${s.stale}</b></span>` : '') + `<span>🔴 <b>${s.down}</b></span>` +
        `<span>👁 <b>${data.watching}</b></span>` +
        `<button id="pulseHide" class="${hideDead ? 'on' : ''}">${hideDead ? 'Show dead' : 'Hide dead'}</button>`;
      $('pulseHide').onclick = () => {
        hideDead = !hideDead;
        try { localStorage.setItem('pulse-hide', hideDead ? '1' : '0'); } catch {}
        paint(); decorate();
      };
    }
    const hot = data.trending.filter(t => channels[t.id] && t.w > 0);
    trend.innerHTML = hot.length ? hot.map(t => `<button data-t="${t.id}">🔥 ${esc(channels[t.id].name)} · ${t.w}</button>`).join('') : '';
    trend.onclick = ev => { const b = ev.target.closest('[data-t]'); if (b) play(channels[+b.dataset.t]); };
    decorate();
    showViewers();
  }

  function showViewers() {
    if (typeof cur === 'undefined' || !cur) { viewersEl.textContent = ''; viewersEl.style.display = 'none'; return; }
    const e = data.channels[cur.id];
    viewersEl.style.display = '';
    viewersEl.textContent = e ? `👁 ${Math.max(e.w, 1)} watching · ${label[e.s]}` : '';
    if (!e) viewersEl.style.display = 'none';
  }

  /* ---- smart failover: dead channel -> healthiest sibling ---- */
  const base = n => n.replace(/\s*\(.*\)\s*$/, '');
  const sibs = c => channels.filter(x => x.id !== c.id && c.tvg && x.tvg === c.tvg && base(x.name) === base(c.name));
  if (typeof window.play === 'function') {
    const orig = window.play;
    window.play = function (c, tried) {
      if (!tried && c) {
        const me = data.channels[c.id];
        if (me && (me.s === 'down' || me.s === 'stale')) {
          const best = sibs(c).map(x => ({ x, e: data.channels[x.id] }))
            .filter(o => o.e && (o.e.s === 'up' || o.e.s === 'slow'))
            .sort((a, b) => b.e.score - a.e.score)[0];
          if (best) {
            say(`${c.name} source is ${label[me.s].toLowerCase()} — switched to a healthier source`);
            return orig.call(this, best.x, new Set([c.id]));
          }
        }
      }
      return orig.apply(this, arguments);
    };
  }

  /* ---- player skin ---- */
  const video = $('video'), wrap = document.querySelector('.video-wrapper'), qSel = $('qualitySelect'), statusEl = $('status');

  // 1) "Latency: 3.2s" -> plain LIVE badge (status pill hides itself while it only says LIVE)
  const liveEl = document.createElement('span'); liveEl.id = 'pulseLive'; liveEl.style.display = 'none';
  const latEl = $('latency');
  latEl ? latEl.after(liveEl) : overlay && overlay.appendChild(liveEl);
  liveEl.onclick = () => $('liveBtn').click();

  const lagSeconds = () => {
    try {
      if (typeof hls !== 'undefined' && hls && typeof hls.latency === 'number' && hls.latency > 0) return hls.latency;
      if (typeof sk !== 'undefined' && sk) { const e = sk.seekRange().end; if (e) return e - video.currentTime; }
    } catch {}
    return null;
  };
  function syncLive() {
    const isLive = statusEl.textContent.trim() === 'LIVE';
    statusEl.style.display = isLive ? 'none' : '';
    if (!isLive) { liveEl.style.display = 'none'; return; }
    const lag = lagSeconds(), behind = lag != null && lag > 20;
    liveEl.style.display = '';
    liveEl.classList.toggle('behind', behind);
    liveEl.textContent = behind ? 'GO LIVE' : 'LIVE';
  }
  new MutationObserver(syncLive).observe(statusEl, { childList: true, characterData: true, subtree: true });
  setInterval(syncLive, 1000);

  // 2) quality button inside the video (+ fullscreen of the wrapper so it survives fullscreen)
  const tools = document.createElement('div'); tools.id = 'pulseTools';
  const qBtn = document.createElement('button'); qBtn.id = 'pulseQ'; qBtn.type = 'button'; qBtn.textContent = '⚙ Auto';
  const fsBtn = document.createElement('button'); fsBtn.id = 'pulseFs'; fsBtn.type = 'button'; fsBtn.title = 'Fullscreen'; fsBtn.textContent = '⛶';
  const menu = document.createElement('div'); menu.id = 'pulseMenu';
  tools.append(qBtn);
  // fullscreen (with auto-rotate) now lives in the player's own control bar (app.js), so no extra button here
  wrap.append(tools, menu);

  const num = o => parseInt(o.textContent, 10) || 0;
  const actualQuality = () => ($('quality').textContent.split(':')[1] || '').trim().replace('--', '');
  function qLabel() {
    const o = qSel.options[qSel.selectedIndex], act = actualQuality();
    qBtn.textContent = '⚙ ' + (qSel.value === '-1' ? 'Auto' + (act ? ' · ' + act : '') : (o ? o.textContent : 'Auto'));
  }
  setInterval(qLabel, 1000);

  // 3) enhance: real-time sharpen (+ contrast/saturation) on the video element
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', '0'); svg.setAttribute('height', '0'); svg.setAttribute('aria-hidden', 'true'); svg.style.position = 'absolute';
  svg.innerHTML = '<defs>' +
    '<filter id="pulseCrisp" color-interpolation-filters="sRGB"><feConvolveMatrix order="3" kernelMatrix="0 -0.5 0 -0.5 3 -0.5 0 -0.5 0" preserveAlpha="true"/></filter>' +
    '<filter id="pulseVivid" color-interpolation-filters="sRGB"><feConvolveMatrix order="3" kernelMatrix="0 -0.8 0 -0.8 4.2 -0.8 0 -0.8 0" preserveAlpha="true"/></filter></defs>';
  document.body.appendChild(svg);
  const FILTERS = { off: '', crisp: 'url(#pulseCrisp)', vivid: 'url(#pulseVivid) contrast(1.06) saturate(1.15)' };
  let enh = 'off';
  try { enh = localStorage.getItem('pulse-enh') || 'off'; } catch {}
  if (!(enh in FILTERS)) enh = 'off';
  const applyEnh = () => { video.style.filter = FILTERS[enh]; };
  applyEnh();

  function buildMenu() {
    const opts = [...qSel.options];
    const auto = opts.find(o => o.value === '-1');
    const rest = opts.filter(o => o.value !== '-1').sort((a, b) => num(b) - num(a));
    const row = (o, extra) => `<button data-q="${esc(o.value)}" class="${qSel.value === o.value ? 'sel' : ''}">${esc(o.textContent)}${extra || ''}</button>`;
    const enhBtn = (k, t) => `<button data-enh="${k}" class="${enh === k ? 'sel' : ''}">${t}</button>`;
    menu.innerHTML = '<h4>Quality</h4>' +
      (auto ? row(auto) : '') + rest.map((o, i) => row(o, i === 0 ? ' ★' : '')).join('') +
      (rest.length ? '' : '<small>This stream has only one quality.</small>') +
      '<h4>Enhance</h4><div class="enh">' + enhBtn('off', 'Off') + enhBtn('crisp', 'Crisp') + enhBtn('vivid', 'Vivid') + '</div>' +
      '<small>Sharpen filter - it cannot improve on the source quality. Turn it Off if playback lags.</small>';
  }
  qBtn.onclick = e => { e.stopPropagation(); if (!menu.classList.contains('open')) buildMenu(); menu.classList.toggle('open'); };
  menu.onclick = e => {
    e.stopPropagation();
    const q = e.target.closest('[data-q]'), h = e.target.closest('[data-enh]');
    if (q) {
      qSel.value = q.dataset.q; qSel.dispatchEvent(new Event('change'));
      qLabel(); menu.classList.remove('open');
    } else if (h) {
      enh = h.dataset.enh; applyEnh();
      try { localStorage.setItem('pulse-enh', enh); } catch {}
      buildMenu();
    }
  };
  document.addEventListener('click', () => menu.classList.remove('open'));
  fsBtn.onclick = e => {
    e.stopPropagation();
    document.fullscreenElement ? document.exitFullscreen() : wrap.requestFullscreen().catch(() => {});
  };

  // auto-hide tools together with the native controls
  let idleT;
  const wake = () => {
    wrap.classList.remove('pulse-idle'); clearTimeout(idleT);
    idleT = setTimeout(() => { if (!video.paused && !menu.classList.contains('open')) wrap.classList.add('pulse-idle'); }, 3000);
  };
  ['mousemove', 'touchstart', 'click', 'keydown'].forEach(ev => wrap.addEventListener(ev, wake, { passive: true }));
  video.addEventListener('pause', wake); wake();

  /* ---- polling + heartbeat ---- */
  async function poll() {
    if (document.hidden) return;
    try {
      const r = await fetch('/api/pulse', { cache: 'no-store' });
      if (r.ok) { data = await r.json(); paint(); }
    } catch {}
  }
  let lastHb = -2, lastHbAt = 0;
  function beat() {
    const playing = typeof cur !== 'undefined' && cur && !document.hidden && !$('video').paused;
    const ch = playing ? cur.id : -1;
    const now = Date.now();
    if (ch === lastHb && now - lastHbAt < 20000) return;
    lastHb = ch; lastHbAt = now;
    fetch(`/api/pulse/hb?cid=${cid}&ch=${ch}`, { method: 'POST', keepalive: true }).catch(() => {});
  }

  mo.observe(list, { childList: true });
  poll(); setInterval(poll, 30000);
  setInterval(beat, 2000);
  setInterval(showViewers, 2000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); beat(); });
}

const CLIENT = '(' + clientMain.toString() + ')();';
