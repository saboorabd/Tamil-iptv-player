const video = document.getElementById("video");
const channelsEl = document.getElementById("channels");
const searchEl = document.getElementById("search");
const groupEl = document.getElementById("group");
const qualityEl = document.getElementById("qualitySelect");
const edgeEl = document.getElementById("edgeSelect");
const statusEl = document.getElementById("status");
const latencyEl = document.getElementById("latency");
const qualityStatusEl = document.getElementById("quality");
const liveBtn = document.getElementById("liveBtn");
const reloadBtn = document.getElementById("reloadBtn");

let hls = null;
let shakaPlayer = null;
let channels = [];
let current = null;
let currentIndex = -1;
let retryTimer = null;
let latencyTimer = null;

// Use relative URL for server proxy
const PROXY_ENDPOINT = "/proxy?url=";

const FAVORITES_KEY = "tamil_iptv_favorites";
const RECENT_KEY = "tamil_iptv_recent";

const favorites = new Set(JSON.parse(localStorage.getItem(FAVORITES_KEY) || "[]"));
const recent = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");

function setStatus(text) {
  if (statusEl) statusEl.textContent = text;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[char]));
}

/* -----------------------------
   ADVANCED M3U PARSER
----------------------------- */

function parseM3U(text) {
  const lines = text.split(/\r?\n/);
  const result = [];
  let info = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith("#EXTINF:")) {
      const comma = line.indexOf(",");
      const attrs = comma >= 0 ? line.slice(0, comma) : line;
      const name = comma >= 0 ? line.slice(comma + 1).trim() : "Unknown Channel";

      const getAttribute = key => {
        const regex = new RegExp(`${key}="([^"]*)"`);
        const match = attrs.match(regex);
        return match ? match[1] : "";
      };

      info = {
        name,
        id: getAttribute("tvg-id"),
        logo: getAttribute("tvg-logo"),
        group: getAttribute("group-title") || "Other",
        drm: null,
        headers: {}
      };

    } else if (line.startsWith("#KODIPROP:inputstream.adaptive.license_key=")) {
      const keyStr = line.split("=")[1]?.trim();
      if (keyStr && keyStr.includes(":")) {
        const [kid, key] = keyStr.split(":");
        info.drm = { kid, key };
      }
    } else if (line.startsWith("#EXTHTTP:")) {
      try {
        const jsonStr = line.replace("#EXTHTTP:", "").trim();
        info.headers = JSON.parse(jsonStr);
      } catch (e) {
        console.error("Failed to parse EXTHTTP headers", e);
      }
    } else if (!line.startsWith("#") && info.name) {
      result.push({
        ...info,
        url: line,
        isDash: line.includes(".mpd") || (info.drm !== null)
      });
      info = {};
    }
  }

  return result;
}

/* -----------------------------
   UI RENDER
----------------------------- */

function renderGroups() {
  const groups = [...new Set(channels.map(ch => ch.group))].sort();
  groupEl.innerHTML =
    `<option value="all">All Channels</option>` +
    groups.map(g => `<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`).join("");
}

function renderChannels() {
  const query = searchEl.value.toLowerCase().trim();
  const group = groupEl.value;

  const filtered = channels.filter(ch => {
    const matchesSearch = ch.name.toLowerCase().includes(query);
    const matchesGroup = group === "all" || ch.group === group;
    return matchesSearch && matchesGroup;
  });

  if (!filtered.length) {
    channelsEl.innerHTML = `<div style="padding:30px;text-align:center;color:#8993a8;">No channels found</div>`;
    return;
  }

  channelsEl.innerHTML = filtered.map(ch => {
    const index = channels.indexOf(ch);
    const isFav = favorites.has(channelKey(ch));

    return `
      <div class="channel" data-index="${index}" style="cursor:pointer;">
        ${ch.logo ? `<img src="${escapeHtml(ch.logo)}" loading="lazy" onerror="this.style.display='none'">` : ""}
        <span style="flex:1">
          <span class="channel-name">${escapeHtml(ch.name)}</span><br>
          <span class="channel-group">${escapeHtml(ch.group)}</span>
        </span>
        <button class="favorite-btn" data-favorite="${index}">${isFav ? "★" : "☆"}</button>
      </div>
    `;
  }).join("");

  channelsEl.querySelectorAll(".channel").forEach(el => {
    el.addEventListener("click", ev => {
      if (ev.target.closest(".favorite-btn")) return;
      playChannel(channels[Number(el.dataset.index)]);
    });
  });

  channelsEl.querySelectorAll(".favorite-btn").forEach(btn => {
    btn.addEventListener("click", ev => {
      ev.stopPropagation();
      toggleFavorite(channels[Number(btn.dataset.favorite)]);
    });
  });
}

