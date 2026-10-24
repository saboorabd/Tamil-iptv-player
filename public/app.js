const $ = id => document.getElementById(id);
const video = $('video'), statusEl = $('status');
const store = {
  get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};
const NOLOGO = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='42' height='42'%3E%3Crect width='42' height='42' rx='8' fill='%23121c30'/%3E%3Ctext x='21' y='26' font-size='12' fill='%238da2bd' text-anchor='middle' font-family='sans-serif'%3ETV%3C/text%3E%3C/svg%3E".replace(/'/g, '%27');   // %27: a raw ' would break the inline onerror="...'${NOLOGO}'" handlers

// NOTE: pulse.js reads these globals (channels, cur, hls, sk, play) - keep the names.
let channels = [], cur = null, hls = null, sk = null, ts = null, token = 0;   // ts = mpegts.js player (raw MPEG-TS / FLV)
let favs = new Set(store.get('favs', []));
let epgAll = {}, epgSig = '', epgList = null, epgListAt = 0, epgOpen = false;   // EPG state (see "EPG" section below)
let gTab = 'list', gDay = 0, gData = null, gTimer = 0, epgUpd = 0;                // TV guide state (see "TV GUIDE" section below)

const START_TIMEOUT = 20000;   // ms to wait for a stream to actually start playing
const pick = (v, allowed, d) => (allowed.includes(v) ? v : d);
$('edgeSelect').value = pick(store.get('edge', 'default'), ['default', 'near'], 'default');

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const setStatus = (t, err) => { statusEl.textContent = t; statusEl.className = err ? 'err' : ''; };
const proxied = (c, url) => `/proxy?ch=${c.id}&url=${encodeURIComponent(url || c.url)}`;

/* ---------- library loading (CDN fallback) ---------- */
const LIBS = {
  Hls: ['https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.13/hls.min.js',
        'https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js'],
  mpegts: ['https://cdn.jsdelivr.net/npm/mpegts.js@1.7.3/dist/mpegts.js',
           'https://unpkg.com/mpegts.js@1.7.3/dist/mpegts.js',
           'https://cdn.jsdelivr.net/npm/mpegts.js@latest/dist/mpegts.js'],
  shaka: ['https://cdnjs.cloudflare.com/ajax/libs/shaka-player/4.7.11/shaka-player.compiled.js',
          'https://cdn.jsdelivr.net/npm/shaka-player@4.7.11/dist/shaka-player.compiled.js']
};
const libLoads = {};
function ensureLib(name) {
  if (window[name]) return Promise.resolve(true);
  if (libLoads[name]) return libLoads[name];
  libLoads[name] = (async () => {
    for (const src of LIBS[name]) {
      const ok = await new Promise(res => {
        const s = document.createElement('script');
        s.src = src; s.onload = () => res(true); s.onerror = () => { s.remove(); res(false); };
        document.head.appendChild(s);
      });
      if (ok && window[name]) return true;
    }
    delete libLoads[name];
    return false;
  })();
  return libLoads[name];
}

/* ---------- playlist ---------- */
async function loadChannels(fresh) {
  setStatus('Loading playlist…');
  try {
    const r = await fetch('/api/channels' + (fresh ? '?fresh=1' : ''));
    let data;
    try { data = await r.json(); } catch { throw new Error('Server returned an invalid response (HTTP ' + r.status + ')'); }
    if (!r.ok) throw new Error(data.error || r.status);
    if (!Array.isArray(data) || !data.length) throw new Error('no channels found in the playlist (check the #EXTINF lines)');
    channels = data;
    const groups = [...new Set(channels.map(c => c.group))].sort();
    const prev = $('group').value;
    $('group').innerHTML = '<option value="all">All</option><option value="fav">★ Favourites</option>' +
      groups.map(g => `<option value="${esc(g)}">${esc(g)}</option>`).join('');
    if ([...$('group').options].some(o => o.value === prev)) $('group').value = prev;
    render();
    setStatus('Select a channel');
  } catch (e) {
    channels = []; render();
    setStatus('Playlist error: ' + e.message, true);
  }
}

/* Playlist links can expire (tokens like exp=... last an hour). The server re-reads the playlist (PLAYLIST_URL is downloaded again),
   and the player swaps in the fresh link by itself: every 10 minutes, and at once when a stream is refused or its link dies. */
let lastFresh = 0;
const chKey = c => c.name + '|' + c.group;
async function refreshPlaylist() {
  if (Date.now() - lastFresh < 20_000) return false;
  lastFresh = Date.now();
  try {
    const r = await fetch('/api/channels?fresh=1', { cache: 'no-store' });
    const d = await r.json();
    if (!r.ok || !Array.isArray(d) || !d.length) return false;
    const old = new Map(channels.map(c => [chKey(c), c.url]));
    const changed = d.length !== channels.length || d.some(c => old.get(chKey(c)) !== c.url);
    channels = d;
    if (cur) cur = d.find(c => chKey(c) === chKey(cur)) || cur;
    if (changed) render();
    return changed;
  } catch { return false; }
}
// stream failed because the link looks expired: fetch the fresh playlist and replay with the new link (true = replaying)
async function freshLink(c, my) {
  if (!(await refreshPlaylist()) || my !== token) return false;
  const n = channels.find(x => chKey(x) === chKey(c));
  if (!n || n.url === c.url) return false;
  setStatus('Link expired - using the fresh link from the playlist…');
  play(n);
  return true;
}
setInterval(() => { if (!document.hidden) refreshPlaylist(); }, 10 * 60_000);

function npLine(c) {                                       // "▶ programme title" under the channel name (from the EPG)
  const e = epgAll[c.id], n = e && e.n;
  return n && n.e > Date.now() ? `<small class="np">▶ ${esc(n.t)}</small>` : '';
}

function render() {
  const q = $('search').value.trim().toLowerCase(), g = $('group').value;
  const rows = channels.filter(c =>
    (g === 'all' || (g === 'fav' ? favs.has(c.name) : c.group === g)) && (!q || c.name.toLowerCase().includes(q)));
  $('count').textContent = rows.length + ' channels';
  $('channels').innerHTML = rows.length ? rows.map(c => `
    <button class="ch ${cur && cur.id === c.id ? 'cur' : ''}" data-id="${c.id}">
      <img src="${esc(c.logo || NOLOGO)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src='${NOLOGO}'">
      <span class="t"><b>${esc(c.name)}</b><small>${esc(c.group)}</small>${npLine(c)}</span>
      <span class="star ${favs.has(c.name) ? 'on' : ''}" data-fav="${esc(c.name)}">${favs.has(c.name) ? '★' : '☆'}</span>
    </button>`).join('') : '<div class="empty">No channels</div>';
}

function toggleFav(name) {
  favs.has(name) ? favs.delete(name) : favs.add(name);
  store.set('favs', [...favs]);
  favBtn(); render();
}
function favBtn() {
  if (!cur) return;
  const on = favs.has(cur.name);
  $('favBtn').textContent = (on ? '★' : '☆') + ' Favourite';
  $('favBtn').classList.toggle('on', on);
}

