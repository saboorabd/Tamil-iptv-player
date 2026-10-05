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
let currentIndex = -1;
let retryTimer = null;
let latencyTimer = null;

const FAVORITES_KEY = "tamil_iptv_favorites";
const RECENT_KEY = "tamil_iptv_recent";

const favorites = new Set(
  JSON.parse(localStorage.getItem(FAVORITES_KEY) || "[]")
);

const recent = JSON.parse(
  localStorage.getItem(RECENT_KEY) || "[]"
);

function setStatus(text) {
  if (statusEl) statusEl.textContent = text;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[char]));
}

/* -----------------------------
   M3U PARSER
----------------------------- */

function parseM3U(text) {
  const lines = text.split(/\r?\n/);
  const result = [];

  let info = null;

  for (const raw of lines) {
    const line = raw.trim();

    if (!line) continue;

    if (line.startsWith("#EXTINF:")) {
      const comma = line.indexOf(",");

      const attrs =
        comma >= 0 ? line.slice(0, comma) : line;

      const name =
        comma >= 0
          ? line.slice(comma + 1).trim()
          : "Unknown Channel";

      const getAttribute = key => {
        const regex = new RegExp(
          `${key}="([^"]*)"`
        );

        const match = attrs.match(regex);

        return match ? match[1] : "";
      };

      info = {
        name,
        id: getAttribute("tvg-id"),
        logo: getAttribute("tvg-logo"),
        group:
          getAttribute("group-title") ||
          "Other"
      };

    } else if (!line.startsWith("#") && info) {

      result.push({
        ...info,
        url: line
      });

      info = null;
    }
  }

  return result;
}

/* -----------------------------
   GROUPS
----------------------------- */

function renderGroups() {

  const groups = [
    ...new Set(
      channels.map(channel => channel.group)
    )
  ].sort();

  groupEl.innerHTML =
    `<option value="all">All Channels</option>` +
    groups.map(group => `
      <option value="${escapeHtml(group)}">
        ${escapeHtml(group)}
      </option>
    `).join("");
}

/* -----------------------------
   CHANNEL LIST
----------------------------- */

function renderChannels() {

  const query =
    searchEl.value.toLowerCase().trim();

  const group = groupEl.value;

  const filtered = channels.filter(channel => {

    const matchesSearch =
      channel.name
        .toLowerCase()
        .includes(query);

    const matchesGroup =
      group === "all" ||
      channel.group === group;

    return matchesSearch && matchesGroup;
  });

  if (!filtered.length) {

    channelsEl.innerHTML = `
      <div style="
        padding:30px;
        text-align:center;
        color:#8993a8;
      ">
        No channels found
      </div>
    `;

    return;
  }

  channelsEl.innerHTML =
    filtered.map(channel => {

      const index =
        channels.indexOf(channel);

      const isFavorite =
        favorites.has(channelKey(channel));

      return `
        <div
          class="channel"
          data-index="${index}"
          style="cursor:pointer;"
        >

          ${
            channel.logo
              ? `
                <img
                  src="${escapeHtml(channel.logo)}"
                  loading="lazy"
                  onerror="this.style.display='none'"
                >
              `
              : ""
          }

          <span style="flex:1">

            <span class="channel-name">
              ${escapeHtml(channel.name)}
            </span>

            <br>

            <span class="channel-group">
              ${escapeHtml(channel.group)}
            </span>

          </span>

          <button
            class="favorite-btn"
            data-favorite="${index}"
            title="Favorite"
          >
            ${isFavorite ? "★" : "☆"}
          </button>

        </div>
      `;
    }).join("");

  channelsEl
    .querySelectorAll(".channel")
    .forEach(element => {

      element.addEventListener("click", event => {

        if (
          event.target.closest(
            ".favorite-btn"
          )
        ) {
          return;
        }

        const index =
          Number(
            element.dataset.index
          );

        playChannel(channels[index]);
      });
    });

  channelsEl
    .querySelectorAll(".favorite-btn")
    .forEach(button => {

      button.addEventListener(
        "click",
        event => {

          event.stopPropagation();

          const index =
            Number(
              button.dataset.favorite
            );

          toggleFavorite(
            channels[index]
          );
        }
      );
    });
}

