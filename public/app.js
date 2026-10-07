const video = document.getElementById("videoPlayer");
const channelListEl = document.getElementById("channelList");
const searchInput = document.getElementById("searchInput");
const groupSelect = document.getElementById("groupSelect");
const statusOverlay = document.getElementById("statusOverlay");
const currentChannelName = document.getElementById("currentChannelName");
const currentGroup = document.getElementById("currentGroup");
const channelCountEl = document.getElementById("channelCount");
const reloadBtn = document.getElementById("reloadBtn");

let channels = [];
let hlsPlayer = null;
let shakaPlayer = null;

/* ----------------------------------------------------
   1. M3U PARSER (EXTHTTP & KODIPROP SUPPORT)
---------------------------------------------------- */
function parseM3U(content) {
  const lines = content.split(/\r?\n/);
  const list = [];
  let currentObj = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith("#EXTINF:")) {
      const commaIndex = line.lastIndexOf(",");
      const title = commaIndex !== -1 ? line.substring(commaIndex + 1).trim() : "Unknown Channel";

      const logoMatch = line.match(/tvg-logo="([^"]*)"/);
      const groupMatch = line.match(/group-title="([^"]*)"/);

      currentObj = {
        name: title,
        logo: logoMatch ? logoMatch[1] : "",
        group: groupMatch ? groupMatch[1] : "General",
        drm: null,
        headers: {}
      };
    } 
    else if (line.startsWith("#KODIPROP:inputstream.adaptive.license_key=")) {
      const keyStr = line.split("=")[1]?.trim();
      if (keyStr && keyStr.includes(":")) {
        const [kid, key] = keyStr.split(":");
        currentObj.drm = { kid, key };
      }
    } 
    else if (line.startsWith("#EXTHTTP:")) {
      try {
        const jsonStr = line.replace("#EXTHTTP:", "").trim();
        currentObj.headers = JSON.parse(jsonStr);
      } catch (err) {
        console.error("EXTHTTP JSON Parse Error:", err);
      }
    } 
    else if (!line.startsWith("#")) {
      currentObj.url = line;
      if (currentObj.name) {
        list.push({ ...currentObj });
      }
      currentObj = {};
    }
  }
  return list;
}

/* ----------------------------------------------------
   2. LOAD PLAYLIST FROM SERVER
---------------------------------------------------- */
async function loadChannels() {
  statusOverlay.textContent = "Loading Playlist...";
  
  // Multiple fallback filename check
  const filesToTry = ["/tamil_playlist.m3u", "/tamil channe.m3u", "/tamil%20channe.m3u"];
  let text = "";

  for (const file of filesToTry) {
    try {
      const res = await fetch(file, { cache: "no-store" });
      if (res.ok) {
        text = await res.text();
        break;
      }
    } catch (e) {}
  }

  if (!text) {
    statusOverlay.textContent = "Error: M3U playlist file not found";
    return;
  }

  channels = parseM3U(text);

  if (channels.length === 0) {
    statusOverlay.textContent = "No valid channels found in M3U";
    return;
  }

  populateGroups();
  renderChannels();
  statusOverlay.textContent = "Select a Channel to Play";
}

/* ----------------------------------------------------
   3. UI RENDER FUNCTIONS
---------------------------------------------------- */
function populateGroups() {
  const groups = [...new Set(channels.map(c => c.group))].sort();
  groupSelect.innerHTML = `<option value="all">All Categories (${groups.length})</option>` +
    groups.map(g => `<option value="${g}">${g}</option>`).join("");
}