/* ---------- playback helpers ---------- */
function teardown() {
  if (hls) { try { hls.destroy(); } catch {} hls = null; }
  if (sk) { try { sk.destroy(); } catch {} sk = null; }
  if (ts) { try { ts.pause(); ts.unload(); ts.detachMediaElement(); ts.destroy(); } catch {} ts = null; }
  video.onloadedmetadata = null; video.onerror = null;
  video.pause(); video.removeAttribute('src'); video.load();
  $('qualitySelect').innerHTML = '<option value="-1">Auto</option>';
  $('quality').textContent = 'Quality: --';
}

// Autoplay can be blocked by the browser; fall back to muted playback instead of silently staying paused.
function tryPlay() {
  const p = video.play();
  if (p && p.catch) p.catch(err => {
    if (err && err.name === 'NotAllowedError') { video.muted = true; video.play().catch(() => {}); }
  });
}

class Superseded extends Error {}   // a newer play() call replaced this attempt

/* One attempt = one source URL. Resolves only when the video is really playing,
   so a "manifest OK but segments blocked" failure still triggers the proxy fallback. */
function startGate(my, fail) {
  let settled = false, started = false, timer, onPlaying;
  const promise = new Promise((resolve, reject) => {
    const done = err => {
      if (settled) return;
      settled = true; clearTimeout(timer); video.removeEventListener('playing', onPlaying);
      err ? reject(err) : resolve();
    };
    onPlaying = () => { if (my === token) { started = true; done(); } };
    video.addEventListener('playing', onPlaying);
    timer = setTimeout(() => done(video.readyState >= 3 && my === token ? null : new Error('Stream did not start in time')), START_TIMEOUT);
    fail.current = done;
  });
  return { promise, isStarted: () => started };
}

/* ---------- play ---------- */
// What kind of stream is this, judging by the URL only? null = cannot tell (e.g. xtream links like /live/user/pass/123).
function guessKind(c) {
  if (c.type === 'mpd' || c.drm || /\.mpd(\?|$)/i.test(c.url)) return 'dash';
  if (c.type === 'hls' || /\.m3u8?(\?|$)|[?&/]m3u8/i.test(c.url)) return 'hls';
  if (/\.(ts|mts|m2ts)(\?|$)/i.test(c.url)) return 'ts';
  if (/\.flv(\?|$)/i.test(c.url)) return 'flv';
  if (/\.(mp4|m4v|webm)(\?|$)/i.test(c.url)) return 'mp4';
  if (/\.(mp3|aac|m4a|ogg|opus)(\?|$)/i.test(c.url)) return 'audio';
  return null;
}

// Ask the server what the link really delivers (it fetches the first bytes with the same User-Agent tricks as the proxy).
async function sniff(c) {
  try { const r = await fetch('/api/sniff?ch=' + c.id, { cache: 'no-store' }); return await r.json(); }
  catch { return { ok: false, reason: 'Could not reach the player server.' }; }
}

const STARTERS = {
  hls: (c, my) => startHls(c, my, true),
  dash: (c, my) => startShaka(c, my, true),
  ts: (c, my) => startMpegts(c, my, 'mpegts'),
  flv: (c, my) => startMpegts(c, my, 'flv'),
  mp4: (c, my) => startNative(c, my),
  audio: (c, my) => startNative(c, my)
};

const DIRECT = {   // same players, but the browser fetches the stream itself (no server proxy)
  hls: (c, my) => startHls(c, my, false),
  dash: (c, my) => startShaka(c, my, false),
  ts: (c, my) => startMpegts(c, my, 'mpegts', true),
  flv: (c, my) => startMpegts(c, my, 'flv', true),
  mp4: (c, my) => startNative(c, my, true),
  audio: (c, my) => startNative(c, my, true)
};

async function play(c) {
  if (!c) return;
  const my = ++token;
  cur = c; store.set('last', c.id);
  $('nowName').textContent = c.name; $('nowGroup').textContent = c.group;
  favBtn(); render(); markGuide(); teardown(); lagMin = Infinity; setStatus('Connecting: ' + c.name + '…');
  epgList = null; paintEpg(); loadEpgList(c);

  // Always play through our own /proxy first: the browser only talks to this site (same origin), so CORS and
  // mixed-content (http:// stream on an https:// page) errors cannot happen.
  let kind = guessKind(c), info = null, lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!kind) {                                         // unknown link type: look at the stream itself
      info = await sniff(c);
      if (my !== token) return;
      if (!info.kind || !STARTERS[info.kind]) { lastErr = new Error(info.reason || 'Unrecognised stream'); break; }
      kind = info.kind;
    }
    try {
      try {
        await STARTERS[kind](c, my);
      } catch (e1) {
        if (my !== token || e1 instanceof Superseded) throw e1;
        if (kind === 'hls' && !c.drm) {
          teardown();
          if (/IncompatibleCodecs/i.test(e1.message)) {
            setStatus('Trying codec fix…');
            try {
              await startHls(c, my, true, true);    // proxy, CODECS attribute removed from the manifest
            } catch (e2) {
              if (my !== token || e2 instanceof Superseded) throw e2;
              teardown();
              if (!video.canPlayType('application/vnd.apple.mpegurl')) throw e2;
              setStatus('Trying native player…');   // the phone's own decoder (HEVC / AC-3 hardware)
              await startHls(c, my, true, true, true);
            }
          } else {
            setStatus('Trying direct…');
            await startHls(c, my, false);           // browser direct, no proxy (works if the stream allows CORS + https)
          }
        } else throw e1;
      }
      if (my === token) setStatus('LIVE');
      return;
    } catch (e) {
      if (my !== token) return;
      teardown();
      lastErr = e;
      if (!info) {                                       // failed: find out why, and whether another player type fits better
        setStatus('Checking the stream…');
        info = await sniff(c);
        if (my !== token) return;
        if (info.kind && info.kind !== kind && STARTERS[info.kind]) { kind = info.kind; setStatus('Switching player type…'); continue; }
      }
      break;
    }
  }
  // The server was refused (401 / 403 / 451: login, token tied to an IP, or a region block that only hits cloud servers).
  // Your phone has its own IP and headers, so try the stream from the browser directly (needs a stream that allows browsers / https).
  const blocked = (info && [401, 403, 451].includes(info.status)) || /HTTP (401|403|451)\b/.test((lastErr && lastErr.message) || '');
  const expired = (info && [401, 403, 404, 410].includes(info.status)) || /HTTP (401|403|404|410)\b/.test((lastErr && lastErr.message) || '');
  if (expired && my === token && await freshLink(c, my)) return;
  if (my !== token) return;
  const dk = guessKind(c) || (info && info.kind) || 'hls';
  if (blocked && my === token && (dk !== 'hls' || c.drm) && !(location.protocol === 'https:' && /^http:/i.test(c.url)) && DIRECT[dk]) {
    setStatus('Server was refused - trying directly from your phone…');
    try { await DIRECT[dk](c, my); if (my === token) setStatus('LIVE'); return; }
    catch (e) { if (my !== token) return; teardown(); }
  }
  // give the most useful explanation we have
  const codecFail = lastErr && /IncompatibleCodecs/i.test(lastErr.message);
  const why = codecFail ? 'This device cannot decode this stream\'s format (likely HEVC/H.265 or AC-3 audio). Try Safari, Edge, or an Android phone.'
            : info && !info.ok && info.reason ? info.reason
            : info && info.reason ? info.reason
            : (lastErr && lastErr.message) || 'Unknown error';
  let host = ''; try { host = new URL(c.url).hostname; } catch {}
  setStatus('Cannot play ' + c.name + (host ? ' (' + host + ')' : '') + ': ' + why, true);
}

