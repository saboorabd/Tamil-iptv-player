'use strict';
/* Looks at the first bytes of a stream and says what it really is, no matter what the URL or Content-Type claims.
   Shared by server.js (/api/sniff) and pulse.js (health probe). */

// MPEG-TS = 188-byte packets that each start with 0x47. The stream may start a few bytes into a packet.
function isTs(buf) {
  const lim = Math.min(188, buf.length - 1);
  for (let i = 0; i < lim; i++) {
    if (buf[i] !== 0x47) continue;
    if (buf.length < i + 189) return true;                               // too short to check further
    if (buf[i + 188] === 0x47 && (buf.length < i + 377 || buf[i + 376] === 0x47)) return true;
  }
  return false;
}

function sniffKind(buf) {
  if (!buf || !buf.length) return 'empty';
  const text = buf.slice(0, 4096).toString('utf8').replace(/^﻿/, '').trimStart();
  if (text.startsWith('#EXTM3U')) return 'hls';
  if (/<MPD[\s>]/.test(text)) return 'dash';
  if (/^(<!doctype|<html|<head|<body|<\?xml|\{)/i.test(text)) return 'html';        // login page, block page, JSON error ...
  if (buf[0] === 0x46 && buf[1] === 0x4c && buf[2] === 0x56) return 'flv';           // "FLV"
  if (buf.length > 8 && buf.slice(4, 8).toString('latin1') === 'ftyp') return 'mp4';
  if (buf.length > 4 && buf.slice(0, 4).toString('latin1') === 'OggS') return 'audio';
  if (isTs(buf)) return 'ts';
  if (buf.slice(0, 3).toString('latin1') === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return 'audio';   // mp3 / aac
  return 'unknown';
}

module.exports = { sniffKind, isTs };