function renderChannels() {
  const query = searchInput.value.toLowerCase();
  const selectedGroup = groupSelect.value;

  const filtered = channels.filter(c => {
    const matchesSearch = c.name.toLowerCase().includes(query);
    const matchesGroup = selectedGroup === "all" || c.group === selectedGroup;
    return matchesSearch && matchesGroup;
  });

  channelCountEl.textContent = `${filtered.length} Channels Found`;

  if (filtered.length === 0) {
    channelListEl.innerHTML = `<div style="text-align:center; padding: 20px; color: #64748b;">No channels match search</div>`;
    return;
  }

  channelListEl.innerHTML = filtered.map((c) => {
    const originalIndex = channels.indexOf(c);
    return `
      <div class="channel-item" onclick="playChannel(${originalIndex})">
        <img src="${c.logo}" class="channel-logo" onerror="this.src='https://via.placeholder.com/40?text=TV'">
        <div class="channel-info">
          <h4>${c.name}</h4>
          <p>${c.group}</p>
        </div>
      </div>
    `;
  }).join("");
}

/* ----------------------------------------------------
   4. PLAYBACK CONTROLLER
---------------------------------------------------- */
async function playChannel(index) {
  const channel = channels[index];
  if (!channel) return;

  currentChannelName.textContent = channel.name;
  currentGroup.textContent = channel.group;
  statusOverlay.textContent = `Connecting to ${channel.name}...`;

  await stopCurrentPlayer();

  // Construct Proxy URL with Headers Query Parameters
  let proxiedUrl = `/proxy?url=${encodeURIComponent(channel.url)}`;

  if (channel.headers) {
    if (channel.headers.Cookie || channel.headers.cookie) {
      proxiedUrl += `&cookie=${encodeURIComponent(channel.headers.Cookie || channel.headers.cookie)}`;
    }
    if (channel.headers.Referer || channel.headers.referer || channel.headers.Origin) {
      proxiedUrl += `&referer=${encodeURIComponent(channel.headers.Referer || channel.headers.referer || channel.headers.Origin)}`;
    }
    if (channel.headers['User-Agent'] || channel.headers['user-agent']) {
      proxiedUrl += `&ua=${encodeURIComponent(channel.headers['User-Agent'] || channel.headers['user-agent'])}`;
    }
  }

  // Route DASH vs HLS
  if (channel.url.includes(".mpd") || channel.drm) {
    playDashStream(proxiedUrl, channel.drm);
  } else {
    playHlsStream(proxiedUrl);
  }
}

async function stopCurrentPlayer() {
  if (hlsPlayer) {
    hlsPlayer.destroy();
    hlsPlayer = null;
  }
  if (shakaPlayer) {
    await shakaPlayer.destroy();
    shakaPlayer = null;
  }
  video.pause();
  video.src = "";
}

/* ----------------------------------------------------
   5. HLS & SHAKA DASH PLAYERS
---------------------------------------------------- */
function playHlsStream(url) {
  if (Hls.isSupported()) {
    hlsPlayer = new Hls({ enableWorker: true });
    hlsPlayer.loadSource(url);
    hlsPlayer.attachMedia(video);

    hlsPlayer.on(Hls.Events.MANIFEST_PARSED, () => {
      video.play().catch(() => {});
      statusOverlay.textContent = "LIVE";
    });

    hlsPlayer.on(Hls.Events.ERROR, (_event, data) => {
      if (data.fatal) {
        statusOverlay.textContent = "HLS Stream Connection Failed";
      }
    });
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = url;
    video.play();
    statusOverlay.textContent = "LIVE";
  }
}

async function playDashStream(url, drm) {
  shaka.polyfill.installAll();
  shakaPlayer = new shaka.Player(video);

  if (drm && drm.kid && drm.key) {
    const clearKeys = {};
    clearKeys[drm.kid] = drm.key;
    shakaPlayer.configure({
      drm: { clearKeys: clearKeys }
    });
  }

  try {
    await shakaPlayer.load(url);
    video.play();
    statusOverlay.textContent = "LIVE";
  } catch (e) {
    console.error("Shaka Player Error:", e);
    statusOverlay.textContent = "DASH/DRM Stream Error";
  }
}

// Global Event Handlers
searchInput.addEventListener("input", renderChannels);
groupSelect.addEventListener("change", renderChannels);
if (reloadBtn) reloadBtn.addEventListener("click", loadChannels);

// Run Engine
loadChannels();
