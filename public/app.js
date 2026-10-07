// DASH / DRM ஸ்ட்ரீம்களை பிளே செய்யும் பங்க்ஷன்
async function playDashStream(streamUrl, drmKeys) {
  // 1. CORS தடையைத் தவிர்க்க Proxy வழியாக லின்க்கை அனுப்புவது
  const proxiedUrl = "/proxy?url=" + encodeURIComponent(streamUrl);

  shaka.polyfill.installAll();
  const player = new shaka.Player(document.getElementById("videoPlayer"));

  // 2. ClearKey DRM பூட்டை உடைக்கும் அமைப்பு
  if (drmKeys && drmKeys.kid && drmKeys.key) {
    const clearKeys = {};
    clearKeys[drmKeys.kid] = drmKeys.key;
    
    player.configure({
      drm: {
        clearKeys: clearKeys
      }
    });
  }

  try {
    await player.load(proxiedUrl);
    document.getElementById("videoPlayer").play();
    console.log("DRM Stream successfully bypassed and playing!");
  } catch (error) {
    console.error("DRM Playback Error:", error);
  }
}
