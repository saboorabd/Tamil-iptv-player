/* ===== Auto-live, Rotate, Fit/Crop/Stretch ===== */

// ---------- Auto-live ----------
let lastJump = 0;

function getLag() {
  if (hls && typeof hls.latency === 'number' && hls.latency > 0) return hls.latency;
  if (sk) { try { const e = sk.seekRange().end; if (e) return e - video.currentTime; } catch {} }
  return null;
}

$('autoLiveSelect').value = String(store.get('autoLive', 10));
$('autoLiveSelect').onchange = e => store.set('autoLive', +e.target.value);

setInterval(() => {
  const limit = +$('autoLiveSelect').value;           // 0 = off
  if (!limit || !cur || video.paused || video.seeking) return;
  if (Date.now() - lastJump < 8000) return;           // cooldown: jump loop avoid
  const lag = getLag();
  if (lag != null && lag > limit) {
    lastJump = Date.now();
    $('liveBtn').click();                             // existing "Go live" logic
  }
}, 1000);

// ---------- Rotate + Fit/Crop/Stretch ----------
const wrap = video.parentElement;
const FIT = ['contain', 'cover', 'fill'];
const FIT_LABEL = { contain: 'Fit', cover: 'Crop', fill: 'Stretch' };
let rot = 0, fitIdx = 0;

function layoutVideo() {
  const w = wrap.clientWidth, h = wrap.clientHeight;
  const swapped = rot % 180 !== 0;
  Object.assign(video.style, {
    position: 'absolute',
    left: '50%',
    top: '50%',
    width: (swapped ? h : w) + 'px',
    height: (swapped ? w : h) + 'px',
    transform: `translate(-50%, -50%) rotate(${rot}deg)`,
    objectFit: FIT[fitIdx]
  });
}

new ResizeObserver(layoutVideo).observe(wrap);
layoutVideo();

$('rotateBtn').onclick = () => { rot = (rot + 90) % 360; layoutVideo(); };
$('fitBtn').onclick = () => {
  fitIdx = (fitIdx + 1) % FIT.length;
  $('fitBtn').textContent = FIT_LABEL[FIT[fitIdx]];
  layoutVideo();
};
