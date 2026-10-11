'use strict';
/**
 * RESILIENCE - failure explainer panel (client side)
 * ------------------------------------------------------------------
 * Watches the player status line. When a channel fails ("Cannot play: ..." / "Playback stopped: ..."),
 * it asks the server (/api/diag/:id) why, and shows a clear card under the player:
 *   - what is wrong (blocked, dead link, web page, DRM without key, CORS, ...)
 *   - what you can do about it
 *   - which DRM systems THIS device supports (Widevine / PlayReady / ClearKey / FairPlay)
 *   - buttons: Retry, Re-test
 * Nothing in app.js has to change. Add after app.js in index.html:
 *   <script defer src="resilience.js"></script>
 */
(function () {
  const $ = id => document.getElementById(id);
  const statusEl = $('status');
  if (!statusEl) return;

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------- styles ---------- */
  const css = document.createElement('style');
  css.textContent = `
  #diagPanel{margin:10px 14px;padding:12px 14px;border-radius:14px;border:1px solid var(--line-strong,#2a3550);
    background:var(--card,rgba(16,22,40,.92));color:var(--text,#e8eefc);font-size:14px;line-height:1.45}
  #diagPanel[hidden]{display:none}
  #diagPanel h4{margin:0 0 6px;font-size:15px;display:flex;gap:8px;align-items:center}
  #diagPanel .dot{width:10px;height:10px;border-radius:50%;flex:none}
  #diagPanel.ok .dot{background:#36d399}#diagPanel.warn .dot{background:#f5b042}#diagPanel.bad .dot{background:#ff5d6c}#diagPanel.wait .dot{background:#5b6b86}
  #diagPanel p{margin:4px 0;color:var(--mute,#9db0cf)}
  #diagPanel p b{color:var(--text,#e8eefc)}
  #diagPanel .facts{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}
  #diagPanel .facts span{padding:2px 9px;border-radius:999px;font-size:12px;border:1px solid var(--line,#26324d);color:var(--mute,#9db0cf)}
  #diagPanel .facts span.y{color:#36d399;border-color:#36d39966}#diagPanel .facts span.n{color:#ff8a95;border-color:#ff5d6c66}
  #diagPanel .row{display:flex;gap:8px;margin-top:8px}
  #diagPanel button{padding:6px 12px;border-radius:999px;font-size:13px;cursor:pointer}
  `;
  document.head.appendChild(css);

  const panel = document.createElement('section');
  panel.id = 'diagPanel'; panel.hidden = true;
  const anchor = document.querySelector('.now') || document.querySelector('.video-wrapper');
  if (anchor) anchor.after(panel); else document.body.appendChild(panel);

  /* ---------- which DRM systems does THIS device support? ---------- */
  let drmSupport = null;
  async function probeDrm() {
    if (drmSupport) return drmSupport;
    const out = { widevine: false, playready: false, clearkey: false, fairplay: false, secure: window.isSecureContext !== false };
    if (!navigator.requestMediaKeySystemAccess) { drmSupport = out; return out; }
    const cfg = [{
      initDataTypes: ['cenc'],
      videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }],
      audioCapabilities: [{ contentType: 'audio/mp4; codecs="mp4a.40.2"' }],
    }];
    const test = async ks => { try { await navigator.requestMediaKeySystemAccess(ks, cfg); return true; } catch { return false; } };
    const [w, p, c] = await Promise.all([test('com.widevine.alpha'), test('com.microsoft.playready'), test('org.w3.clearkey')]);
    out.widevine = w; out.playready = p; out.clearkey = c;
    out.fairplay = !!(window.WebKitMediaKeys || (window.MediaKeys && /^((?!chrome|android).)*safari/i.test(navigator.userAgent)));
    drmSupport = out; return out;
  }

  /* ---------- render ---------- */
  const chip = (label, yes) => `<span class="${yes ? 'y' : 'n'}">${esc(label)}: ${yes ? 'yes' : 'no'}</span>`;

  async function paint(d) {
    const drm = await probeDrm();
    const f = d.facts || {};
    panel.className = d.level || 'wait'; panel.hidden = false;
    panel.innerHTML = `
      <h4><i class="dot"></i>${esc(d.title)}</h4>
      <p>${esc(d.why)}</p>
      <p><b>What to do:</b> ${esc(d.fix)}</p>
      <div class="facts">
        ${f.http ? `<span>HTTP ${esc(f.http)}</span>` : ''}${f.kind ? `<span>${esc(f.kind.toUpperCase())}</span>` : ''}
        ${chip('Direct browser play', f.directPlayPossible)}${f.drm ? chip('Stream is DRM', true) : ''}
        ${f.drm ? chip('Playlist has key', f.playlistHasKey) : ''}
      </div>
      <div class="facts"><span>Device DRM</span>${chip('Widevine', drm.widevine)}${chip('PlayReady', drm.playready)}${chip('ClearKey', drm.clearkey)}${drm.fairplay ? chip('FairPlay', true) : ''}${drm.secure ? '' : '<span class="n">Page is not https: DRM disabled by the browser</span>'}</div>
      <div class="row"><button id="diagRetry" type="button">Retry</button><button id="diagAgain" type="button">Re-test</button></div>`;
    $('diagRetry').onclick = () => { hide(); if (typeof cur !== 'undefined' && cur && typeof play === 'function') play(cur); };
    $('diagAgain').onclick = () => run(true);
  }

  function hide() { panel.hidden = true; panel.innerHTML = ''; }

  /* ---------- run diagnosis ---------- */
  let lastKey = '', busy = false;
  async function run(force) {
    if (typeof cur === 'undefined' || !cur || busy) return;
    const key = cur.id + '|' + statusEl.textContent;
    if (!force && key === lastKey) return;
    lastKey = key; busy = true;
    panel.className = 'wait'; panel.hidden = false;
    panel.innerHTML = '<h4><i class="dot"></i>Checking why this channel does not play…</h4>';
    try {
      const r = await fetch('/api/diag/' + cur.id, { cache: 'no-store' });
      if (r.status === 429) { panel.innerHTML = '<h4><i class="dot"></i>Please wait a few seconds, then press Re-test</h4><div class="row"><button id="diagAgain" type="button">Re-test</button></div>'; $('diagAgain').onclick = () => run(true); }
      else if (!r.ok) hide();
      else await paint(await r.json());
    } catch { hide(); }
    busy = false;
  }

  const failed = t => /^(Cannot play|Playback stopped)/.test(t.trim());
  new MutationObserver(() => {
    const t = statusEl.textContent;
    if (failed(t)) run(false);
    else if (/^(LIVE|Connecting|Buffering|Trying|Checking|Switching)/.test(t.trim())) { if (!busy) hide(); }
  }).observe(statusEl, { childList: true, characterData: true, subtree: true });
})();