/* -----------------------------
   FAVORITES
----------------------------- */

function channelKey(channel) {

  return (
    channel.id ||
    channel.url ||
    channel.name
  );
}

function saveFavorites() {

  localStorage.setItem(
    FAVORITES_KEY,
    JSON.stringify(
      [...favorites]
    )
  );
}

function toggleFavorite(channel) {

  const key =
    channelKey(channel);

  if (favorites.has(key)) {

    favorites.delete(key);

  } else {

    favorites.add(key);
  }

  saveFavorites();
  renderChannels();
}

/* -----------------------------
   RECENT
----------------------------- */

function addRecent(channel) {

  const key =
    channelKey(channel);

  const filtered =
    recent.filter(
      item => item !== key
    );

  filtered.unshift(key);

  filtered.splice(10);

  localStorage.setItem(
    RECENT_KEY,
    JSON.stringify(filtered)
  );
}

/* -----------------------------
   DESTROY PLAYER
----------------------------- */

function destroyPlayer() {

  if (retryTimer) {

    clearTimeout(retryTimer);
    retryTimer = null;
  }

  if (hls) {

    hls.destroy();
    hls = null;
  }

  video.pause();

  video.removeAttribute("src");

  video.load();
}

/* -----------------------------
   PLAY CHANNEL
----------------------------- */

function playChannel(channel) {

  if (!channel || !channel.url) {
    return;
  }

  current = channel;

  currentIndex =
    channels.indexOf(channel);

  addRecent(channel);

  destroyPlayer();

  setStatus(
    `Loading ${channel.name}...`
  );

  latencyEl.textContent =
    "Latency: --";

  qualityStatusEl.textContent =
    "Quality: --";

  /*
   * HLS.JS
   */

  if (window.Hls && Hls.isSupported()) {

    hls = new Hls({

      enableWorker: true,

      /*
       * Enables LL-HLS behaviour
       * when the source provides LL-HLS.
       */
      lowLatencyMode: true,

      /*
       * Keep playback close to live.
       * Never intentionally use 2x.
       */
      liveSyncDurationCount: 2,

      liveMaxLatencyDurationCount: 5,

      maxLiveSyncPlaybackRate: 1.02,

      /*
       * Buffer management.
       */
      backBufferLength: 30,

      maxBufferLength: 8,

      maxMaxBufferLength: 16,

      highBufferWatchdogPeriod: 2,

      /*
       * ABR.
       * -1 = automatic quality selection.
       */
      startLevel: -1,

      abrEwmaFastLive: 3,

      abrEwmaSlowLive: 9,

      abrEwmaDefaultEstimate: 3000000,

      /*
       * Retry settings.
       */
      manifestLoadingMaxRetry: 3,

      levelLoadingMaxRetry: 3,

      fragLoadingMaxRetry: 3,

      manifestLoadingRetryDelay: 1000,

      levelLoadingRetryDelay: 1000,

      fragLoadingRetryDelay: 1000
    });

    hls.attachMedia(video);

    hls.on(
      Hls.Events.MEDIA_ATTACHED,
      () => {

        hls.loadSource(
          channel.url
        );
      }
    );

    hls.on(
      Hls.Events.MANIFEST_PARSED,
      () => {

        populateQuality();

        setStatus(
          `LIVE • ${channel.name}`
        );

        video.play()
          .catch(() => {

            setStatus(
              "Press Play to start"
            );
          });
      }
    );

    hls.on(
      Hls.Events.LEVEL_SWITCHED,
      (_event, data) => {

        const level =
          hls.levels[data.level];

        if (!level) return;

        const resolution =
          level.height
            ? `${level.height}p`
            : "Auto";

        const bitrate =
          level.bitrate
            ? ` • ${Math.round(
                level.bitrate / 1000
              )} kbps`
            : "";

        qualityStatusEl.textContent =
          `Quality: ${resolution}${bitrate}`;
      }
    );

    hls.on(
      Hls.Events.ERROR,
      (_event, data) => {

        if (!data.fatal) {
          return;
        }

        /*
         * Network recovery.
         */
        if (
          data.type ===
          Hls.ErrorTypes.NETWORK_ERROR
        ) {

          setStatus(
            "Network issue • reconnecting..."
          );

          scheduleRecovery();

        /*
         * Media recovery.
         */
        } else if (
          data.type ===
          Hls.ErrorTypes.MEDIA_ERROR
        ) {

          setStatus(
            "Recovering media..."
          );

          hls.recoverMediaError();

        } else {

          setStatus(
            "Stream unavailable"
          );

          destroyPlayer();
        }
      }
    );

  /*
   * Safari / native HLS.
   */

  } else if (
    video.canPlayType(
      "application/vnd.apple.mpegurl"
    )
  ) {

    video.src = channel.url;

    video.addEventListener(
      "loadedmetadata",
      () => {

        setStatus(
          `LIVE • ${channel.name}`
        );

        video.play().catch(() => {});
      },
      { once: true }
    );

  } else {

    setStatus(
      "This browser does not support HLS"
    );
  }

  renderChannels();
}

