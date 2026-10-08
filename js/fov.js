import { DEG } from "./orientation.js";

export const ASSUMED_HFOV = 53;
const FILM_DIAGONAL = 43.2667; // 35 mm frame, sqrt(36^2 + 24^2)

export function assumedFov(w, h) {
  const horizontal = ASSUMED_HFOV;
  const vertical = 2 * Math.atan(Math.tan(horizontal * DEG / 2) * (h / w)) / DEG;
  return { horizontal, vertical, diagonal: null, source: "assumed", focal35mm: null };
}

export function fovFromFocal(f35, w, h) {
  const diag = Math.hypot(w, h) || 1;
  const half = Math.atan(FILM_DIAGONAL / (2 * f35));
  return {
    horizontal: 2 * Math.atan((w / diag) * Math.tan(half)) / DEG,
    vertical: 2 * Math.atan((h / diag) * Math.tan(half)) / DEG,
    diagonal: 2 * half / DEG,
    source: "exif",
    focal35mm: f35,
  };
}

export async function exifFromBlob(blob) {
  let bytes;
  try {
    bytes = new Uint8Array(await blob.slice(0, 131072).arrayBuffer());
  } catch (_) {
    return null;
  }
  return parseExif(bytes);
}

function typeSize(type) {
  switch (type) {
    case 1: case 2: case 6: case 7: return 1;
    case 3: return 2;
    case 4: case 9: return 4;
    case 5: case 10: return 8;
    default: return 0;
  }
}

function parseExif(b) {
  if (b.length < 4 || b[0] !== 0xFF || b[1] !== 0xD8) return null;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xFF) { i++; continue; }
    const marker = b[i + 1];
    if (marker === 0xFF) { i++; continue; }
    if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; }
    if (marker === 0xDA || marker === 0xD9) break;
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2) break;
    if (marker === 0xE1) {
      const s = i + 4;
      if (b[s] === 0x45 && b[s + 1] === 0x78 && b[s + 2] === 0x69 && b[s + 3] === 0x66) {
        const tags = parseTiff(b, s + 6);
        if (tags) return tags;
      }
    }
    i += 2 + len;
  }
  return null;
}

function parseTiff(b, base) {
  if (base + 8 > b.length) return null;
  const little = b[base] === 0x49 && b[base + 1] === 0x49;
  const big = b[base] === 0x4D && b[base + 1] === 0x4D;
  if (!little && !big) return null;
  const u16 = (o) => (little ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
  const u32 = (o) => (little
    ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0
    : ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0);
  const s32 = (o) => { const v = u32(o); return v > 0x7FFFFFFF ? v - 0x100000000 : v; };
  if (u16(base + 2) !== 0x002A) return null;

  const values = {};
  const read = (off) => {
    if (off + 2 > b.length) return;
    const n = u16(off);
    let p = off + 2;
    for (let k = 0; k < n; k++, p += 12) {
      if (p + 12 > b.length) return;
      const tag = u16(p);
      const type = u16(p + 2);
      const count = u32(p + 4);
      const size = typeSize(type) * count;
      const vo = size > 4 ? base + u32(p + 8) : p + 8;
      if (type === 3) values[tag] = u16(vo);
      else if (type === 4) values[tag] = u32(vo);
      else if (type === 5) { const d = u32(vo + 4); values[tag] = d ? u32(vo) / d : null; }
      else if (type === 10) { const d = s32(vo + 4); values[tag] = d ? s32(vo) / d : null; }
    }
  };

  read(base + u32(base + 4));
  if (values[0x8769]) read(base + values[0x8769]);

  const focal35mm = values[0xA405] || null;
  const focalMm = values[0x920A] || null;
  const orientation = values[0x0112] || 1;
  if (!focal35mm && !focalMm) return null;
  return { focal35mm, focalMm, orientation };
}
