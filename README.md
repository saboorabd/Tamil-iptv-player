# Tamil IPTV Player

A web IPTV player (HLS, DASH/DRM, raw MPEG-TS/FLV) with a built-in proxy, a live TV guide and a channel health radar.
Use it only with streams you own or are authorized to access.

## Features

- **Plays through its own proxy**: the browser only talks to your site, so there are no CORS or mixed-content errors.
  Headers from the playlist (`#EXTVLCOPT`, `#EXTHTTP`, `#KODIPROP`, `url|Header=Value`) and DRM keys are honoured; when a
  provider refuses the request, other player User-Agents (OTT Navigator, VLC, ExoPlayer ...) are tried automatically.
- **Players**: hls.js, Shaka (DASH / ClearKey / Widevine), mpegts.js (raw TS / FLV), native HLS (Safari).
  If a stream fails, the server looks at what the link really delivers and the player switches type by itself.
- **TV guide (XMLTV)**: NOW / NEXT under the player and a MyDish-style grid (channels down, time across, Today / Tomorrow / day after).
  The video stays pinned on top on a phone and is never covered. Tap a programme for details, tap a channel to watch.
  The guide refreshes itself every 3 hours (like OTT Navigator).
- **Pulse**: channel health radar (UP / SLOW / STALE / DOWN), failover to a healthy source, live viewers.
- **Diagnosis**: when a channel does not play, a card explains why (blocked, dead link, web page, DRM without key ...).
- LIVE button, fullscreen with auto-rotate, picture fit (Fit / Zoom / Stretch), quality menu, favourites, search, categories.

## Run locally

```bash
npm install
npm start          # http://localhost:10000
```

Put your playlist in `public/playlist.m3u` (or set `PLAYLIST_URL`). `Scripts/clean-m3u.js` removes duplicates:

```bash
node Scripts/clean-m3u.js input.m3u public/playlist.m3u
```

## TV guide (EPG) settings

Nothing is needed: when no guide is configured, the free guides from `github.com/mitthu786/tvepg` (Tata Play, all-in-one, JioTV) are used.

| Setting | What it does |
| --- | --- |
| `EPG_URL` | your own XMLTV link(s), comma separated (`.xml` or `.xml.gz`) |
| `url-tvg="..."` in the `#EXTM3U` line | guide link taken from the playlist |
| `public/epg.xml` / `epg.xml.gz` | local guide file |
| `EPG_REFRESH_HOURS` | how often the guide is downloaded (default 3) |
| `EPG_PREFER_LANG` | language preferred when a guide has the same channel in several languages (default `tamil`, empty = off) |
| `EPG_ALIASES` | manual fix: `Playlist Name=Guide Name;Other Name=Other Guide Name` |
| `EPG_MATCH_NUMERIC_IDS=1` | trust numeric `tvg-id` values as guide ids |

Channels are matched to the guide by `tvg-id`, then by name. The name match ignores quality / filler words
(HD, SD, 1080p, TV, IN ...) and spelling like `Sony YAY! Tamil HD` = `Sony Yay (Tamil)` = `SonyYay Tamil`.
If a guide channel has no current programmes (the free guides sometimes lag a day), a sibling with data is used.

Check what matched: `/api/epg/match?q=yay` (channels whose name contains `yay`) or `/health`.

## Render

`render.yaml` is included (build `npm install`, start `npm start`, health check `/health`). Set `PLAYLIST_URL` if the
playlist is not in the repository.

## Other settings

`ALLOWED_HOSTS`, `STRICT_HOSTS=1`, `ALLOW_PRIVATE`, `PULSE_INTERVAL_MIN`, `PULSE_IDLE_MIN`, `PULSE_CONCURRENCY`, `PULSE_DISABLE=1`.

## License

MIT for this project code. Stream URLs, channel logos, broadcasts, trademarks and other third-party material remain subject to their respective owners' rights and terms.
