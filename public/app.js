const video = document.getElementById("videoPlayer");
const channelListEl = document.getElementById("channelList");
const searchInput = document.getElementById("searchInput");
const groupSelect = document.getElementById("groupSelect");
const statusOverlay = document.getElementById("statusOverlay");
const currentChannelName = document.getElementById("currentChannelName");
const currentGroup = document.getElementById("currentGroup");
const channelCountEl = document.getElementById("channelCount");

let channels = [];
let hlsPlayer = null;
let shakaPlayer = null;

/* ----------------------------------------------------
   1. FIXED M3U PARSER
---------------------------------------------------- */
function parseM3U(content) {
  const lines = content.split(/\r?\n/);
  const list = [];
  let currentObj = { headers: {}, drm: null };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith("#EXTINF:")) {
      const commaIndex = line.lastIndexOf(",");
      const title = commaIndex !== -1 ? line.substring(commaIndex + 1).trim() : "Unknown Channel";

      const logoMatch = line.match(/tvg-logo="([^"]*)"/i);
      const groupMatch = line.match(/group-title="([^"]*)"/i);

      currentObj.name = title;
      currentObj.logo = logoMatch ? logoMatch[1] : "https://via.placeholder.com/50?text=TV";
      currentObj.group = groupMatch ? groupMatch[1] : "General";
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
        console.error("EXTHTTP JSON Error:", err);
      }
    } 
    else if (!line.startsWith("#") && line.startsWith("http")) {
      currentObj.url = line;
      if (currentObj.name) {
        list.push({ ...currentObj });
      }
      currentObj = { headers: {}, drm: null };
    }
  }
  return list;
}

/* ----------------------------------------------------
   2. FETCH PLAYLIST
---------------------------------------------------- */
async function loadChannels() {
  if (statusOverlay) statusOverlay.textContent = "Loading Playlist...";

  const filesToTry = ["/playlist.m3u", "./playlist.m3u", "/tamil_playlist.m3u", "/tamil%20channe.m3u"];
  let text = "";

  for (const file of filesToTry) {
    try {
      const res = await fetch(`${file}?t=${Date.now()}`);
      if (res.ok) {
        text = await res.text();
        console.log("M3U Loaded from:", file);
        break;
      }
    } catch (e) {}
  }

  if (!text) {
    if (statusOverlay) statusOverlay.textContent = "Error: Playlist file not found";
    return;
  }

  channels = parseM3U(text);

  if (channels.length === 0) {
    if (statusOverlay) statusOverlay.textContent = "No Channels Found in M3U";
    return;
  }

  populateGroups();
  renderChannels();
  if (statusOverlay) statusOverlay.textContent = "Select a Channel to Play";
}

/* ----------------------------------------------------
   3. UI RENDER
---------------------------------------------------- */
function populateGroups() {
  if (!groupSelect) return;
  const groups = [...new Set(channels.map(c => c.group))].sort();
  groupSelect.innerHTML = `<option value="all">All Categories (${groups.length})</option>` +
    groups.map(g => `<option value="${g}">${g}</option>`).join("");
}

function renderChannels() {
  if (!channelListEl) return;
  const query = searchInput ? searchInput.value.toLowerCase() : "";
  const selectedGroup = groupSelect ? groupSelect.value : "all";

  const filtered = channels.filter(c => {
    const matchesSearch = c.name.toLowerCase().includes(query);
    const matchesGroup = selectedGroup === "all" || c.group === selectedGroup;
    return matchesSearch && matchesGroup;
  });

  if (channelCountEl) channelCountEl.textContent = `${filtered.length} Channels`;

  if (filtered.length === 0) {
    channelListEl.innerHTML = `<div style="text-align:center; padding: 20px; color: #aaa;">No channels found</div>`;
    return;
  }

  channelListEl.innerHTML = filtered.map((c) => {
    const originalIndex = channels.indexOf(c);
    return `
      <div class="channel-item" onclick="playChannel(${originalIndex})" style="display:flex; align-items:center; gap:10px; padding:10px; cursor:pointer; border-bottom:1px solid #222;">
        <img src="${c.logo}" style="width:40px; height:40px; object-fit:contain; border-radius:4px;" onerror="this.src='https://via.placeholder.com/40?text=TV'">
        <div>
          <h4 style="margin:0; font-size:14px; color:#fff;">${c.name}</h4>
          <p style="margin:0; font-size:11px; color:#888;">${c.group}</p>
        </div>
      </div>
    `;
  }).join("");
}

/* ----------------------------------------------------
   4. STREAM PLAYER
---------------------------------------------------- */
async function playChannel(index) {
  const channel = channels[index];
  if (!channel) return;

  if (currentChannelName) currentChannelName.textContent = channel.name;
  if (currentGroup) currentGroup.textContent = channel.group;
  if (statusOverlay) statusOverlay.textContent = `Connecting to ${channel.name}...`;

  await stopCurrentPlayer();

  let proxiedUrl = `/proxy?url=${encodeURIComponent(channel.url)}`;

  if (channel.headers) {
    if (channel.headers.Cookie || channel.headers.cookie) {
      proxiedUrl += `&cookie=${encodeURIComponent(channel.headers.Cookie || channel.headers.cookie)}`;
    }
    if (channel.headers.Referer || channel.headers.referer) {
      proxiedUrl += `&referer=${encodeURIComponent(channel.headers.Referer || channel.headers.referer)}`;
    }
  }

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
  if (video) {
    video.pause();
    video.src = "";
  }
}

function playHlsStream(url) {
  if (typeof Hls !== 'undefined' && Hls.isSupported()) {
    hlsPlayer = new Hls({ enableWorker: true });
    hlsPlayer.loadSource(url);
    hlsPlayer.attachMedia(video);

    hlsPlayer.on(Hls.Events.MANIFEST_PARSED, () => {
      video.play().catch(() => {});
      if (statusOverlay) statusOverlay.textContent = "LIVE";
    });
  } else if (video && video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = url;
    video.play();
    if (statusOverlay) statusOverlay.textContent = "LIVE";
  }
}

async function playDashStream(url, drm) {
  if (typeof shaka === 'undefined') return;
  shaka.polyfill.installAll();
  shakaPlayer = new shaka.Player(video);

  if (drm && drm.kid && drm.key) {
    const clearKeys = {};
    clearKeys[drm.kid] = drm.key;
    shakaPlayer.configure({ drm: { clearKeys: clearKeys } });
  }

  try {
    await shakaPlayer.load(url);
    video.play();
    if (statusOverlay) statusOverlay.textContent = "LIVE";
  } catch (e) {
    console.error("Shaka Player Error:", e);
  }
}

// Event Listeners
if (searchInput) searchInput.addEventListener("input", renderChannels);
if (groupSelect) groupSelect.addEventListener("change", renderChannels);

// Run Engine
loadChannels();
