const express = require("express");
const path = require("path");
const fs = require("fs");
const cors = require("cors");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 10000;

// All CORS Origins Allowed
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['*']
}));

// Serve Static Files from both 'public' directory and root
app.use(express.static(path.join(__dirname, "public")));
app.use(express.static(__dirname));

// IPTV CORS & Header Injector Proxy Route
app.get("/proxy", async (req, res) => {
  const streamUrl = req.query.url;
  if (!streamUrl) {
    return res.status(400).json({ error: "Missing 'url' query parameter" });
  }

  const customUserAgent = req.query.ua || req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
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
      timeout: 12000
    });

    res.setHeader("Access-Control-Allow-Origin", "*");
    if (response.headers['content-type']) {
      res.setHeader("Content-Type", response.headers['content-type']);
    }

    response.data.pipe(res);

  } catch (error) {
    console.error("Proxy Fetch Error:", error.message);
    res.status(500).json({ error: "Failed to fetch video stream", details: error.message });
  }
});

// Fallback Route for HTML serving
app.get("/", (_req, res) => {
  const publicIndexPath = path.join(__dirname, "public", "index.html");
  const rootIndexPath = path.join(__dirname, "index.html");

  if (fs.existsSync(publicIndexPath)) {
    return res.sendFile(publicIndexPath);
  } else if (fs.existsSync(rootIndexPath)) {
    return res.sendFile(rootIndexPath);
  } else {
    return res.status(404).send("index.html not found in root or public folder");
  }
});

// Health Check API for Render
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "tamil-iptv-player" });
});

app.listen(PORT, () => {
  console.log(`IPTV server running on port ${PORT}`);
});
