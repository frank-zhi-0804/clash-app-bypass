// Dependency-free application icon generator. Run before a desktop build.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
const size = 64;
const rgba = Buffer.alloc(size * size * 4);
for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
  const cornerX = Math.max(10 - x, x - 53, 0), cornerY = Math.max(10 - y, y - 53, 0);
  const inside = cornerX * cornerX + cornerY * cornerY <= 100;
  const arrow = ((Math.abs(x + y - 63) < 4 && x >= 20 && x <= 46 && y >= 18 && y <= 45) || (x >= 29 && x <= 46 && y >= 17 && y <= 22) || (x >= 42 && x <= 47 && y >= 18 && y <= 35));
  const i = (y * size + x) * 4;
  rgba.set(arrow ? [255, 255, 255, inside ? 255 : 0] : [88, 101, 216, inside ? 255 : 0], i);
}
const header = Buffer.alloc(40); header.writeUInt32LE(40, 0); header.writeInt32LE(size, 4); header.writeInt32LE(size * 2, 8); header.writeUInt16LE(1, 12); header.writeUInt16LE(32, 14);
const bitmap = Buffer.alloc(size * size * 4);
for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) { const s = (y * size + x) * 4, d = ((size - 1 - y) * size + x) * 4; bitmap.set([rgba[s + 2], rgba[s + 1], rgba[s], rgba[s + 3]], d); }
const mask = Buffer.alloc(size * size / 8); const payload = Buffer.concat([header, bitmap, mask]);
const ico = Buffer.alloc(22); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4); ico[6] = size; ico[7] = size; ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12); ico.writeUInt32LE(payload.length, 14); ico.writeUInt32LE(22, 18);
const dir = new URL('../src-tauri/icons/', import.meta.url); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(new URL('icon.ico', dir), Buffer.concat([ico, payload]));
function crc32(buf) { let crc = 0xffffffff; for (const byte of buf) { crc ^= byte; for (let n = 0; n < 8; n++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1; } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const b = Buffer.alloc(data.length + 12); b.writeUInt32BE(data.length); b.write(type, 4); data.copy(b, 8); b.writeUInt32BE(crc32(b.subarray(4, -4)), b.length - 4); return b; }
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
const scanlines = Buffer.alloc(size * (size * 4 + 1)); for (let y = 0; y < size; y++) rgba.copy(scanlines, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
fs.writeFileSync(new URL('icon.png', dir), Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(scanlines)), chunk('IEND', Buffer.alloc(0))]));
console.log('Application icons generated.');
