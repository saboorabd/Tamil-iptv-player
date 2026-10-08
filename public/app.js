const $ = id => document.getElementById(id);
const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
const video = $('video'), statusEl = $('status');

// Any JS error ah status line-la kaatum, so silent-a fail aagaadhu
window.addEventListener('error', e => {
  if (statusEl) { statusEl.textContent = 'JS error: ' + e.message; statusEl.className = 'err'; }
});

const store = {
  get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};

const NOLOGO = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='42' height='42'%3E%3Crect width='42' height='42' rx='8' fill='%23121c30'/%3E%3Ctext x='21' y='26' font-size='12' fill='%238da2bd' text-anchor='middle' font-family='sans-serif'%3ETV%3C/text%3E%3C/svg%3E";

let channels = [], cur = null, hls = null, sk = null, token = 0;
let favs = new Set(store.get('favs', []));

if ($('modeSelect')) $('modeSelect').value = store.get('mode', 'auto');
if ($('edgeSelect')) $('edgeSelect').value = store.get('edge', 'default');

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const setStatus = (t, err) => { if (!statusEl) return; statusEl.textContent = t; statusEl.className = err ? 'err' : ''; };
const proxied = c => `/proxy?ch=${c.id}&url=${encodeURIComponent(c.url)}`;

/* ---------- playlist ---------- */
async function loadChannels(fresh) {
  setStatus('Playlist ஏற்றுகிறது…');
  try {
    const r = await fetch('/api/channels' + (fresh ? '?fresh=1' : ''));
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.status);
    if (!data.length) throw new Error('playlist-ல் channel இல்லை');
    channels = data;
    const groups = [...new Set(channels.map(c => c.group))].sort();
    $('group').innerHTML = '<option value="all">All</option><option value="fav">★ Favourites</option>' +
      groups.map(g => `<option value="${esc(g)}">${esc(g)}</option>`).join('');
    render();
    setStatus('Channel ஒன்றைத் தேர்ந்தெடுக்கவும்');
  } catch (e) {
    channels = []; render();
    setStatus('Playlist பிழை: ' + e.message, true);
  }
}

function render() {
  const list = $('channels');
  if (!list) return;
  const q = ($('search')?.value || '').trim().toLowerCase();
  const g = $('group')?.value || 'all';
  const rows = channels.filter(c =>
    (g === 'all' || (g === 'fav' ? favs.has(c.name) : c.group === g)) &&
    (!q || c.name.toLowerCase().includes(q)));
  if ($('count')) $('count').textContent = rows.length + ' channels';
  list.innerHTML = rows.length ? rows.map(c => `
    <button class="ch ${cur && cur.id === c.id ? 'cur' : ''}" data-id="${c.id}">
      <img src="${esc(c.logo || NOLOGO)}" alt="" loading="lazy" referrerpolicy="no-referrer">
      <span class="t"><b>${esc(c.name)}</b><small>${esc(c.group)}</small></span>
      <span class="star ${favs.has(c.name) ? 'on' : ''}" data-fav="${esc(c.name)}">${favs.has(c.name) ? '★' : '☆'}</span>
    </button>`).join('') : '<div class="empty">Channels இல்லை</div>';
}

// Logo load fail aanaa fallback (inline onerror bug fix)
on('channels', 'error', () => {}, true);
$('channels')?.addEventListener('error', e => {
  if (e.target.tagName === 'IMG') e.target.src = NOLOGO;
}, true);

function toggleFav(name) {
  favs.has(name) ? favs.delete(name) : favs.add(name);
  store.set('favs', [...favs]);
  favBtn(); render();
}

function favBtn() {
  const b = $('favBtn');
  if (!b || !cur) return;
  const on = favs.has(cur.name);
  b.textContent = (on ? '★' : '☆') + ' Favourite';
  b.classList.toggle('on', on);
}

/* ---------- playback ---------- */
function teardown() {
  if (hls) { hls.destroy(); hls = null; }
  if (sk) { sk.destroy(); sk = null; }
  video.pause(); video.removeAttribute('src'); video.load();
  if ($('qualitySelect')) $('qualitySelect').innerHTML = '<option value="-1">Auto</option>';
  if ($('quality')) $('quality').textContent = 'Quality: --';
}

