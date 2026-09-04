/*
 * Generates the toolbar icons. Run: node test/make-icons.js
 * Kept in the repo so the icons are reproducible without any image tooling;
 * the extension itself never runs this.
 */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      raw[o++] = r; raw[o++] = g; raw[o++] = b; raw[o++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Indigo rounded square with a white text I-beam. 4x supersampled so the
// corners and the thin stem stay clean at 16px.
const BG = [79, 70, 229];
const FG = [255, 255, 255];

function coverage(size, x, y, inside) {
  const S = 4;
  let hits = 0;
  for (let sy = 0; sy < S; sy++) {
    for (let sx = 0; sx < S; sx++) {
      if (inside(x + (sx + 0.5) / S, y + (sy + 0.5) / S)) hits++;
    }
  }
  return hits / (S * S);
}

function render(size) {
  const r = size * 0.22;
  const inRounded = (px, py) => {
    const cx = Math.min(Math.max(px, r), size - r);
    const cy = Math.min(Math.max(py, r), size - r);
    const dx = px - cx, dy = py - cy;
    return dx * dx + dy * dy <= r * r;
  };

  const t = Math.max(1, Math.round(size * 0.085));
  const top = size * 0.27, bot = size * 0.73;
  const cx = size / 2;
  const serif = size * 0.15;
  const inBeam = (px, py) => {
    if (py < top || py > bot) return false;
    if (Math.abs(px - cx) <= t / 2) return true;
    if (Math.abs(px - cx) <= serif && (py <= top + t || py >= bot - t)) return true;
    return false;
  };

  return (x, y) => {
    const bg = coverage(size, x, y, inRounded);
    if (bg === 0) return [0, 0, 0, 0];
    const fg = coverage(size, x, y, inBeam) * bg;
    const mix = (i) => Math.round(BG[i] * (1 - fg / Math.max(bg, 1e-6)) + FG[i] * (fg / Math.max(bg, 1e-6)));
    return [mix(0), mix(1), mix(2), Math.round(bg * 255)];
  };
}

const dir = path.join(__dirname, '..', 'icons');
for (const size of [16, 32, 48, 128]) {
  fs.writeFileSync(path.join(dir, `icon${size}.png`), png(size, render(size)));
}
console.log('icons written to', dir);
