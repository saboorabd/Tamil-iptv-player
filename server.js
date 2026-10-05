const express = require("express");
const path = require("path");
const cors = require("cors"); // 1. CORS பேக்கேஜை இம்போர்ட் செய்யவும்

const app = express();
const PORT = process.env.PORT || 10000;

// 2. அனைத்து டொமைன்களுக்கும் முழு CORS அனுமதி வழங்கவும்
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// 3. IPTV .m3u8 ஸ்ட்ரீம்களுக்கான CORS Proxy (இதன் மூலம் எல்லா வீடியோவும் பிளே ஆகும்)
app.get("/proxy", async (req, res) => {
  const streamUrl = req.query.url;
  if (!streamUrl) {
    return res.status(400).json({ error: "Missing 'url' query parameter" });
  }

  try {
    const response = await fetch(streamUrl);
    
    // ஒரிஜினல் வீடியோ சர்வரில் இருந்து வரும் ஹெடர்களை அப்படியே பாஸ் செய்யவும்
    res.setHeader("Content-Type", response.headers.get("content-type") || "application/x-mpegURL");
    res.setHeader("Access-Control-Allow-Origin", "*");

    // வீடியோ டேட்டாவை ஸ்ட்ரீம் செய்யவும்
    const body = response.body;
    if (body) {
      const reader = body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    }
    res.end();
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch video stream", details: error.message });
  }
});

// Static ஃபைல்களை சேர்வ் செய்ய
app.use(express.static(path.join(__dirname, "public"), {
  extensions: ["html"]
}));

// Health Check
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "tamil-iptv-player" });
});

app.listen(PORT, () => {
  console.log(`IPTV player running on port ${PORT}`);
});
