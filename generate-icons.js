#!/usr/bin/env node
// Generate extension icons - W on WhatsApp green rounded square
// Run: node generate-icons.js
// No dependencies needed.

'use strict';
const fs = require('fs');
const zlib = require('zlib');

// ── PNG encoder (minimal, zero dependencies) ──

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)) >>> 0;
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

function toPNG(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0; // filter: None
    rgba.copy(raw, y * (1 + w * 4) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Drawing helpers ──

function blend(buf, S, x, y, r, g, b, a) {
  x = Math.floor(x); y = Math.floor(y);
  if (x < 0 || x >= S || y < 0 || y >= S) return;
  const i = (y * S + x) * 4;
  if (a >= 255) { buf[i] = r; buf[i+1] = g; buf[i+2] = b; buf[i+3] = 255; return; }
  if (a <= 0) return;
  const sa = a / 255, da = buf[i+3] / 255, oa = sa + da * (1 - sa);
  if (oa > 0) {
    buf[i]   = Math.round((r * sa + buf[i]   * da * (1-sa)) / oa);
    buf[i+1] = Math.round((g * sa + buf[i+1] * da * (1-sa)) / oa);
    buf[i+2] = Math.round((b * sa + buf[i+2] * da * (1-sa)) / oa);
    buf[i+3] = Math.round(oa * 255);
  }
}

// Signed distance to rounded rect (negative = inside)
function rrSDF(px, py, w, h, r) {
  const qx = Math.abs(px - w / 2) - w / 2 + r;
  const qy = Math.abs(py - h / 2) - h / 2 + r;
  return Math.min(Math.max(qx, qy), 0) + Math.sqrt(Math.max(qx, 0) ** 2 + Math.max(qy, 0) ** 2) - r;
}

// Distance from point to line segment
function distSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// ── Icon generator ──

function generateIcon(S) {
  const buf = Buffer.alloc(S * S * 4);

  // Colors
  const bgR = 0x25, bgG = 0xD3, bgB = 0x66; // #25D366 WhatsApp green
  const cornerR = S * 0.22;

  // 1) Draw rounded rect background
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const d = rrSDF(x + 0.5, y + 0.5, S, S, cornerR);
      if (d < -0.7) blend(buf, S, x, y, bgR, bgG, bgB, 255);
      else if (d < 0.7) blend(buf, S, x, y, bgR, bgG, bgB, Math.round((0.7 - d) / 1.4 * 255));
    }
  }

  // Add subtle inner shadow at top for depth
  for (let y = 0; y < S * 0.35; y++) {
    for (let x = 0; x < S; x++) {
      const d = rrSDF(x + 0.5, y + 0.5, S, S, cornerR);
      if (d < 0) {
        const strength = Math.max(0, 1 - y / (S * 0.35)) * 0.12;
        blend(buf, S, x, y, 255, 255, 255, Math.round(strength * 255));
      }
    }
  }

  // 2) Draw "W" as 4 thick anti-aliased line segments
  //
  //  T1          T2          T3
  //   \         / \         /
  //    \       /   \       /
  //     \     /     \     /
  //      \   /       \   /
  //       \ /         \ /
  //       B1           B2

  const T1x = S * 0.14, T1y = S * 0.24;
  const B1x = S * 0.33, B1y = S * 0.78;
  const T2x = S * 0.50, T2y = S * 0.40;
  const B2x = S * 0.67, B2y = S * 0.78;
  const T3x = S * 0.86, T3y = S * 0.24;

  const lines = [
    [T1x, T1y, B1x, B1y],
    [B1x, B1y, T2x, T2y],
    [T2x, T2y, B2x, B2y],
    [B2x, B2y, T3x, T3y],
  ];

  // Thickness scales with size (thicker for small icons for legibility)
  const thickness = S <= 16 ? S * 0.16 : S <= 48 ? S * 0.10 : S * 0.085;
  const halfT = thickness / 2;

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      // Skip transparent pixels
      if (buf[(y * S + x) * 4 + 3] === 0) continue;

      let minD = Infinity;
      for (const [ax, ay, bx, by] of lines) {
        minD = Math.min(minD, distSeg(x + 0.5, y + 0.5, ax, ay, bx, by));
      }

      if (minD < halfT - 0.7) {
        blend(buf, S, x, y, 255, 255, 255, 255);
      } else if (minD < halfT + 0.7) {
        const a = Math.round((halfT + 0.7 - minD) / 1.4 * 255);
        blend(buf, S, x, y, 255, 255, 255, a);
      }
    }
  }

  // 3) Add subtle shadow under the W strokes for depth
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (buf[(y * S + x) * 4 + 3] === 0) continue;
      let minD = Infinity;
      for (const [ax, ay, bx, by] of lines) {
        minD = Math.min(minD, distSeg(x + 0.5, y + 1.5, ax, ay, bx, by)); // offset down by 1px
      }
      if (minD < halfT + 1.5 && minD >= halfT - 0.7) {
        const idx = (y * S + x) * 4;
        // Only add shadow on green pixels (not on white W)
        if (buf[idx] < 100) { // it's green-ish
          const a = Math.round(Math.max(0, (halfT + 1.5 - minD) / 2.2) * 40);
          blend(buf, S, x, y, 0, 0, 0, a);
        }
      }
    }
  }

  return toPNG(S, S, buf);
}

// ── Generate all sizes ──
const dir = __dirname + '/extension';
for (const size of [16, 48, 128]) {
  const png = generateIcon(size);
  const path = dir + '/icon' + size + '.png';
  fs.writeFileSync(path, png);
  console.log('Generated', path, '(' + png.length + ' bytes)');
}
console.log('Done!');