const baseName = n => n.replace(/\s*\(.*\)\s*$/, '');
const siblings = c => channels.filter(x => x.id !== c.id && c.tvg && x.tvg === c.tvg && baseName(x.name) === baseName(c.name));

async function play(c, tried = new Set()) {
  tried.add(c.id);
  const my = ++token;
  cur = c; store.set('last', c.id);
  if ($('nowName')) $('nowName').textContent = c.name;
  if ($('nowGroup')) $('nowGroup').textContent = c.group;
  favBtn(); render(); teardown();
  setStatus('Connecting: ' + c.name + '…');

  const mode = $('modeSelect')?.value || 'auto';
  const insecure = location.protocol === 'https:' && c.url.startsWith('http:');
  const tries = (mode === 'proxy' || insecure || c.proxy) ? [proxied(c)]
              : mode === 'direct' ? [c.url] : [c.url, proxied(c)];
  const dash = /\.mpd(\?|$)/i.test(c.url) || !!c.drm;

  for (let i = 0; i < tries.length; i++) {
    try {
      await (dash ? startShaka(tries[i], c, my) : startHls(tries[i], my));
      if (my === token) setStatus('LIVE');
      return;
    } catch (e) {
      if (my !== token) return;
      teardown();
      if (i < tries.length - 1) setStatus('Direct fail → Proxy முயற்சி…');
      else {
        const next = siblings(c).find(x => !tried.has(x.id));
        if (next) { setStatus('Source மாற்றுகிறது…'); return play(next, tried); }
        setStatus('Play ஆகவில்லை: ' + e.message, true);
      }
    }
  }
}

function startHls(src, my) {
  return new Promise((ok, no) => {
    if (window.Hls && Hls.isSupported()) {
      const near = $('edgeSelect')?.value === 'near';
      let recovers = 0, started = false, netRecovers = 0;
      hls = new Hls({
        lowLatencyMode: near,
        liveSyncDurationCount: near ? 2 : 3,
        liveMaxLatencyDurationCount: near ? 5 : 10,
        backBufferLength: 30,
        manifestLoadingMaxRetry: 1, manifestLoadingTimeOut: 8000, manifestLoadingRetryDelay: 500,
        levelLoadingMaxRetry: 3, fragLoadingMaxRetry: 4,
        xhrSetup: x => { x.withCredentials = false; }
      });
      hls.on(Hls.Events.MANIFEST_PARSED, (e, d) => {
        if (my !== token) return;
        const q = $('qualitySelect');
        if (q && d.levels.length > 1) q.innerHTML = '<option value="-1">Auto</option>' +
          d.levels.map((l, i) => `<option value="${i}">${l.height ? l.height + 'p' : Math.round(l.bitrate / 1000) + 'k'}</option>`).join('');
        video.play().catch(() => {});
        started = true; ok();
      });
      hls.on(Hls.Events.FRAG_LOADED, () => { netRecovers = 0; });
      hls.on(Hls.Events.LEVEL_SWITCHED, (e, d) => {
        const l = hls.levels[d.level];
        if (l && $('quality')) $('quality').textContent = 'Quality: ' + (l.height ? l.height + 'p' : Math.round(l.bitrate / 1000) + 'k');
      });
      hls.on(Hls.Events.ERROR, (e, d) => {
        if (!d.fatal || my !== token) return;
        if (d.type === Hls.ErrorTypes.MEDIA_ERROR && recovers++ < 2) return hls.recoverMediaError();
        if (started && d.type === Hls.ErrorTypes.NETWORK_ERROR && netRecovers++ < 3) return hls.startLoad();
        if (started) {
          setStatus('Stream நின்றுவிட்டது — மீண்டும் இணைக்கிறது…', true);
          return setTimeout(() => my === token && cur && play(cur), 1500);
        }
        no(new Error(d.details));
      });
      hls.loadSource(src); hls.attachMedia(video);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src;
      video.onloadedmetadata = () => ok();
      video.onerror = () => no(new Error('native playback error'));
      video.play().catch(() => {});
    } else no(new Error('HLS support இல்லை (hls.js load ஆகவில்லை)'));
  });
}

