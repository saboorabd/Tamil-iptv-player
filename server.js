const express = require("express");
const path = require("path");
const fs = require("fs");
const cors = require("cors");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 10000;

// 1. பிரௌசரின் CORS தடையை முழுமையாக நீக்குகிறது
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['*']
}));

app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, "public")));

// 2. Universal IPTV CORS & Header Injector Proxy Route
app.get("/proxy", async (req, res) => {
  const streamUrl = req.query.url;
  if (!streamUrl) {
    return res.status(400).json({ error: "Missing 'url' parameter" });
  }

  // ஒரிஜினல் ஆப் போல நடிக்கத் தேவையான Fake Headers
  const customUserAgent = req.query.ua || req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const customCookie = req.query.cookie || '';
  const customReferer = req.query.referer || '';

  try {
    const response = await axios({
      method: 'get',
      url: streamUrl,
      responseType: 'stream',
      headers: {
        'User-Agent': customUserAgent,
        'Cookie': customCookie,
        'Referer': customReferer,
        'Origin': customReferer ? new URL(customReferer).origin : ''
      },
      timeout: 15000
    });

    // பிரௌசருக்கு CORS அனுமதி வழங்குதல்
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    if (response.headers['content-type']) {
      res.setHeader("Content-Type", response.headers['content-type']);
    }

    response.data.pipe(res);

  } catch (error) {
    console.error("Proxy Error:", error.message);
    res.status(500).json({ error: "Bypass failed", details: error.message });
  }
});

app.get("/", (_req, res) => {
  const rootIndex = path.join(__dirname, "index.html");
  if (fs.existsSync(rootIndex)) {
    return res.sendFile(rootIndex);
  }
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
