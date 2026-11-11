// Generates cover.png (800x534) for gladys-openrgb: plain Node, no
// dependency. A generic computer case seen from the front, its three fans lit
// as rainbow rings and an LED strip under it, on a dark gradient (no brand
// logo). PNG writer taken from gladys-modern-forms.
// Usage: node scripts/cover.mjs cover.png
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const W = 800;
const H = 534;
const px = Buffer.alloc(W * H * 3);
const set = (x, y, [r, g, b], a = 1) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  px[i] = px[i] * (1 - a) + r * a;
  px[i + 1] = px[i + 1] * (1 - a) + g * a;
  px[i + 2] = px[i + 2] * (1 - a) + b * a;
};
const hue = (h) => {
  const f = (n) => {
    const k = (n + h * 6) % 6;
    return 255 * (1 - Math.max(0, Math.min(k, 4 - k, 1)));
  };
  return [f(5), f(3), f(1)];
};
for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) {
    const t = (x / W) * 0.5 + (y / H) * 0.5;
    set(x, y, [24 + 20 * t, 22 + 10 * t, 40 + 30 * t]);
  }
}
// The case: a rounded dark box with a lighter glass panel.
const box = (x0, y0, x1, y1, color, a = 1) => {
  for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) set(x, y, color, a);
};
box(270, 50, 530, 450, [14, 14, 20]);
box(282, 62, 518, 438, [32, 32, 44]);
// Three fans, each a rainbow ring around a dark hub, with a soft glow.
for (const cy of [140, 250, 360]) {
  const cx = 400;
  for (let y = cy - 70; y <= cy + 70; y += 1) {
    for (let x = cx - 70; x <= cx + 70; x += 1) {
      const d = Math.hypot(x - cx, y - cy);
      const angle = (Math.atan2(y - cy, x - cx) / (2 * Math.PI) + 1) % 1;
      if (d >= 40 && d <= 48) set(x, y, hue(angle));
      else if (d > 48 && d < 66) set(x, y, hue(angle), 0.35 * (1 - (d - 48) / 18));
      else if (d < 40 && d > 14) set(x, y, [50, 50, 64], 0.9);
      else if (d <= 14) set(x, y, [20, 20, 28]);
    }
  }
}
// An LED strip under the case.
for (let x = 180; x < 620; x += 1) {
  const color = hue((x - 180) / 440);
  for (let y = 476; y < 484; y += 1) set(x, y, color);
  for (let y = 462; y < 498; y += 1) set(x, y, color, 0.18 * (1 - Math.abs(y - 480) / 18));
}
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;
ihdr[9] = 2;
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y += 1) {
  raw[y * (W * 3 + 1)] = 0;
  px.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(process.argv[2] ?? 'cover.png', png);
console.log('cover', png.length, 'bytes');
