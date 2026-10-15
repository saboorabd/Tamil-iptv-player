'use strict';
/**
 * DIAG - "why does this channel not play?"
 * ------------------------------------------------------------------
 * GET /api/diag/:id  inspects one channel the same way the proxy does and returns a plain verdict:
 *
 *   - blocked / dead / expired link        (HTTP 401/403/404/410/429/5xx)
 *   - web page instead of a stream         (login page, geo block page)
 *   - CORS: can the browser play it directly, or must it go through /proxy?
 *   - mixed content (http stream on an https page)
 *   - DRM: DASH ContentProtection / HLS SAMPLE-AES + KEYFORMAT detection, and whether your
 *     playlist actually carries ClearKey keys or a license server for it
 *   - standard AES-128 HLS (plays normally, not DRM)
 *
 * It only READS and EXPLAINS. It does not extract keys and does not change how a stream is requested.
 *
 * Install in server.js, before the express.static line:
 *   require('./diag')(app, { list: () => cache.list, load: loadChannels, fetchUA, UA, sniffKind, httpReason });
 */

const SCHEME = {
  widevine: 'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed',
  playready: '9a04f079-9840-4286-ab92-e65be0885f95',
  clearkey: 'e2719d58-a985-b3c9-781a-b030af78d30e',
};

async function readHead(body, max) {
  const reader = body.getReader(), parts = []; let n = 0;
  while (n < max) {
    const { value, done } = await reader.read();
    if (done) break;
    parts.push(Buffer.from(value)); n += value.length;
  }
  reader.cancel().catch(() => {});
  return Buffer.concat(parts);
}

function analyseDash(text) {
  const schemes = [...text.matchAll(/<ContentProtection\b[^>]*?schemeIdUri\s*=\s*"([^"]+)"/gi)].map(m => m[1].toLowerCase());
  return {
    protectedStream: schemes.length > 0,
    widevine: schemes.some(s => s.includes(SCHEME.widevine)),
    playready: schemes.some(s => s.includes(SCHEME.playready)),
    clearkey: schemes.some(s => s.includes(SCHEME.clearkey)),
  };
}

