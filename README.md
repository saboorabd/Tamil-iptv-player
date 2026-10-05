# Tamil IPTV Player

A lightweight HLS/M3U web player designed for **streams you own or are authorized to access and redistribute**.

## Features

- HLS.js playback
- LL-HLS mode when the source supports it
- Live-edge monitoring
- Controlled live synchronization
- No intentional 2× catch-up
- Quality selector when the HLS manifest provides multiple renditions
- Channel search
- Category filtering
- Mobile-friendly UI
- Render deployment configuration
- `/health` endpoint

## Important limitation

A player cannot turn a normal HLS source into true LL-HLS. The source/streaming infrastructure must expose low-latency HLS parts for LL-HLS behavior.

Likewise, the player cannot create higher quality than the source provides. Forcing the highest rendition can cause buffering on a weak connection, so Auto/ABR is recommended.

## Run locally

```bash
npm install
npm start
```

Open:

```text
http://localhost:10000
```

Put your authorized playlist in:

```text
public/playlist.m3u
```

## Render

This repository includes `render.yaml`.

Create a Render Web Service from the repository. Render will use:

```text
Build: npm install
Start: npm start
```

The application listens on Render's `$PORT`.

## GitHub

After creating the repository:

```bash
git init
git add .
git commit -m "Initial IPTV player"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/tamil-iptv-player.git
git push -u origin main
```

## Stream compatibility

The browser must be allowed to fetch the HLS manifest. If the stream provider does not send suitable CORS headers, browser-side playback may fail. This project intentionally does not proxy or restream third-party streams.

## License

MIT for this project code. Stream URLs, channel logos, broadcasts, trademarks and other third-party material remain subject to their respective owners' rights and terms.