/* ---------- HLS ---------- */
const hlsMsg = d => d.details + (d.response && d.response.code ? ' (HTTP ' + d.response.code + ')' : '');

async function startHls(c, my, viaProxy, noCodec, native) {
  const src = viaProxy ? proxied(c) + (noCodec ? '&nc=1' : '') + '&w=1' : c.url;   // w=1: server reads ahead (faster start)
  if (!native && !(await ensureLib('Hls')) && !video.canPlayType('application/vnd.apple.mpegurl'))
    throw new Error('hls.js failed to load (check your internet connection)');
  if (my !== token) throw new Superseded();

  const fail = { current: () => {} };
  const gate = startGate(my, fail);

  if (!native && window.Hls && Hls.isSupported()) {
    const near = $('edgeSelect').value === 'near';
    let netRetries = 0, mediaRetries = 0;
    const h = new Hls({
      lowLatencyMode: near, liveSyncDurationCount: near ? 2 : 3, liveMaxLatencyDurationCount: near ? 5 : 10,
      startLevel: 0, startFragPrefetch: true, capLevelToPlayerSize: true,   // faster start: lowest quality first, ABR then climbs
      backBufferLength: 30, manifestLoadingMaxRetry: 2, levelLoadingMaxRetry: 3, fragLoadingMaxRetry: 4,
      manifestLoadingTimeOut: 15000, levelLoadingTimeOut: 15000, fragLoadingTimeOut: 20000
    });
    hls = h;
    h.on(Hls.Events.MANIFEST_PARSED, (e, d) => {
      if (my !== token || hls !== h) return;
      if (d.levels.length > 1) $('qualitySelect').innerHTML = '<option value="-1">Auto</option>' +
        d.levels.map((l, i) => `<option value="${i}">${l.height ? l.height + 'p' : Math.round(l.bitrate / 1000) + 'k'}</option>`).join('');
      tryPlay();
    });
    h.on(Hls.Events.LEVEL_SWITCHED, (e, d) => {
      const l = h.levels[d.level];
      if (l) $('quality').textContent = 'Quality: ' + (l.height ? l.height + 'p' : Math.round(l.bitrate / 1000) + 'k');
    });
    h.on(Hls.Events.FRAG_LOADED, () => { netRetries = 0; });
    h.on(Hls.Events.ERROR, (e, d) => {
      if (!d.fatal || my !== token || hls !== h) return;
      if (!gate.isStarted()) return fail.current(new Error(hlsMsg(d)));   // before playback: let play() fall back
      // already playing: try to recover instead of freezing silently
      if (d.type === Hls.ErrorTypes.NETWORK_ERROR && netRetries < 5) {
        netRetries++; setStatus('Network problem, reconnecting (' + netRetries + '/5)…');
        if (netRetries === 2) freshLink(c, my);                           // maybe the token in the link expired
        setTimeout(() => { if (hls === h && my === token) h.startLoad(); }, 1000 * netRetries);
      } else if (d.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRetries < 3) {
        mediaRetries++; setStatus('Media error, recovering…');
        if (mediaRetries === 2) h.swapAudioCodec();
        h.recoverMediaError();
      } else {
        setStatus('Playback stopped: ' + hlsMsg(d) + ' — select the channel again to retry', true);
      }
    });
    h.loadSource(src); h.attachMedia(video);
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {     // Safari / iOS native HLS
    video.onerror = () => fail.current(new Error('native playback error'));
    video.src = src;
    tryPlay();
  } else {
    throw new Error('This browser does not support HLS playback');
  }
  return gate.promise;
}

/* ---------- raw MPEG-TS / FLV (mpegts.js) ---------- */
async function startMpegts(c, my, type, direct) {
  if (!(await ensureLib('mpegts'))) throw new Error('mpegts.js failed to load (check your internet connection)');
  if (my !== token) throw new Superseded();
  if (!mpegts.isSupported()) throw new Error('This browser cannot play raw MPEG-TS streams');
  const fail = { current: () => {} };
  const gate = startGate(my, fail);
  let retries = 0;
  const p = mpegts.createPlayer({ type, isLive: true, url: direct ? c.url : proxied(c) },
    { enableWorker: false, autoCleanupSourceBuffer: true, liveBufferLatencyChasing: true,
      liveBufferLatencyMaxLatency: 10, liveBufferLatencyMinRemain: 2 });
  ts = p;
  p.on(mpegts.Events.ERROR, (errType, detail) => {
    if (my !== token || ts !== p) return;
    const msg = errType + (detail ? ': ' + detail : '');
    if (!gate.isStarted()) return fail.current(new Error(msg));
    if (retries < 5) {                                   // stream dropped while playing: reconnect
      retries++; setStatus('Network problem, reconnecting (' + retries + '/5)…');
      if (retries === 2) freshLink(c, my);
      setTimeout(() => { if (ts === p && my === token) { try { p.unload(); p.load(); tryPlay(); } catch {} } }, 1000 * retries);
    } else setStatus('Playback stopped: ' + msg + ' — select the channel again to retry', true);
  });
  video.addEventListener('playing', () => { if (ts === p) retries = 0; });
  p.attachMediaElement(video);
  p.load();
  tryPlay();
  return gate.promise;
}

/* ---------- plain files / radio streams (browser's own decoder) ---------- */
async function startNative(c, my, direct) {
  const fail = { current: () => {} };
  const gate = startGate(my, fail);
  video.onerror = () => { if (my === token) fail.current(new Error('The browser could not decode this stream')); };
  video.src = direct ? c.url : proxied(c);
  tryPlay();
  return gate.promise;
}

/* ---------- Shaka (DASH / DRM) ---------- */
const shakaName = (map, v) => Object.keys(map).find(k => map[k] === v) || v;
function shakaMsg(err) {
  if (!err || err.code === undefined) return String((err && err.message) || err);
  const E = shaka.util.Error;
  const code = shakaName(E.Code, err.code), cat = shakaName(E.Category, err.category);
  let hint = '';
  if (err.code === 1001) hint = ' - server returned an HTTP error' + (err.data && err.data[1] ? ' ' + err.data[1] : '');
  else if (err.code === 1002 || err.code === 1003) hint = ' - network/CORS problem or timeout';
  else if (err.code === 4012 || err.code === 4015) hint = ' - unsupported/invalid manifest';
  else if (err.category === E.Category.DRM) hint = ' - DRM license/key problem';
  return `Shaka ${err.code} ${code} [${cat}]${hint}`;
}

const b64hex = s => Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), ch => ch.charCodeAt(0).toString(16).padStart(2, '0')).join('');
const parseHeaders = s => { const o = {}; (s || '').split('&').forEach(p => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }); return o; };