function channelKey(ch) {
  return ch.id || ch.url || ch.name;
}

function toggleFavorite(ch) {
  const key = channelKey(ch);
  if (favorites.has(key)) favorites.delete(key);
  else favorites.add(key);
  localStorage.setItem(FAVORITES_KEY, JSON.stringify([...favorites]));
  renderChannels();
}

/* -----------------------------
   DESTROY PLAYER
----------------------------- */

async function destroyPlayer() {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  if (hls) {
    hls.destroy();
    hls = null;
  }
  if (shakaPlayer) {
    await shakaPlayer.destroy();
    shakaPlayer = null;
  }
  video.pause();
  video.removeAttribute("src");
  video.load();
}

/* -----------------------------
   PLAY CHANNEL ROUTER
----------------------------- */

async function playChannel(channel) {
  if (!channel || !channel.url) return;

  current = channel;
  currentIndex = channels.indexOf(channel);

  await destroyPlayer();

  setStatus(`Loading ${channel.name}...`);
  latencyEl.textContent = "Latency: --";
  qualityStatusEl.textContent = "Quality: --";

  if (channel.isDash || channel.drm) {
    playShakaDASH(channel);
  } else {
    playHLS(channel);
  }

  renderChannels();
}

/* -----------------------------
   SHAKA PLAYER (DASH & DRM)
----------------------------- */

async function playShakaDASH(channel) {
  shaka.polyfill.installAll();
  shakaPlayer = new shaka.Player(video);

  if (channel.drm) {
    const clearKeys = {};
    clearKeys[channel.drm.kid] = channel.drm.key;
    shakaPlayer.configure({
      drm: { clearKeys: clearKeys }
    });
  }

  // Pass headers via proxy
  let finalUrl = PROXY_ENDPOINT + encodeURIComponent(channel.url);
  if (channel.headers.cookie) finalUrl += '&cookie=' + encodeURIComponent(channel.headers.cookie);
  if (channel.headers.Origin) finalUrl += '&referer=' + encodeURIComponent(channel.headers.Origin);

  try {
    await shakaPlayer.load(finalUrl);
    setStatus(`LIVE • ${channel.name}`);
    video.play().catch(() => setStatus("Press Play to start"));
  } catch (e) {
    console.error("Shaka Player Error:", e);
    setStatus("DRM or DASH Stream error");
  }
}

/* -----------------------------
   HLS PLAYER (HLS.JS)
----------------------------- */

function playHLS(channel) {
  let streamUrl = PROXY_ENDPOINT + encodeURIComponent(channel.url);

  if (window.Hls && Hls.isSupported()) {
    hls = new Hls({
      enableWorker: true,
      lowLatencyMode: true,
      manifestLoadingMaxRetry: 3
    });

    hls.attachMedia(video);
    hls.on(Hls.Events.MEDIA_ATTACHED, () => hls.loadSource(streamUrl));
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      setStatus(`LIVE • ${channel.name}`);
      video.play().catch(() => setStatus("Press Play to start"));
    });

    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (data.fatal) {
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          setStatus("Reconnecting stream...");
          hls.startLoad();
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          hls.recoverMediaError();
        } else {
          setStatus("Stream unavailable");
          destroyPlayer();
        }
      }
    });

  } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = streamUrl;
    video.play().catch(() => {});
  } else {
    setStatus("HLS not supported on this browser");
  }
}

/* -----------------------------
   PLAYLIST LOADER
----------------------------- */

async function loadPlaylist() {
  setStatus("Loading channels...");
  try {
    const response = await fetch("/tamil channe.m3u", { cache: "no-store" });
    if (!response.ok) throw new Error("Playlist not found");

    const text = await response.text();
    channels = parseM3U(text);

    renderGroups();
    renderChannels();
    setStatus(channels.length ? `${channels.length} channels ready` : "Playlist is empty");

  } catch (error) {
    console.error("Playlist error:", error);
    setStatus("Could not load playlist");
  }
}

searchEl.addEventListener("input", renderChannels);
groupEl.addEventListener("change", renderChannels);
reloadBtn.addEventListener("click", loadPlaylist);

loadPlaylist();
