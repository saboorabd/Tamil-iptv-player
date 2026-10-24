const proxyHandler = async (req, res) => {
  let url;
  try { url = new URL(String(req.query.url || '')); } catch { return res.status(400).send('bad url'); }
  if (!cache.list.length) await loadChannels().catch(() => {});
  
  const chan = cache.list[Number(req.query.ch)];
  allowed.add(url.hostname.toLowerCase());
  allowed.add('jiotv-private-5gu7.onrender.com'); // JioTV private host allow panna

  const ac = new AbortController();
  res.on('close', () => ac.abort());
  try {
    const headers = { 'User-Agent': UA, ...((chan && chan._h) || {}) };
    if (req.headers.range) headers.Range = req.headers.range;
    const init = {};
    
    if (req.method === 'POST') {
      init.method = 'POST';
      if (Buffer.isBuffer(req.body) && req.body.length) init.body = req.body;
      for (const [k, v] of Object.entries(req.headers)) {
        if (!/^(host|connection|content-length|origin|referer|cookie|accept-encoding|accept-language|user-agent|upgrade|sec-|priority|range|if-|x-forwarded|x-real-ip|x-render|x-request-id|x-final-url|cf-|cdn-loop|true-client-ip|rndr-)/.test(k)) headers[k] = v;
      }
    }
    
    let up;
    if (req.method === 'GET' && !req.headers.range) {
      const pend = inflight.get(url.href); if (pend) await pend;
      const hit = warmGet(url.href);
      if (hit) {
        up = new Response(hit.buf, { status: 200, headers: { 'content-length': String(hit.buf.length), ...(hit.ct ? { 'content-type': hit.ct } : {}) } });
        up.finalUrl = hit.finalUrl;
      }
    }
    
    if (!up) {
      try {
        up = await fetchUA(url, headers, ac.signal, init, chan && chan._h && chan._h['User-Agent']);
      } catch (err) {
        return res.status(502).set('Access-Control-Allow-Origin', '*').send('Upstream connection error: ' + err.message);
      }
    }

    if (up.status >= 500) {
      return res.status(502).set('Access-Control-Allow-Origin', '*').send(`Upstream Server Error: HTTP ${up.status}`);
    }

    res.status(up.status).set({ 
      'Access-Control-Allow-Origin': '*', 
      'Access-Control-Expose-Headers': 'Content-Length, Content-Range, X-Final-Url', 
      'X-Final-Url': up.finalUrl 
    });

    const ct = up.headers.get('content-type') || '';
    const looksPlaylist = /mpegurl/i.test(ct) || /\.m3u8?(\?|$)/i.test(url.pathname);
    const maybePlaylist = req.method === 'GET' && !looksPlaylist && /^(text\/|application\/(octet-stream|x-?unknown)|$)/i.test(ct) && !req.headers.range;
    
    const sendPlaylist = text => {
      const w = req.query.w === '1';
      if (w) { try { prefetchFrom(text, up.finalUrl, chan); } catch {} }
      return res.type('application/vnd.apple.mpegurl').set('Cache-Control', 'no-store')
        .send(rewriteM3U8(text, up.finalUrl, chan ? chan.id : null, req.query.nc === '1', w));
    };

    if (looksPlaylist) {
      const text = await up.text();
      if (up.ok && !/^\s*#EXTM3U/.test(text)) return res.status(502).send('upstream did not return a valid playlist');
      return up.ok ? sendPlaylist(text) : res.send(text);
    }
    if (!up.body) return res.end();
    
    const reader = Readable.fromWeb(up.body);
    if (maybePlaylist) {
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
    
    for (const h of ['content-type', 'content-range', 'accept-ranges']) {
      const v = up.headers.get(h);
      if (v) res.set(h, v);
    }
    if (!up.headers.get('content-encoding')) { const l = up.headers.get('content-length'); if (l) res.set('content-length', l); }
    res.set('Cache-Control', req.method === 'POST' || !up.headers.get('content-length') ? 'no-store' : 'public, max-age=5');
    reader.on('error', () => res.end()).pipe(res);
  } catch (e) {
    if (!res.headersSent) res.status(502).set('Access-Control-Allow-Origin', '*').send('Proxy error: ' + e.message);
  }
};