// Converts the playlist's DRM info (Kodi style) to a Shaka drm config. Returns { drm, licenseHeaders }.
function drmConfig(drm) {
  if (!drm || !drm.key) return {};
  const type = (drm.type || '').trim().toLowerCase();
  const raw = drm.key.trim();
  const clearish = !type || type.includes('clearkey');

  if (clearish) {
    const clearKeys = {};
    raw.split(',').map(s => s.trim()).forEach(p => {                  // "kidhex:keyhex[,kidhex:keyhex]"
      const m = p.match(/^([0-9a-f]{32}):([0-9a-f]{32})$/i);
      if (m) clearKeys[m[1].toLowerCase()] = m[2].toLowerCase();
    });
    if (raw.startsWith('{')) {                                        // JSON: {"keys":[{"kid","k"}]} or {"kid":"key"}
      try {
        const j = JSON.parse(raw);
        (j.keys || []).forEach(k => { if (k.kid && k.k) clearKeys[b64hex(k.kid)] = b64hex(k.k); });
        if (!j.keys) Object.entries(j).forEach(([kid, k]) => { clearKeys[kid] = k; });
      } catch {}
    }
    if (Object.keys(clearKeys).length) return { drm: { clearKeys } };
    if (/^https?:/i.test(raw)) return { drm: { servers: { 'org.w3.clearkey': raw.split('|')[0] } } };
    throw new Error('ClearKey license_key format is not recognised (expected kid:key in hex)');
  }
  // Widevine / PlayReady etc.: "https://license/url|Header=Value&H2=V2|R{SSM}|"
  const [url, headers] = raw.split('|');
  if (!/^https?:/i.test(url)) throw new Error('DRM license server URL is missing or invalid');
  return { drm: { servers: { [drm.type.trim()]: url } }, licenseHeaders: parseHeaders(headers) };
}

async function startShaka(c, my, viaProxy) {
  if (!(await ensureLib('shaka'))) throw new Error('Shaka Player failed to load (check your internet connection)');
  if (my !== token) throw new Superseded();
  shaka.polyfill.installAll();
  if (!shaka.Player.isBrowserSupported()) throw new Error('This browser does not support DASH/DRM playback');

  const near = $('edgeSelect').value === 'near';
  let retries = 0;

  const p = new shaka.Player();
  sk = p;
  await p.attach(video);
  if (my !== token || sk !== p) throw new Superseded();
  const fail = { current: () => {} };
  const gate = startGate(my, fail);

  const dc = drmConfig(c.drm);
  const retry = { maxAttempts: 4, baseDelay: 1000, backoffFactor: 2, fuzzFactor: 0.5, timeout: 20000 };
  p.configure({
    ...(dc.drm ? { drm: dc.drm } : {}),
    manifest: { retryParameters: { ...retry, maxAttempts: 3, timeout: 15000 } },
    streaming: { lowLatencyMode: near, bufferingGoal: 30, rebufferingGoal: 2, bufferBehind: 30, retryParameters: retry }
  });

  const net = p.getNetworkingEngine();
  const RT = shaka.net.NetworkingEngine.RequestType;
  if (dc.licenseHeaders && Object.keys(dc.licenseHeaders).length)
    net.registerRequestFilter((type, req) => { if (type === RT.LICENSE) Object.assign(req.headers, dc.licenseHeaders); });

  if (viaProxy) {
    // The proxy only rewrites .m3u8, so for DASH we route every manifest/segment request through it here.
    const isProxy = u => { try { const x = new URL(u, location.href); return x.origin === location.origin && x.pathname === '/proxy'; } catch { return false; } };
    net.registerRequestFilter((type, req) => {
      req.uris = req.uris.map(u => (/^https?:/i.test(u) && !isProxy(u)) ? location.origin + proxied(c, u) : u);
    });
    // Make relative BaseURLs/segment paths resolve against the real server, not against /proxy
    net.registerResponseFilter((type, resp) => {
      const real = resp.headers && resp.headers['x-final-url'];
      if (real) resp.uri = real;
      else { try { const x = new URL(resp.uri); if (x.pathname === '/proxy' && x.searchParams.get('url')) resp.uri = x.searchParams.get('url'); } catch {} }
    });
  }

  const updateQuality = () => {
    const t = p.getVariantTracks().find(x => x.active);
    if (t) $('quality').textContent = 'Quality: ' + (t.height ? t.height + 'p' : Math.round(t.bandwidth / 1000) + 'k');
  };
  p.addEventListener('variantchanged', updateQuality);
  p.addEventListener('adaptation', updateQuality);
  p.addEventListener('error', ev => {
    const err = ev.detail;
    if (my !== token || sk !== p) return;
    if (!gate.isStarted()) return fail.current(new Error(shakaMsg(err)));
    if (err.severity === shaka.util.Error.Severity.CRITICAL) {
      const E = shaka.util.Error;
      if ((err.category === E.Category.NETWORK || err.category === E.Category.STREAMING) && retries < 5) {
        retries++; setStatus('Network problem, reconnecting (' + retries + '/5)…');
        if (retries === 2) freshLink(c, my);
        setTimeout(() => { if (sk === p && my === token) p.retryStreaming(); }, 1000 * retries);
      } else setStatus('Playback stopped: ' + shakaMsg(err) + ' — select the channel again to retry', true);
    }
  });

  p.load(c.url).then(() => {
    if (my !== token || sk !== p) return;
    const hs = [...new Set(p.getVariantTracks().map(t => t.height).filter(Boolean))].sort((a, b) => b - a);
    if (hs.length > 1) $('qualitySelect').innerHTML = '<option value="-1">Auto</option>' + hs.map(h => `<option value="${h}">${h}p</option>`).join('');
    updateQuality();
    tryPlay();
  }).catch(err => {
    if (my !== token || sk !== p) return;                             // LOAD_INTERRUPTED etc. from a newer play()
    fail.current(new Error(shakaMsg(err)));
  });
  return gate.promise;
}