async function startShaka(src, c, my) {
  if (!window.shaka) throw new Error('Shaka load ஆகவில்லை');
  shaka.polyfill.installAll();
  if (!shaka.Player.isBrowserSupported()) throw new Error('DASH/DRM இந்த browser-ல் இல்லை');
  sk = new shaka.Player();
  await sk.attach(video);
  const cfg = {};
  if (c.drm && c.drm.key) {
    if (!c.drm.type || /clearkey/i.test(c.drm.type)) {
      const [kid, k] = c.drm.key.split(':');
      cfg.drm = { clearKeys: { [kid]: k } };
    } else cfg.drm = { servers: { [c.drm.type]: c.drm.key } };
  }
  sk.configure(cfg);
  sk.addEventListener('error', e => { if (my === token) setStatus('Shaka error ' + e.detail.code, true); });
  await sk.load(src);
  if (my !== token) return;
  const hs = [...new Set(sk.getVariantTracks().map(t => t.height).filter(Boolean))].sort((a, b) => b - a);
  if ($('qualitySelect') && hs.length > 1)
    $('qualitySelect').innerHTML = '<option value="-1">Auto</option>' + hs.map(h => `<option value="${h}">${h}p</option>`).join('');
  video.play().catch(() => {});
}

/* ---------- live / quality / controls ---------- */
function goLive() {
  if (hls && hls.liveSyncPosition) video.currentTime = hls.liveSyncPosition;
  else if (sk) { try { video.currentTime = sk.seekRange().end; } catch {} }
  video.play().catch(() => {});
}

function getLag() {
  if (hls && typeof hls.latency === 'number' && hls.latency > 0) return hls.latency;
  if (sk) { try { const e = sk.seekRange().end; if (e) return e - video.currentTime; } catch {} }
  return null;
}

on('qualitySelect', 'change', e => {
  const v = +e.target.value;
  if (hls) hls.currentLevel = v;
  else if (sk) {
    sk.configure({ abr: { enabled: v < 0 } });
    if (v > 0) {
      const t = sk.getVariantTracks().filter(t => t.height === v).sort((a, b) => b.bandwidth - a.bandwidth)[0];
      if (t) sk.selectVariantTrack(t, true);
    }
  }
});
on('liveBtn', 'click', goLive);
on('edgeSelect', 'change', e => { store.set('edge', e.target.value); cur && play(cur); });
on('modeSelect', 'change', e => { store.set('mode', e.target.value); cur && play(cur); });
on('favBtn', 'click', () => cur && toggleFav(cur.name));
on('reloadBtn', 'click', () => loadChannels(true));
on('group', 'change', render);

let searchTimer;
on('search', 'input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(render, 150); });

$('channels')?.addEventListener('click', e => {
  const f = e.target.closest('[data-fav]');
  if (f) { e.stopPropagation(); return toggleFav(f.dataset.fav); }
  const b = e.target.closest('.ch');
  if (b) play(channels[+b.dataset.id]);
});

video.addEventListener('waiting', () => cur && setStatus('Buffering…'));
video.addEventListener('playing', () => cur && setStatus('LIVE'));

// Latency display
setInterval(() => {
  const l = getLag();
  if ($('latency')) $('latency').textContent = 'Latency: ' + (l == null ? '--' : l.toFixed(1) + 's');
}, 1000);

// Auto-live: lag limit thaandi pona automatic-a live-kku jump
let lastJump = 0;
setInterval(() => {
  const limit = +($('autoLiveSelect')?.value || 0);
  if (!limit || !cur || video.paused || video.seeking) return;
  if (Date.now() - lastJump < 8000) return;
  const lag = getLag();
  if (lag != null && lag > limit) { lastJump = Date.now(); goLive(); }
}, 1000);

// Auto-live setting save/restore
if ($('autoLiveSelect')) {
  $('autoLiveSelect').value = String(store.get('
