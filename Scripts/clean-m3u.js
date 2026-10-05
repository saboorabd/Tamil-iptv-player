// Simple M3U cleaner: removes exact duplicate URL entries.
// Usage: node scripts/clean-m3u.js input.m3u output.m3u
const fs = require("fs");

const [, , input, output] = process.argv;
if (!input || !output) {
  console.error("Usage: node scripts/clean-m3u.js input.m3u output.m3u");
  process.exit(1);
}

const lines = fs.readFileSync(input, "utf8").split(/\r?\n/);
const seen = new Set();
const out = [];
let pendingInfo = null;

for (const line of lines) {
  if (line.startsWith("#EXTINF:")) {
    pendingInfo = line;
  } else if (line.trim() && !line.startsWith("#")) {
    if (!seen.has(line.trim())) {
      if (pendingInfo) out.push(pendingInfo);
      out.push(line.trim());
      seen.add(line.trim());
    }
    pendingInfo = null;
  } else if (line.startsWith("#EXTM3U")) {
    out.push(line);
  }
}

fs.writeFileSync(output, out.join("\n") + "\n");
console.log(`Wrote ${seen.size} unique streams to ${output}`);