/* ---------- controls ---------- */
$('qualitySelect').onchange = e => {
  const v = +e.target.value;
  if (hls) hls.currentLevel = v;
  else if (sk) {
    if (v < 0) { sk.configure({ abr: { enabled: true } }); return; }
    const track = sk.getVariantTracks().filter(t => t.height === v).sort((a, b) => b.bandwidth - a.bandwidth)[0];
    if (track) { sk.configure({ abr: { enabled: false } }); sk.selectVariantTrack(track, true); }
  }
};
// Where is the live edge of the current stream (seconds in the video's own timeline)? null = unknown.
function liveEdge() {
  try {
    if (hls && isFinite(hls.liveSyncPosition) && hls.liveSyncPosition > 0) return hls.liveSyncPosition;
    if (sk) { const e = sk.seekRange().end; if (e) return e; }
    if (video.seekable && video.seekable.length) return Math.max(0, video.seekable.end(video.seekable.length - 1) - 2);
    if (video.buffered.length) return Math.max(0, video.buffered.end(video.buffered.length - 1) - 1);
  } catch {}
  return null;
}
$('liveBtn').onclick = () => {
  const e = liveEdge();
  if (e != null && isFinite(e)) { try { video.currentTime = e; } catch {} }
  lagMin = Infinity;                                                   // measure the live edge again from here
  liveHold = Date.now() + 5000;                                        // show LIVE straight away, do not flip back while the player settles
  tryPlay();
  syncControls();
};
$('edgeSelect').onchange = e => { store.set('edge', e.target.value); cur && play(cur); };
$('favBtn').onclick = () => cur && toggleFav(cur.name);
$('reloadBtn').onclick = () => loadChannels(true);
$('channels').addEventListener('click', e => {
  const f = e.target.closest('[data-fav]');
  if (f) { e.stopPropagation(); return toggleFav(f.dataset.fav); }
  const b = e.target.closest('.ch');
  if (b) play(channels[+b.dataset.id]);
});
let t; $('search').addEventListener('input', () => { clearTimeout(t); t = setTimeout(render, 150); });
$('group').addEventListener('change', render);
video.addEventListener('waiting', () => cur && setStatus('Buffering…'));
video.addEventListener('playing', () => cur && setStatus('LIVE'));

// "Behind live" = paused, or drifted more than 12 s from where THIS stream normally plays. A fixed limit does not work:
// streams with 10 s segments sit 30 s behind the newest data by design, so GO LIVE would be lit all the time.
let lagMin = Infinity, liveHold = 0;
function isBehind() {
  if (!cur) return false;
  if (video.paused) return true;
  const l = liveLag();
  if (l == null || !isFinite(l)) return false;
  if (l < lagMin) lagMin = l;
  return Date.now() > liveHold && l - lagMin > 12;
}
// seconds behind the live edge (null if unknown)
function liveLag() {
  try {
    if (hls && typeof hls.latency === 'number' && hls.latency > 0) return hls.latency;
    if (sk) { const e = sk.seekRange().end; if (e) return e - video.currentTime; }
    if (ts && video.buffered.length) return video.buffered.end(video.buffered.length - 1) - video.currentTime;
    if (video.seekable && video.seekable.length) return video.seekable.end(video.seekable.length - 1) - video.currentTime;
  } catch {}
  return null;
}
setInterval(() => {
  const l = liveLag();
  $('latency').textContent = 'Latency: ' + (l == null ? '--' : l.toFixed(1) + 's');
}, 1000);


/* ---------- EPG (TV guide): now/next under the player + on every channel row, refreshed automatically ---------- */
const hhmm = ms => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

// now/next of ALL channels (server refreshes the XMLTV guide in the background); polled every minute
async function loadEpgAll() {
  let delay = 60_000;
  try {
    const r = await fetch('/api/epg', { cache: 'no-store' });
    if (r.ok) {
      const d = await r.json();
      epgAll = d.ch || {};
      if (!d.updated) delay = 15_000;                       // server still downloading the guide: look again soon
      if (d.updated && d.updated !== epgUpd) { const first = !epgUpd; epgUpd = d.updated; if (!first && gTab === 'guide') loadGuide(true); }
      const sig = Object.entries(epgAll).map(([id, v]) => id + ':' + (v.n ? v.n.t : '')).join('|');
      if (sig !== epgSig) { epgSig = sig; render(); }       // only redraw the list when something actually changed
    }
  } catch { delay = 30_000; }
  setTimeout(loadEpgAll, delay);
}

// schedule of the playing channel
async function loadEpgList(c) {
  try {
    const r = await fetch('/api/epg/' + c.id, { cache: 'no-store' });
    const d = r.ok ? await r.json() : { list: [] };
    if (cur && cur.id === c.id) { epgList = d.list || []; epgListAt = Date.now(); paintEpg(); }
  } catch { if (cur && cur.id === c.id) { epgList = []; paintEpg(); } }
}

// Uses the local clock, so the progress bar and the NOW/NEXT switch happen on time without asking the server again.
function paintEpg() {
  const box = $('epg'), t = Date.now();
  const up = (epgList || []).filter(p => p.e > t);
  if (!cur || !up.length) {
    box.hidden = true;
    if (cur && epgList !== null && Date.now() - epgListAt > 60_000) loadEpgList(cur);   // guide may not have been ready yet
    return;
  }
  box.hidden = false;
  const now = up[0].s <= t ? up[0] : null, next = now ? up[1] : up[0];
  if (now && now.i) epgPic('/api/epg/img?u=' + encodeURIComponent(now.i), false);
  else if (now && posterMem[posterKey(now.t)]) epgPic(posterMem[posterKey(now.t)], false);
  else {
    epgPic(cur.logo || '', true);
    if (now) { const id = cur.id + ':' + now.s; posterFor(now.t).then(p => { if (p && cur && cur.id + ':' + now.s === id) epgPic(p, false); }); }
  }
  $('epgNowT').textContent = now ? now.t : 'No programme info right now';
  $('epgNowTime').textContent = now ? hhmm(now.s) + ' – ' + hhmm(now.e) : '';
  $('epgBar').style.width = now ? Math.min(100, Math.max(0, (t - now.s) / (now.e - now.s) * 100)) + '%' : '0%';
  $('epgDesc').textContent = now ? now.d || '' : '';
  $('epgNextT').textContent = next ? next.t : '—';
  $('epgNextTime').textContent = next ? hhmm(next.s) : '';
  $('epgMore').hidden = up.length < 2;
  $('epgList').hidden = !epgOpen || up.length < 2;
  if (epgOpen) $('epgList').innerHTML = up.map((p, i) => `
    <li class="${i === 0 && now ? 'on' : ''}"><time>${hhmm(p.s)}</time><div><b>${esc(p.t)}</b>${p.d ? `<small>${esc(p.d)}</small>` : ''}</div></li>`).join('');
  if (cur && (up.length < 3 || Date.now() - epgListAt > 10 * 60_000) && Date.now() - epgListAt > 60_000) loadEpgList(cur);   // top up the schedule
}
// picture of the running programme (or the channel logo) on the right of the NOW/NEXT strip
const epgImg = document.createElement('img');
epgImg.className = 'epg-pic'; epgImg.alt = ''; epgImg.referrerPolicy = 'no-referrer'; epgImg.hidden = true;
$('epg').appendChild(epgImg);
epgImg.onerror = () => { epgImg.hidden = true; $('epg').classList.remove('has-pic'); };
function epgPic(src, isLogo) {
  epgImg.classList.toggle('logo', !!isLogo);
  if (!src) { epgImg.hidden = true; $('epg').classList.remove('has-pic'); return; }
  if (epgImg.getAttribute('src') !== src) epgImg.src = src;
  epgImg.hidden = false; $('epg').classList.add('has-pic');
}
$('epgMore').onclick = () => {
  epgOpen = !epgOpen;
  $('epgMore').textContent = epgOpen ? 'Hide schedule ▴' : 'Full schedule ▾';
  $('epgMore').setAttribute('aria-expanded', String(epgOpen));
  paintEpg();
};
setInterval(paintEpg, 30_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { paintEpg(); cur && loadEpgList(cur); } });
loadEpgAll();