/* -----------------------------
   RECOVERY
----------------------------- */

function scheduleRecovery() {

  if (retryTimer) {
    return;
  }

  retryTimer = setTimeout(() => {

    retryTimer = null;

    if (!hls || !current) {
      return;
    }

    try {

      hls.stopLoad();
      hls.startLoad(-1);

    } catch (error) {

      console.error(
        "Recovery failed:",
        error
      );
    }

  }, 1500);
}

/* -----------------------------
   QUALITY
----------------------------- */

function populateQuality() {

  if (!qualityEl) return;

  qualityEl.innerHTML =
    `<option value="-1">
      Auto
    </option>`;

  if (!hls) return;

  hls.levels.forEach(
    (level, index) => {

      const option =
        document.createElement(
          "option"
        );

      option.value = index;

      const height =
        level.height ||
        "?";

      const bitrate =
        level.bitrate
          ? ` • ${Math.round(
              level.bitrate / 1000
            )} kbps`
          : "";

      option.textContent =
        `${height}p${bitrate}`;

      qualityEl.appendChild(
        option
      );
    }
  );
}

qualityEl.addEventListener(
  "change",
  () => {

    if (!hls) {
      return;
    }

    const level =
      Number(
        qualityEl.value
      );

    /*
     * -1 = automatic ABR
     */
    hls.currentLevel = level;
  }
);

/* -----------------------------
   LIVE EDGE
----------------------------- */

function goLive() {

  if (!hls) {
    return;
  }

  if (
    Number.isFinite(
      hls.liveSyncPosition
    )
  ) {

    video.currentTime =
      hls.liveSyncPosition;

    video.play().catch(() => {});

    setStatus(
      `LIVE • ${current?.name || ""}`
    );
  }
}

liveBtn.addEventListener(
  "click",
  goLive
);

/* -----------------------------
   EDGE MODE
----------------------------- */

edgeEl.addEventListener(
  "change",
  () => {

    if (!hls) {
      return;
    }

    if (
      edgeEl.value === "near"
    ) {

      goLive();
    }
  }
);

/* -----------------------------
   LATENCY MONITOR
----------------------------- */

function updateLatency() {

  if (
    !hls ||
    !Number.isFinite(
      hls.liveSyncPosition
    ) ||
    !Number.isFinite(
      video.currentTime
    )
  ) {

    return;
  }

  const delay =
    hls.liveSyncPosition -
    video.currentTime;

  const seconds =
    Math.max(
      0,
      delay
    );

  latencyEl.textContent =
    `Latency: ${seconds.toFixed(1)}s`;
}

