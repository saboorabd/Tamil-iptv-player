const $ = id => document.getElementById(id);
const video = $('video'), statusEl = $('status');
const store = {
  get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};
const NOLOGO = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='42' height='42'%3E%3Crect width='42' height='42' rx='8' fill='%23121c30'/%3E%3Ctext x='21' y='26' font-size='12' fill='%238da2bd' text-anchor='middle' font-family='sans-serif'%3ETV%3C/text%3E%3C/svg%3E";

// NOTE: pulse.js reads these globals (channels, cur, hls, sk, play) - keep the names.
let channels = [], cur = null, hls = null, sk = null, token = 0;
let favs = new Set(store.get('favs', []));

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

function render() {
  const q = $('search').value.trim().toLowerCase(), g = $('group').value;
  const rows = channels.filter(c =>
    (g === 'all' || (g === 'fav' ? favs.has(c.name) : c.group === g)) && (!q || c.name.toLowerCase().includes(q)));
  $('count').textContent = rows.length + ' channels';
  $('channels').innerHTML = rows.length ? rows.map(c => `
    <button class="ch ${cur && cur.id === c.id ? 'cur' : ''}" data-id="${c.id}">
      <img src="${esc(c.logo || NOLOGO)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src='${NOLOGO}'">
      <span class="t"><b>${esc(c.name)}</b><small>${esc(c.group)}</small></span>
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
async function play(c) {
  if (!c) return;
  const my = ++token;
  cur = c; store.set('last', c.id);
  $('nowName').textContent = c.name; $('nowGroup').textContent = c.group;
  favBtn(); render(); teardown(); setStatus('Connecting: ' + c.name + '…');

  // Always play through our own /proxy. The browser then only talks to this site (same origin), so CORS
  // errors (and mixed-content errors for http:// streams) cannot happen.
  const tries = [true];
  const dash = c.type === 'mpd' || /\.mpd(\?|$)/i.test(c.url) || !!c.drm;

  for (let i = 0; i < tries.length; i++) {
    try {
      await (dash ? startShaka(c, my, tries[i]) : startHls(c, my, tries[i]));
      if (my === token) setStatus('LIVE');
      return;
    } catch (e) {
      if (my !== token) return;
      teardown();
      setStatus('Cannot play: ' + (e && e.message ? e.message : e), true);
    }
  }
}

/* ---------- HLS ---------- */
const hlsMsg = d => d.details + (d.response && d.response.code ? ' (HTTP ' + d.response.code + ')' : '');

async function startHls(c, my, viaProxy) {
  const src = viaProxy ? proxied(c) : c.url;
  if (!(await ensureLib('Hls')) && !video.canPlayType('application/vnd.apple.mpegurl'))
    throw new Error('hls.js failed to load (check your internet connection)');
  if (my !== token) throw new Superseded();

  const fail = { current: () => {} };
  const gate = startGate(my, fail);

  if (window.Hls && Hls.isSupported()) {
    const near = $('edgeSelect').value === 'near';
    let netRetries = 0, mediaRetries = 0;
    const h = new Hls({
      lowLatencyMode: near, liveSyncDurationCount: near ? 2 : 3, liveMaxLatencyDurationCount: near ? 5 : 10,
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
$('liveBtn').onclick = () => {
  try {
    if (hls && hls.liveSyncPosition) video.currentTime = hls.liveSyncPosition;
    else if (sk) video.currentTime = sk.seekRange().end;
  } catch {}
  tryPlay();
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

// seconds behind the live edge (null if unknown)
function liveLag() {
  try {
    if (hls && typeof hls.latency === 'number' && hls.latency > 0) return hls.latency;
    if (sk) { const e = sk.seekRange().end; if (e) return e - video.currentTime; }
    if (video.seekable && video.seekable.length) return video.seekable.end(video.seekable.length - 1) - video.currentTime;
  } catch {}
  return null;
}
setInterval(() => {
  const l = liveLag();
  $('latency').textContent = 'Latency: ' + (l == null ? '--' : l.toFixed(1) + 's');
}, 1000);


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
  const live = $('vcLive'), behind = !!cur && (video.paused || (liveLag() ?? 0) > 15);
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
wrap.addEventListener('click', e => {                                  // tap the picture = play/pause (first tap only reveals the controls)
  if (e.target.closest('.vc, #pulseTools, #pulseMenu')) return;
  if (wrap.classList.contains('pulse-idle')) return;
  video.paused ? tryPlay() : video.pause();
});
syncControls();

loadChannels();
