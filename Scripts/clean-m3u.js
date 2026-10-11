// M3U cleaner: removes duplicate channels and keeps everything a channel needs to play.
// Usage: node Scripts/clean-m3u.js input.m3u output.m3u
//
// What it does
//  - keeps the #EXTM3U header exactly as it is (so url-tvg / x-tvg-url, the EPG link, survives)
//  - keeps every option line that belongs to a channel: #EXTVLCOPT, #EXTHTTP, #KODIPROP (DRM keys, Referer,
//    User-Agent, cookies). The old version deleted them, which made those channels stop playing.
//  - removes a channel only when BOTH its URL and its name are the same as an earlier one. The same URL under a
//    different name is kept, because server.js treats that as a separate channel too.
//  - drops entries that have no URL, and strips a UTF-8 BOM
const fs = require("fs");

const [, , input, output] = process.argv;
if (!input || !output) {
  console.error("Usage: node Scripts/clean-m3u.js input.m3u output.m3u");
  process.exit(1);
}

const lines = fs.readFileSync(input, "utf8").replace(/^﻿/, "").split(/\r?\n/);
const nameOf = info => info.slice(info.lastIndexOf('"') + 1).replace(/^[^,]*,/, "").trim().toLowerCase();

let header = "#EXTM3U";
const out = [];
const seen = new Set();
let block = [];          // #EXTINF + its option lines, waiting for the URL
let dropped = 0;

for (const raw of lines) {
  const line = raw.trim();
  if (!line) continue;
  if (line.startsWith("#EXTM3U")) { header = line; continue; }
  if (line.startsWith("#EXTINF")) { block = [line]; continue; }
  if (line.startsWith("#")) { if (block.length) block.push(line); continue; }     // option line of the current channel

  // a URL line
  if (!block.length) { dropped++; continue; }                                      // URL without #EXTINF: nothing to show
  const key = line + "\n" + nameOf(block[0]);
  if (seen.has(key)) dropped++;
  else { seen.add(key); out.push(...block, line); }
  block = [];
}

fs.writeFileSync(output, header + "\n" + out.join("\n") + "\n");
console.log(`Wrote ${seen.size} channels to ${output} (${dropped} duplicate/invalid entries removed)`);