latencyTimer =
  setInterval(
    updateLatency,
    1000
  );

/* -----------------------------
   SEARCH
----------------------------- */

searchEl.addEventListener(
  "input",
  renderChannels
);

groupEl.addEventListener(
  "change",
  renderChannels
);

/* -----------------------------
   RELOAD PLAYLIST
----------------------------- */

reloadBtn.addEventListener(
  "click",
  loadPlaylist
);

/* -----------------------------
   KEYBOARD CONTROLS
----------------------------- */

document.addEventListener(
  "keydown",
  event => {

    if (
      event.target.tagName ===
      "INPUT"
    ) {
      return;
    }

    /*
     * Space = play / pause
     */
    if (
      event.code ===
      "Space"
    ) {

      event.preventDefault();

      if (video.paused) {
        video.play().catch(() => {});
      } else {
        video.pause();
      }
    }

    /*
     * L = go live
     */
    if (
      event.key.toLowerCase() ===
      "l"
    ) {

      goLive();
    }

    /*
     * F = fullscreen
     */
    if (
      event.key.toLowerCase() ===
      "f"
    ) {

      toggleFullscreen();
    }

    /*
     * Arrow Up / Down
     */
    if (
      event.key ===
      "ArrowUp"
    ) {

      if (
        currentIndex <
        channels.length - 1
      ) {

        playChannel(
          channels[
            currentIndex + 1
          ]
        );
      }
    }

    if (
      event.key ===
      "ArrowDown"
    ) {

      if (
        currentIndex > 0
      ) {

        playChannel(
          channels[
            currentIndex - 1
          ]
        );
      }
    }
  }
);

/* -----------------------------
   FULLSCREEN
----------------------------- */

function toggleFullscreen() {

  const player =
    video.parentElement;

  if (
    !document.fullscreenElement
  ) {

    player
      .requestFullscreen?.();

  } else {

    document.exitFullscreen?.();
  }
}

/* -----------------------------
   PICTURE IN PICTURE
----------------------------- */

video.addEventListener(
  "dblclick",
  async () => {

    try {

      if (
        document.pictureInPictureElement
      ) {

        await document.exitPictureInPicture();

      } else if (
        document.pictureInPictureEnabled
      ) {

        await video.requestPictureInPicture();
      }

    } catch (error) {

      console.log(
        "PiP unavailable:",
        error
      );
    }
  }
);

/* -----------------------------
   PLAYLIST LOADER
----------------------------- */

async function loadPlaylist() {

  setStatus(
    "Loading channels..."
  );

  try {

    const response =
      await fetch(
        "/tamil channe.m3u",
        {
          cache: "no-store"
        }
      );

    if (!response.ok) {

      throw new Error(
        "Playlist not found"
      );
    }

    const text =
      await response.text();

    channels =
      parseM3U(text);

    renderGroups();
    renderChannels();

    if (channels.length) {

      setStatus(
        `${channels.length} channels ready`
      );

    } else {

      setStatus(
        "Playlist is empty"
      );
    }

  } catch (error) {

    console.error(
      "Playlist error:",
      error
    );

    setStatus(
      "Could not load playlist"
    );
  }
}

/* -----------------------------
   VIDEO EVENTS
----------------------------- */

video.addEventListener(
  "waiting",
  () => {

    if (current) {

      setStatus(
        `Buffering • ${current.name}`
      );
    }
  }
);

video.addEventListener(
  "playing",
  () => {

    if (current) {

      setStatus(
        `LIVE • ${current.name}`
      );
    }
  }
);

video.addEventListener(
  "stalled",
  () => {

    if (current) {

      setStatus(
        "Stream stalled • recovering..."
      );
    }
  }
);

/* -----------------------------
   START
----------------------------- */

loadPlaylist();
