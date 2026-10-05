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
let channels = [];
let current = null;

function setStatus(text) {
  statusEl.textContent = text;
}

function parseM3U(text) {
  const lines = text.split(/\r?\n/);
  const result = [];
  let info = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith("#EXTINF:")) {
      const comma = line.indexOf(",");
      const attrs = comma >= 0 ? line.slice(0, comma) : line;
      const name = comma >= 0 ? line.slice(comma + 1).trim() : "Channel";

      const get = (key) => {
        const m = attrs.match(new RegExp(`${key}="([^"]*)"`));
        return m ? m[1] : "";
      };

      info = {
        name,
        id: get("tvg-id"),
        logo: get("tvg-logo"),
        group: get("group-title") || "Other"
      };
    } else if (!line.startsWith("#") && info) {
      result.push({ ...info, url: line });
      info = null;
    }
  }
  return result;
}

function renderGroups() {
  const groups = [...new Set(channels.map(c => c.group))].sort();
  groupEl.innerHTML = '<option value="all">All</option>' +
    groups.map(g => `<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`).join("");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#039;"
  }[c]));
}

function renderChannels() {
  const q = searchEl.value.toLowerCase().trim();
  const group = groupEl.value;

  const filtered = channels.filter(c =>
    (group === "all" || c.group === group) &&
    c.name.toLowerCase().includes(q)
  );

  channelsEl.innerHTML = filtered.map((c, i) => `
    <button class="channel" data-index="${channels.indexOf(c)}">
      ${c.logo ? `<img src="${escapeHtml(c.logo)}" loading="lazy" onerror="this.style.display='none'">` : ""}
      <span>
        <span class="channel-name">${escapeHtml(c.name)}</span><br>
        <span class="channel-group">${escapeHtml(c.group)}</span>
      </span>
    </button>
  `).join("");

  channelsEl.querySelectorAll(".channel").forEach(btn => {
    btn.addEventListener("click", () => playChannel(channels[Number(btn.dataset.index)]));
  });
}

function destroyPlayer() {
  if (hls) {
    hls.destroy();
    hls = null;
  }
  video.removeAttribute("src");
  video.load();
}

function playChannel(channel) {
  current = channel;
  destroyPlayer();
  setStatus(`Loading: ${channel.name}`);
  latencyEl.textContent = "Latency: --";
  qualityStatusEl.textContent = "Quality: --";

  if (Hls.isSupported()) {
    hls = new Hls({
      enableWorker: true,
      lowLatencyMode: true,

      // Do not use 2x catch-up. Keep normal playback and use a small drift
      // correction only when the source exposes a live edge.
      maxLiveSyncPlaybackRate: 1.02,

      liveSyncDurationCount: 2,
      liveMaxLatencyDurationCount: 4,

      backBufferLength: 30,
      maxBufferLength: 10,
      maxMaxBufferLength: 20,

      startLevel: -1
    });

    hls.loadSource(channel.url);
    hls.attachMedia(video);

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      populateQuality();
      setStatus("Playing");
      video.play().catch(() => {});
    });

    hls.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => {
      const level = hls.levels[data.level];
      if (level) {
        qualityStatusEl.textContent =
          `Quality: ${level.width || "?"}×${level.height || "?"}`;
      }
    });

    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal) return;

      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        setStatus("Network error — retrying");
        hls.startLoad();
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        setStatus("Media error — recovering");
        hls.recoverMediaError();
      } else {
        setStatus("Stream unavailable");
        destroyPlayer();
      }
    });

  } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = channel.url;
    video.play().catch(() => {});
    setStatus("Playing");
  } else {
    setStatus("HLS is not supported by this browser");
  }
}

function populateQuality() {
  qualityEl.innerHTML = '<option value="-1">Auto</option>';
  if (!hls) return;

  hls.levels.forEach((level, i) => {
    const option = document.createElement("option");
    option.value = i;
    option.textContent = `${level.height || "?"}p${level.bitrate ? ` • ${Math.round(level.bitrate / 1000)} kbps` : ""}`;
    qualityEl.appendChild(option);
  });
}

qualityEl.addEventListener("change", () => {
  if (hls) hls.currentLevel = Number(qualityEl.value);
});

edgeEl.addEventListener("change", () => {
  if (!hls || !hls.liveSyncPosition) return;
  // Safe mode intentionally keeps the player's normal live-sync target.
  // Near mode seeks once toward the live edge; it does not accelerate playback.
  if (edgeEl.value === "near" && Number.isFinite(hls.liveSyncPosition)) {
    video.currentTime = hls.liveSyncPosition;
  }
});

liveBtn.addEventListener("click", () => {
  if (hls && Number.isFinite(hls.liveSyncPosition)) {
    video.currentTime = hls.liveSyncPosition;
    video.play().catch(() => {});
  }
});

searchEl.addEventListener("input", renderChannels);
groupEl.addEventListener("change", renderChannels);
reloadBtn.addEventListener("click", loadPlaylist);

setInterval(() => {
  if (!hls || !Number.isFinite(hls.liveSyncPosition) || !Number.isFinite(video.currentTime)) {
    return;
  }
  const d = hls.liveSyncPosition - video.currentTime;
  latencyEl.textContent = `Latency: ${Math.max(0, d).toFixed(1)}s`;
}, 1000);

async function loadPlaylist() {
  setStatus("Loading playlist...");
  try {
    const response = await fetch("/tamil channe.m3u", { cache: "no-store" });
    if (!response.ok) throw new Error("tamil channe.m3u not found");
    channels = parseM3U(await response.text());
    renderGroups();
    renderChannels();
    if (channels.length) {
      setStatus(`${channels.length} stream entries loaded`);
    } else {
      setStatus("Playlist is empty");
    }
  } catch (err) {
    setStatus("Add your authorized own playlist as public/tamil channe.m3u");
    console.error(err);
  }
}

loadPlaylist();