/* ---------- custom player controls: LIVE button + fullscreen with auto-rotate ---------- */
const wrap = document.querySelector('.video-wrapper');
const ICONS = {   // Material-style paths, 24x24
  play: 'M8 5v14l11-7z',
  pause: 'M6 19h4V5H6v14zm8-14v14h4V5h-4z',
  vol: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z',
  mute: 'M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.8 8.8 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z',
  fs: 'M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z',
  fsExit: 'M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z'
};
const svg = d => `<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path fill="currentColor" d="${d}"/></svg>`;
const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement;

function syncControls() {
  $('vcPlay').innerHTML = svg(video.paused ? ICONS.play : ICONS.pause);
  $('vcMute').innerHTML = svg(video.muted || video.volume === 0 ? ICONS.mute : ICONS.vol);
  $('vcFs').innerHTML = svg(fsEl() ? ICONS.fsExit : ICONS.fs);
  const live = $('vcLive'), behind = isBehind();
  live.disabled = !cur;
  live.classList.toggle('behind', behind);
  $('vcLiveTxt').textContent = behind ? 'GO LIVE' : 'LIVE';
}
['play', 'pause', 'playing', 'volumechange', 'emptied'].forEach(ev => video.addEventListener(ev, syncControls));
setInterval(syncControls, 1000);

$('vcPlay').onclick = () => (video.paused ? tryPlay() : video.pause());
$('vcMute').onclick = () => { video.muted = !video.muted; if (!video.muted && video.volume === 0) video.volume = 1; };
$('vcLive').onclick = () => $('liveBtn').click();

// Fullscreen the whole wrapper (keeps our controls), then lock the screen to landscape so the phone rotates by itself.
async function toggleFullscreen() {
  if (fsEl()) { try { await (document.exitFullscreen ? document.exitFullscreen() : document.webkitExitFullscreen()); } catch {} return; }
  const req = wrap.requestFullscreen || wrap.webkitRequestFullscreen;
  if (req) {
    try { await req.call(wrap); } catch { return; }
    try { await screen.orientation.lock('landscape'); } catch {}      // allowed only while fullscreen; ignored where unsupported
  } else if (video.webkitEnterFullscreen) {
    video.webkitEnterFullscreen();                                    // iPhone Safari: native player, rotates by itself
  }
}
function onFullscreenChange() {
  if (!fsEl()) { try { screen.orientation.unlock(); } catch {} }      // back to normal rotation when leaving fullscreen
  syncControls();
}
['fullscreenchange', 'webkitfullscreenchange'].forEach(ev => document.addEventListener(ev, onFullscreenChange));
$('vcFs').onclick = toggleFullscreen;
wrap.addEventListener('dblclick', e => { if (!e.target.closest('.vc, #pulseTools, #pulseMenu')) toggleFullscreen(); });
syncControls();

/* ---------- TV GUIDE (like MyDish TV): channels down, time across ---------- */
// Lives in the sidebar, BELOW the player, so the video is never covered. Tap a channel to watch it, tap a programme for details.
const PPM = 4;                                           // pixels per minute (1 hour = 240 px)
const sidebar = document.querySelector('.sidebar');
const tabs = document.createElement('div');
tabs.className = 'tabs'; tabs.id = 'tabs';
tabs.innerHTML = '<button type="button" data-tab="list" class="on">Channels</button><button type="button" data-tab="guide">TV Guide</button>';
sidebar.querySelector('.header').after(tabs);

const guide = document.createElement('div');
guide.id = 'guide'; guide.className = 'guide'; guide.hidden = true;
guide.innerHTML = '<div class="gd-days" id="gdDays"></div><div class="gd-scroll" id="gdScroll"><div class="gd-inner" id="gdInner"></div></div><p class="gd-note" id="gdNote"></p>';
$('channels').after(guide);

const sheet = document.createElement('div');             // programme details (bottom sheet, never touches the video)
sheet.id = 'gdSheet'; sheet.className = 'gd-sheet'; sheet.hidden = true;
sheet.innerHTML = '<button type="button" class="gd-x" aria-label="Close">✕</button><div class="gd-sh-ch" id="gdShCh"></div><h3 id="gdShT"></h3>' +
  '<div class="gd-sh-time" id="gdShTime"></div><img class="gd-sh-img" id="gdShImg" alt="" referrerpolicy="no-referrer" hidden>' +
  '<div class="gd-art" id="gdShArt" hidden><b></b><img alt="" referrerpolicy="no-referrer"></div>' +
  '<p class="gd-sh-desc" id="gdShD"></p><button type="button" class="gd-watch" id="gdShGo"></button>';
document.body.appendChild(sheet);

const dayStart = off => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + off); return d.getTime(); };
const dayLabel = off => off === 0 ? 'Today' : off === 1 ? 'Tomorrow' : new Date(dayStart(off)).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
const baseName = n => String(n).replace(/\s*\(.*\)\s*$/, '');
const HALF = 30 * 60_000;
function gdWindow() {                                    // time range shown for the chosen day
  const now = Date.now();
  if (gDay === 0) { const from = Math.floor((now - HALF) / HALF) * HALF; return [from, Math.max(dayStart(1), from + 6 * 3_600_000)]; }
  return [dayStart(gDay), dayStart(gDay + 1)];
}
const px = ms => (ms / 60_000) * PPM;
let gWin = [0, 0], gDesc = {}, gSel = '', gLoadAt = 0, gSeq = 0;

function gdDays() {
  $('gdDays').innerHTML = [0, 1, 2].map(o => `<button type="button" data-day="${o}" class="${o === gDay ? 'on' : ''}">${esc(dayLabel(o))}</button>`).join('');
}

