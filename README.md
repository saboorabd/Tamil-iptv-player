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

## DRM channels (ClearKey / Widevine / PlayReady)

Put the keys in the playlist with Kodi-style `#KODIPROP` lines, between the `#EXTINF` line and the stream URL:

```m3u
#EXTINF:-1 group-title="Premium",Channel name
#KODIPROP:inputstream.adaptive.manifest_type=mpd
#KODIPROP:inputstream.adaptive.license_type=clearkey
#KODIPROP:inputstream.adaptive.license_key=KEYID:KEY
https://provider/stream/manifest.mpd
```

| `license_type` | `license_key` |
| --- | --- |
| `clearkey` | `KID:KEY` in hex (32 + 32 chars). Several keys: `KID1:KEY1,KID2:KEY2`. Dashes in KID are fine. |
| `com.widevine.alpha` (or `widevine`) | license server URL, optionally with headers: `https://lic/url\|X-Token=abc&Origin=https%3A%2F%2Fsite` |
| `com.microsoft.playready` (or `playready`) | license server URL (same format as Widevine) |

`public/playlist.m3u` contains working public ClearKey and Widevine test streams (Axinom test vectors) and one
template line to replace with your own channel.

What a device can play: ClearKey works on every browser. Widevine needs Chrome / Edge / Android. iPhone and Safari
need FairPlay, which this player does not support. The license request is sent through this server's proxy, so the
license server does not need CORS. Keys and tokens are only as good as your provider's: a wrong or expired key shows
"DRM license/key problem" under the channel.

## Deploy on an Indian server (Oracle Cloud Always Free, Mumbai / Hyderabad)

Some streams only answer Indian IPs (HTTP 451 from US / EU servers). Render, Railway and Fly.io have no India region, so use an
Oracle Cloud Always Free VM in `ap-mumbai-1` or `ap-hyderabad-1`:

1. Create an Ubuntu ARM (Ampere A1) VM. Pay As You Go upgrade gets better capacity; a Visa / Mastercard credit card works (RuPay usually fails).
2. Open ports 80 and 443 in the VM's security list, and on the VM: `sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT` and the same for 443, then `sudo netfilter-persistent save`.
3. Point a free domain (DuckDNS, etc.) at the VM's public IP.
4. Install Docker (`curl -fsSL https://get.docker.com | sh`), copy this folder to the VM, `cp .env.example .env` and set `DOMAIN`.
5. `docker compose up -d --build`. Caddy gets the https certificate by itself.

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

`render.yaml` is included (build `npm install`, start `npm start`, health check `/health`).

1. Push this repo to GitHub, then on Render: New > Blueprint (or Web Service) and pick the repo.
2. In the Render dashboard, set `PLAYLIST_URL` to the link of your M3U (for example the output URL of your
   Xtream / MAC portal converter). Leave it empty to use `public/playlist.m3u` from the repo.
3. Open `https://<your-app>.onrender.com`.

**Auto refresh:** the server re-downloads `PLAYLIST_URL` when its copy is older than 60 seconds, so a playlist that your
converter rewrites is picked up by itself. The TV guide refreshes every 3 hours (`EPG_REFRESH_HOURS`).

**Free plan limits:** the service sleeps after about 15 minutes without visitors. The first open after that is slow and
the guide is re-downloaded then. Streams from providers that only allow Indian IPs return HTTP 451 on Render, because
Render's servers are in the US / Europe. Those channels need a host inside India or a playlist whose links are not region-locked.

## Other settings

`ALLOWED_HOSTS`, `STRICT_HOSTS=1`, `ALLOW_PRIVATE`, `PULSE_INTERVAL_MIN`, `PULSE_IDLE_MIN`, `PULSE_CONCURRENCY`, `PULSE_DISABLE=1`.

## License

MIT for this project code. Stream URLs, channel logos, broadcasts, trademarks and other third-party material remain subject to their respective owners' rights and terms.
