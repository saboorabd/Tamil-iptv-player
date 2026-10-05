const express = require("express");
const path = require("path");
const cors = require("cors"); // CORS இணைக்கப்பட்டுள்ளது

const app = express();
const PORT = process.env.PORT || 10000;

// அனைத்து டொமைன்களுக்கும் முழு CORS அனுமதி
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// IPTV .m3u8 ஸ்ட்ரீம்களுக்கான CORS Proxy (இதுதான் முக்கியம்!)
app.get("/proxy", async (req, res) => {
  const streamUrl = req.query.url;
  if (!streamUrl) {
    return res.status(400).json({ error: "Missing 'url' query parameter" });
  }

  try {
    const response = await fetch(streamUrl);
    
    // ஒரிஜினல் வீடியோ சர்வரில் இருந்து வரும் ஹெடர்களை பாஸ் செய்யவும்
    res.setHeader("Content-Type", response.headers.get("content-type") || "application/x-mpegURL");
    res.setHeader("Access-Control-Allow-Origin", "*");

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