async function loadGuide(keep) {
  gWin = gdWindow();
  const seq = ++gSeq;
  if (!keep) { $('gdInner').innerHTML = '<div class="gd-msg">Loading guide…</div>'; $('gdNote').textContent = ''; }
  try {
    const r = await fetch(`/api/epg/guide?from=${gWin[0]}&to=${gWin[1]}`, { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    if (seq !== gSeq) return;                            // a newer request (other day) replaced this one
    gData = d; gLoadAt = Date.now();
    paintGuide(!keep);
    if (!d.updated) setTimeout(() => { if (gTab === 'guide') loadGuide(true); }, 15_000);   // server is still downloading the guide
  } catch (e) {
    if (seq !== gSeq) return;
    if (!gData) $('gdInner').innerHTML = '<div class="gd-msg">Could not load the guide. <button type="button" id="gdRetry">Retry</button></div>';
  }
}

function paintGuide(scrollToNow) {
  const inner = $('gdInner');
  if (!gData) return;
  const [from, to] = gWin, now = Date.now(), W = Math.max(1, px(to - from));
  const q = $('search').value.trim().toLowerCase(), g = $('group').value;
  const pass = c => (g === 'all' || (g === 'fav' ? favs.has(c.name) : c.group === g)) && (!q || c.name.toLowerCase().includes(q));
  const timeStr = ms => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  let ruler = '';
  for (let t = Math.ceil(from / HALF) * HALF; t < to; t += HALF) {
    const hour = new Date(t).getMinutes() === 0;
    ruler += `<span class="${hour ? 'h' : ''}" style="left:${px(t - from)}px">${timeStr(t)}</span>`;
  }

  const shown = new Set();
  let rows = '';
  for (const r of gData.rows) {
    const list = r.ids.map(i => channels[i]).filter(Boolean).filter(pass);
    if (!list.length) continue;
    list.forEach(c => shown.add(c.id));
    const pick = list.find(c => cur && c.id === cur.id) || list[0];
    const active = cur && r.ids.includes(cur.id);
    const cells = r.p.map(([s, e, t, pi]) => {
      const l = px(Math.max(s, from) - from), w = px(Math.min(e, to) - Math.max(s, from));
      if (w < 3) return '';
      const live = s <= now && now < e, p = live ? Math.round((now - s) / (e - s) * 100) : 0;
      const sz = w < 40 ? ' xxs' : w < 90 ? ' xs' : '';
      const im = pi !== undefined && gData.pics && gData.pics[pi] && w >= 60 ? ` data-pic="${esc('/api/epg/img?u=' + encodeURIComponent(gData.pics[pi]))}"` : '';
      return `<button type="button" class="gd-p${live ? ' live' : e <= now ? ' past' : ''}${sz}${im ? ' pic' : ''}${gSel === pick.id + ':' + s ? ' sel' : ''}" ` +
        `data-ch="${pick.id}" data-s="${s}" data-e="${e}" data-t="${esc(t)}"${im} style="left:${l}px;width:${w - 2}px;--p:${p}%;--h:${hue(t)}">` +
        `<span class="gd-tx"><b>${esc(t)}</b><small>${timeStr(s)} – ${timeStr(e)}</small></span></button>`;
    }).join('');
    rows += `<div class="gd-row" data-ids="${r.ids.join(',')}"><button type="button" class="gd-ch${active ? ' cur' : ''}" data-play="${active ? cur.id : pick.id}" title="Watch ${esc(baseName(pick.name))}">` +
      `<img src="${esc(pick.logo || NOLOGO)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src='${NOLOGO}'"><span>${esc(baseName(pick.name))}</span></button>` +
      `<div class="gd-track" style="width:${W}px">${cells}</div></div>`;
  }

  const nowX = now >= from && now <= to ? px(now - from) : -1;
  inner.style.width = `calc(var(--gcol) + ${W}px)`;
  inner.innerHTML = rows
    ? `<div class="gd-row gd-ruler"><div class="gd-ch gd-corner"></div><div class="gd-track" style="width:${W}px">${ruler}</div></div>${rows}` +
      (nowX >= 0 ? `<i class="gd-now" style="left:calc(var(--gcol) + ${nowX}px)"></i>` : '')
    : `<div class="gd-msg">${gData.updated ? 'No guide data for these channels on this day.' : 'The guide is being downloaded… it appears here in a few seconds.'}</div>`;

  const miss = [...new Set(channels.filter(c => pass(c) && !gData.rows.some(r => r.ids.includes(c.id))).map(c => baseName(c.name)))];
  $('gdNote').textContent = miss.length
    ? `No guide data for ${miss.length} channel${miss.length > 1 ? 's' : ''} right now: ${miss.slice(0, 8).join(', ')}${miss.length > 8 ? ' +' + (miss.length - 8) + ' more' : ''}. The guide refreshes by itself every few hours.`
    : '';

  gCells = [...inner.querySelectorAll('.gd-p')].map(el => ({ el, tx: el.firstChild, l: parseFloat(el.style.left), w: parseFloat(el.style.width) + 2, on: false }));
  if (scrollToNow) {
    const sc = $('gdScroll');
    sc.scrollLeft = gDay === 0 ? Math.max(0, nowX - 40) : px(6 * 3_600_000);       // Today: start at "now"; other days: 6 AM
  }
  fitText();
  lazyPics();
}

// Programme pictures are loaded only when their cell comes into view (a day has hundreds of programmes).
let picIO = null;
function lazyPics() {
  if (picIO) picIO.disconnect();
  const cells = [...$('gdInner').querySelectorAll('.gd-p[data-pic]')];
  const load = el => { const u = el.dataset.pic; const im = new Image(); im.onload = () => { el.style.setProperty('--img', `url("${u}")`); el.classList.add('pic-on'); }; im.src = u; delete el.dataset.pic; };
  if (!('IntersectionObserver' in window)) return cells.slice(0, 40).forEach(load);
  picIO = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { picIO.unobserve(e.target); load(e.target); } }), { rootMargin: '300px' });
  cells.forEach(c => picIO.observe(c));
}

// A programme that started before the visible area keeps its title readable: the text moves to the first visible pixel
// (and gets narrower) instead of being hidden under the channel column.
let gCells = [], gRaf = 0;
function fitText() {
  const edge = $('gdScroll').scrollLeft;                  // first visible pixel, measured from the start of the time axis
  for (const c of gCells) {
    if (c.l < edge && c.l + c.w > edge + 36) {
      const sh = edge - c.l;
      c.tx.style.marginLeft = sh + 'px';
      c.tx.style.maxWidth = Math.max(44, c.w - sh - 16) + 'px';
      c.on = true;
    } else if (c.on) { c.tx.style.marginLeft = ''; c.tx.style.maxWidth = ''; c.on = false; }
  }
}
$('gdScroll').addEventListener('scroll', () => { if (!gRaf) gRaf = requestAnimationFrame(() => { gRaf = 0; fitText(); }); }, { passive: true });

function markGuide() {                                    // highlight the playing channel in the guide (no re-render)
  if (!gData) return;
  guide.querySelectorAll('.gd-row[data-ids]').forEach(row => {
    const on = !!cur && row.dataset.ids.split(',').includes(String(cur.id));
    const b = row.querySelector('.gd-ch');
    b.classList.toggle('cur', on);
    if (on) b.dataset.play = cur.id;
  });
}

function setTab(t) {
  gTab = t; store.set('tab', t);
  sidebar.classList.toggle('tab-guide', t === 'guide');
  tabs.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  $('channels').hidden = t === 'guide';
  guide.hidden = t !== 'guide';
  clearInterval(gTimer);
  if (t === 'guide') {
    gdDays(); loadGuide();
    gTimer = setInterval(() => {
      if (document.hidden) return;
      if (Date.now() - gLoadAt > 5 * 60_000) loadGuide(true); else paintGuide();
    }, 60_000);
  } else closeSheet();
}
tabs.addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) setTab(b.dataset.tab); });
$('gdDays').addEventListener('click', e => {
  const b = e.target.closest('[data-day]'); if (!b) return;
  gDay = +b.dataset.day; closeSheet(); gdDays(); loadGuide();
});
guide.addEventListener('click', e => {
  if (e.target.closest('#gdRetry')) return loadGuide();
  const ch = e.target.closest('[data-play]');
  if (ch) { play(channels[+ch.dataset.play]); return; }
  const p = e.target.closest('.gd-p');
  if (p) openSheet(+p.dataset.ch, +p.dataset.s, +p.dataset.e, p.dataset.t);
});
let gdT; const gdRepaint = () => { if (gTab === 'guide') { clearTimeout(gdT); gdT = setTimeout(() => paintGuide(), 150); } };
$('search').addEventListener('input', gdRepaint);
$('group').addEventListener('change', gdRepaint);