function analyseHls(text) {
  let aes = false, drm = false;
  for (const m of text.matchAll(/#EXT-X-(?:SESSION-)?KEY:([^\r\n]+)/gi)) {
    const method = (m[1].match(/METHOD=([^,]+)/i) || [])[1] || '';
    const fmt = (m[1].match(/KEYFORMAT="([^"]+)"/i) || [])[1] || 'identity';
    if (/SAMPLE-AES/i.test(method) || !/identity/i.test(fmt)) drm = true;
    else if (/AES-128/i.test(method)) aes = true;
  }
  return { aes, drm };
}

// Does the playlist carry usable ClearKey info for this channel?
function clearKeyInfo(drm) {
  if (!drm || !drm.key) return { has: false, clear: false };
  const type = (drm.type || '').trim().toLowerCase();
  if (type && !type.includes('clearkey')) return { has: true, clear: false, license: (drm.key.split('|')[0] || '').trim() };
  const k = drm.key.trim();
  const ok = /^[0-9a-f]{32}:[0-9a-f]{32}/i.test(k) || k.startsWith('{') || /^https?:/i.test(k);
  return { has: true, clear: ok };
}

const v = (level, code, title, why, fix) => ({ level, code, title, why, fix });

function verdict(o) {
  if (o.net) return v('bad', 'unreachable', 'Cannot reach the stream server', o.net,
    'The link may be down, or the provider blocks cloud servers (like Render). Try again later or use another source.');
  if (o.status === 401 || o.status === 403) return v('bad', 'blocked', 'The server refused the request (HTTP ' + o.status + ')',
    'The provider needs a login/token, a specific app, or blocks this server\'s IP address.',
    'Check that the URL/token in your playlist is still valid (many tokens only work from the IP that created them). The player already retried with other app identities and a provider Referer. If it works in OTT Navigator, copy that channel\'s #EXTVLCOPT / #EXTHTTP / |User-Agent=... lines into playlist.m3u.');
  if (o.status === 451) return v('bad', 'geo', 'Blocked for legal / regional reasons (HTTP 451)',
    'The provider refuses this server\'s location (e.g. a cloud server outside India). Your own phone / home connection may be allowed.',
    'The player automatically tries your phone directly (works when the stream allows browsers). If it still fails, the provider blocks browsers too: use another source for this channel.');
  if (o.status === 404 || o.status === 410) return v('bad', 'dead', 'Stream not found (HTTP ' + o.status + ')',
    'The link is dead or the token has expired.', 'Get a fresh link from your provider and update playlist.m3u.');
  if (o.status === 429) return v('warn', 'ratelimit', 'Provider is rate-limiting (HTTP 429)', 'Too many requests in a short time.', 'Wait a minute, then retry. Lower PULSE_CONCURRENCY if Pulse is probing too much.');
  if (o.status >= 500) return v('warn', 'server', 'Provider server error (HTTP ' + o.status + ')', 'The stream server is having problems.', 'Retry later.');
  if (o.status >= 400) return v('bad', 'http', 'The server answered HTTP ' + o.status, 'Unexpected answer from the provider.', 'Retry, or check the link.');
  if (o.kind === 'html') return v('bad', 'webpage', 'The link returns a web page, not a video',
    'Usually a login page, a geo/IP block page or an expired link.', 'Open the URL in a browser to see what it shows, then fix or replace the link.');
  if (o.kind === 'empty') return v('bad', 'empty', 'The server connected but sent no data', 'The channel is offline right now.', 'Retry later.');

  const protectedStream = o.dash.protectedStream || o.hls.drm;
  if (protectedStream) {
    const sys = [o.dash.widevine && 'Widevine', o.dash.playready && 'PlayReady', o.dash.clearkey && 'ClearKey', o.hls.drm && 'HLS DRM'].filter(Boolean).join(', ') || 'DRM';
    if (o.key.has && o.key.clear) return v('ok', 'drm-clearkey', 'DRM stream (' + sys + ') with ClearKey keys in your playlist',
      'Playback uses the keys from your #KODIPROP license_key line.', 'If it still fails, the key pair (KID:KEY) is probably wrong or expired.');
    if (o.key.has) return v('warn', 'drm-license', 'DRM stream (' + sys + ') using a license server',
      'The license request is sent through this server\'s proxy with the headers from your playlist.',
      'Make sure the license URL/headers are valid and your device supports that DRM (see "Device DRM" below). Chrome/Android: Widevine. Safari/iPhone: FairPlay only, so Widevine channels will not play there.');
    return v('bad', 'drm-nokey', 'DRM-protected, but your playlist has no key for it (' + sys + ')',
      'The stream is encrypted and the playlist has no ClearKey key or license URL. No player can decode it without one.',
      'If you are licensed to watch it, add the license_key from your provider to the #KODIPROP lines. Otherwise pick another source for this channel.');
  }
  if (o.hls.aes) return v('ok', 'aes', 'Standard AES-128 encrypted HLS', 'This is normal HLS encryption (not DRM); the player fetches the key through the proxy.', 'No action needed.');
  if (o.https === false && o.pageHttps !== false) return v('warn', 'mixed', 'http:// stream', 'Browsers block direct http streams on https pages (mixed content).', 'Playback must go through the proxy; the player already does this.');
  return v('ok', 'ok', 'Stream looks healthy', 'The server returned a valid ' + (o.kind || 'stream') + '.', o.corsOpen ? 'Direct browser playback is also possible.' : 'Playback goes through the proxy, which avoids CORS errors.');
}

module.exports = function diag(app, { list, load, fetchUA, UA, sniffKind, httpReason }) {
  const cooldown = new Map();

  app.get('/api/diag/:id', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!list().length) await load().catch(() => {});
    const id = Number(req.params.id), ch = list()[id];
    if (!ch) return res.status(404).json({ error: 'Unknown channel' });
    const now = Date.now();
    if (now - (cooldown.get(id) || 0) < 4000) return res.status(429).json({ error: 'Please wait a few seconds' });
    cooldown.set(id, now);
    if (cooldown.size > 500) cooldown.clear();

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 20_000);
    res.on('close', () => ac.abort());

    const url = new URL(ch.url);
    const o = {
      status: 0, kind: '', ct: '', ua: '', corsOpen: false, net: '',
      https: url.protocol === 'https:', host: url.hostname,
      dash: { protectedStream: false }, hls: { aes: false, drm: false },
      key: clearKeyInfo(ch.drm), hasHeaders: !!(ch._h && Object.keys(ch._h).length),
    };
    try {
      const headers = { 'User-Agent': UA, ...(ch._h || {}) };
      const own = ch._h && ch._h['User-Agent'];
      const up = await fetchUA(url, headers, ac.signal, {}, own);
      o.status = up.status; o.ct = up.headers.get('content-type') || ''; o.ua = up.ua || '';
      const acao = up.headers.get('access-control-allow-origin') || '';
      o.corsOpen = up.ok && acao === '*';
      o.cors = acao || 'none';
      if (!up.ok) { try { await up.body?.cancel(); } catch {} }
      else {
        const buf = await readHead(up.body, 256 * 1024);
        o.kind = sniffKind(buf.slice(0, 4096));
        const text = buf.toString('utf8');
        if (o.kind === 'dash') o.dash = analyseDash(text);
        else if (o.kind === 'hls') {
          o.hls = analyseHls(text);
          const sub = text.split(/\r?\n/).map(l => l.trim());
          const i = sub.findIndex(l => l.startsWith('#EXT-X-STREAM-INF'));
          if (i >= 0 && !o.hls.drm) {                                      // master playlist: peek at the first variant for #EXT-X-KEY
            const vl = sub.slice(i + 1).find(l => l && !l.startsWith('#'));
            if (vl) try {
              const vu = await fetchUA(new URL(vl, up.finalUrl), headers, ac.signal, {}, own);
              if (vu.ok) { const h2 = analyseHls((await readHead(vu.body, 128 * 1024)).toString('utf8')); o.hls.aes = o.hls.aes || h2.aes; o.hls.drm = o.hls.drm || h2.drm; }
              else try { await vu.body?.cancel(); } catch {}
            } catch {}
          }
        }
      }
    } catch (e) {
      o.net = ac.signal.aborted ? 'Timed out waiting for the stream server.' : e.message;
    } finally { clearTimeout(timer); }

    const verdictObj = verdict(o);
    res.json({
      id, name: ch.name, ...verdictObj,
      facts: {
        http: o.status || null, kind: o.kind || null, contentType: o.ct, host: o.host, https: o.https,
        cors: o.cors || null, directPlayPossible: !!(o.corsOpen && o.https),
        drm: o.dash.protectedStream || o.hls.drm,
        drmSystems: [o.dash.widevine && 'widevine', o.dash.playready && 'playready', o.dash.clearkey && 'clearkey', o.hls.drm && 'hls-drm'].filter(Boolean),
        playlistHasKey: o.key.has, userAgentUsed: o.ua || null, customHeaders: o.hasHeaders,
        note: o.status >= 400 ? httpReason(o.status) : '',
      },
    });
  });
};
