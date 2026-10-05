const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.static(path.join(__dirname, "public"), {
  extensions: ["html"]
}));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "tamil-iptv-player" });
});

app.listen(PORT, () => {
  console.log(`IPTV player running on port ${PORT}`);
});