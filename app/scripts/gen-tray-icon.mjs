/**
 * Draws the menu bar icon.
 *
 * macOS menu bar icons must be *template* images: pure black with an alpha
 * channel, so the system can invert them for dark mode, menu highlight and
 * reduced-transparency settings. A colour icon looks broken up there.
 *
 * Generated rather than committed as an opaque blob, so the shape can be
 * adjusted by editing numbers instead of opening a graphics editor.
 *
 *   node app/scripts/gen-tray-icon.mjs
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const SIZE = 44; // 22pt at @2x
const OUT = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "src-tauri", "icons", "tray-template.png");

/** Signed distance to a rounded rectangle; negative inside. */
function roundedRectSDF(px, py, cx, cy, halfW, halfH, radius) {
  const dx = Math.abs(px - cx) - (halfW - radius);
  const dy = Math.abs(py - cy) - (halfH - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  const inside = Math.min(Math.max(dx, dy), 0);
  return outside + inside - radius;
}

/** 1 inside the shape, 0 outside, antialiased across roughly one pixel. */
function coverage(distance) {
  return Math.min(1, Math.max(0, 0.5 - distance));
}

function drawGlyph() {
  // A browser window: rounded outline with a filled title bar.
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const halfW = 17;
  const halfH = 14;
  const radius = 4.5;
  const stroke = 3.4;
  const barBottom = cy - halfH + 9.5;

  const pixels = new Uint8Array(SIZE * SIZE * 4);

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const d = roundedRectSDF(px, py, cx, cy, halfW, halfH, radius);

      // The outline itself.
      const ring = coverage(Math.abs(d) - stroke / 2);
      // The filled title bar: inside the shape, above the bar line.
      const bar = Math.min(coverage(d), coverage(py - barBottom));

      const alpha = Math.min(1, Math.max(ring, bar));
      const i = (y * SIZE + x) * 4;
      pixels[i] = 0;
      pixels[i + 1] = 0;
      pixels[i + 2] = 0;
      pixels[i + 3] = Math.round(alpha * 255);
    }
  }
  return pixels;
}

// ---------------------------------------------------------------- PNG writing

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

function encodePng(pixels, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  // 10-12: compression, filter, interlace — all zero.

  // Each scanline is prefixed with its filter type (0 = none).
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;
    Buffer.from(pixels.buffer, y * size * 4, size * 4).copy(raw, rowStart + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, encodePng(drawGlyph(), SIZE));
console.log(`wrote ${path.relative(process.cwd(), OUT)} (${SIZE}x${SIZE} template)`);