/* programme details */
const hue = t => { let h = 0; for (const ch of String(t || '')) h = (h * 31 + ch.codePointAt(0)) % 360; return h; };   // a stable colour per programme title
const gPic = {};
const posterMem = {};                                      // title key -> poster url ('' = none found)
const posterKey = t => String(t).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const posterPend = {};
function posterFor(title) {                                // asks the server (it looks outside the guide and caches the answer)
  const k = posterKey(title);
  if (posterMem[k] !== undefined) return Promise.resolve(posterMem[k]);
  return posterPend[k] || (posterPend[k] = (async () => {
    try {
      const r = await fetch('/api/epg/poster?t=' + encodeURIComponent(title));
      const d = r.ok ? await r.json() : {};
      return (posterMem[k] = d.u || '');
    } catch { return ''; } finally { delete posterPend[k]; }
  })());
}                                          // channel id -> { programme start -> picture url } (from the guide's <icon>)
function showPic(chId, s, title) {                        // 1) picture from the guide  2) poster found by title  3) generated art card (colour per title + channel logo)
  const im = $('gdShImg'), art = $('gdShArt'), u = gPic[chId] && gPic[chId][s], logo = channels[chId] && channels[chId].logo;
  const showArt = () => {
    im.hidden = true; im.removeAttribute('src'); art.hidden = false;
    art.style.setProperty('--h', hue(title));
    art.querySelector('b').textContent = ([...String(title || '?').trim()][0] || '?').toUpperCase();
    const li = art.querySelector('img'); li.hidden = !logo; li.onerror = () => { li.hidden = true; };
    if (logo && li.getAttribute('src') !== logo) li.src = logo;
  };
  const showImg = (src, kind) => {
    art.hidden = true; im.className = 'gd-sh-img ' + kind;
    im.onerror = showArt;                                   // picture could not be loaded -> art card instead
    if (im.getAttribute('src') !== src) im.src = src;
    im.hidden = false;
  };
  if (u) return showImg('/api/epg/img?u=' + encodeURIComponent(u), 'guide');
  const known = title ? posterMem[posterKey(title)] : '';
  if (known) return showImg(known, 'poster');
  showArt();                                                // shown at once, replaced when a real poster arrives
  if (title && known === undefined) posterFor(title).then(p => { if (p && gSel === chId + ':' + s) showImg(p, 'poster'); });
}
function closeSheet() { sheet.hidden = true; gSel = ''; guide.querySelectorAll('.gd-p.sel').forEach(x => x.classList.remove('sel')); }
async function openSheet(chId, s, e, t) {
  const c = channels[chId]; if (!c) return;
  guide.querySelectorAll('.gd-p.sel').forEach(x => x.classList.remove('sel'));
  gSel = chId + ':' + s;
  const cell = [...guide.querySelectorAll('.gd-p')].find(x => +x.dataset.ch === chId && +x.dataset.s === s);
  if (cell) cell.classList.add('sel');
  const now = Date.now(), live = s <= now && now < e;
  const mins = Math.round((e - s) / 60_000);
  $('gdShCh').textContent = baseName(c.name);
  $('gdShT').textContent = t;
  $('gdShTime').textContent = `${live ? 'ON NOW · ' : e <= now ? 'Ended · ' : ''}${new Date(s).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} – ` +
    `${new Date(e).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · ${mins >= 60 ? Math.floor(mins / 60) + ' h ' + (mins % 60 ? mins % 60 + ' min' : '') : mins + ' min'}`;
  $('gdShD').textContent = gDesc[chId] && gDesc[chId][s] !== undefined ? gDesc[chId][s] : 'Loading description…';
  showPic(chId, s, t);
  const playing = cur && cur.id === chId;
  $('gdShGo').textContent = playing ? '● Playing now' : '▶ Watch ' + baseName(c.name);
  $('gdShGo').disabled = !!playing;
  $('gdShGo').onclick = () => { play(c); closeSheet(); };
  sheet.hidden = false;
  if (!gDesc[chId]) {                                     // descriptions are not in the grid data (keeps it small): fetch once per channel
    gDesc[chId] = {};
    try {
      const r = await fetch('/api/epg/' + chId + '?full=1', { cache: 'no-store' });
      const d = await r.json();
      (d.list || []).forEach(p => { gDesc[chId][p.s] = p.d || ''; if (p.i) (gPic[chId] = gPic[chId] || {})[p.s] = p.i; });
    } catch { delete gDesc[chId]; }
  }
  if (gSel === chId + ':' + s) { $('gdShD').textContent = gDesc[chId] && gDesc[chId][s] ? gDesc[chId][s] : 'No description available.'; showPic(chId, s, t); }
}
sheet.querySelector('.gd-x').onclick = closeSheet;
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });
document.addEventListener('click', e => { if (!sheet.hidden && !e.target.closest('#gdSheet, .gd-p')) closeSheet(); });

/* the NOW/NEXT strip under the player opens the guide */
$('epg').addEventListener('click', () => {
  setTab('guide');
  requestAnimationFrame(() => tabs.scrollIntoView({ block: 'start', behavior: 'smooth' }));
});

/* keep a CSS variable with the height of the pinned (sticky) player, so tabs and day chips stick right below it */
(function pinned() {
  const set = () => document.documentElement.style.setProperty('--stk', (getComputedStyle(wrap).position === 'sticky' ? wrap.offsetHeight : 0) + 'px');
  set();
  if (window.ResizeObserver) new ResizeObserver(set).observe(wrap);
  window.addEventListener('resize', set);
  window.addEventListener('orientationchange', set);
})();

if (store.get('tab', 'list') === 'guide') setTab('guide');

/* ---------- picture fit: Fit / Zoom (crop) / Stretch ---------- */
const FITS = [
  { v: 'contain', label: 'Fit',     tip: 'Original ratio (black bars)' },
  { v: 'cover',   label: 'Zoom',    tip: 'Fill the screen, crop the edges' },
  { v: 'fill',    label: 'Stretch', tip: 'Fill the screen, stretch the picture' }
];
let fitIdx = Math.max(0, FITS.findIndex(f => f.v === store.get('fit', 'contain')));
const fitBtn = document.createElement('button');
fitBtn.id = 'vcFit'; fitBtn.type = 'button'; fitBtn.className = 'vc-btn';
fitBtn.style.cssText = 'width:auto;min-width:0;padding:0 10px;font:700 12px/1 system-ui,sans-serif;';
function applyFit() {
  const f = FITS[fitIdx];
  video.style.objectFit = f.v;
  fitBtn.textContent = f.label; fitBtn.title = f.tip; fitBtn.setAttribute('aria-label', 'Picture: ' + f.label + ' - ' + f.tip);
  store.set('fit', f.v);
}
fitBtn.onclick = e => { e.stopPropagation(); fitIdx = (fitIdx + 1) % FITS.length; applyFit(); };
$('vcFs').before(fitBtn);
applyFit();

loadChannels();
